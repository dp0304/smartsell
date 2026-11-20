-- Keep the original maintenance entry point and its invoker privileges.
-- DEFAULT has no direct policies under migration 101.
create or replace function core.ensure_domain_partitions(anchor date default (now() at time zone 'UTC')::date)
returns void language plpgsql security invoker
set search_path = pg_catalog, pg_temp
set timezone = 'UTC'
set datestyle = 'ISO, YMD'
set row_security = on as $$
declare
  parent record;
  parent_name text;
  parent_oid oid;
  default_name text;
  default_oid oid;
  drain_policy_created boolean;
  child_name text;
  child_oid oid;
  expected_bound text;
  period_start date;
  step interval;
  starts_at timestamptz;
  ends_at timestamptz;
begin
  if anchor is null or not isfinite(anchor) then
    raise invalid_parameter_value using message = 'partition anchor must be a finite date';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('ss.domain.partitions', 0));
  for parent in select * from (values
    ('core', 'audit_event', 'occurred_at', 'month'),
    ('ingest', 'raw_record', 'fetched_at', 'month'),
    ('ingest', 'webhook_delivery', 'received_at', 'month'),
    ('intel', 'observation', 'observed_at', 'quarter'),
    ('traffic', 'click_event', 'occurred_at', 'month'),
    ('analytics', 'metric_observation', 'observed_at', 'month'),
    ('agent', 'tool_call', 'occurred_at', 'month'),
    ('ops', 'usage_event', 'occurred_at', 'month')
  ) as p(schema_name, table_name, time_column, cadence) loop
    parent_name := format('%I.%I', parent.schema_name, parent.table_name);
    default_name := format('%I.%I', parent.schema_name, parent.table_name || '_default');
    -- Serialize with partition DDL and parent-routed writes. Lock DEFAULT too
    -- before draining it, so direct owner writes cannot refill the range.
    execute format('lock table only %s in access exclusive mode', parent_name);
    parent_oid := parent_name::regclass;
    default_oid := to_regclass(default_name);
    if exists (
      select from pg_partitioned_table
      where partrelid = parent_oid and partdefid <> 0 and partdefid is distinct from default_oid
    ) or (default_oid is not null and not exists (
      select from pg_partitioned_table p join pg_class c on c.oid = p.partdefid
      where p.partrelid = parent_oid and c.oid = default_oid and c.relkind = 'r'
    )) then
      raise duplicate_table using message = format('partition name collision or unexpected DEFAULT for %s', default_name);
    end if;

    drain_policy_created := false;
    step := case parent.cadence when 'month' then interval '1 month' else interval '3 months' end;
    for n in -1..3 loop
      period_start := date_trunc(parent.cadence, anchor::timestamp) + n * step;
      starts_at := period_start::timestamp at time zone 'UTC';
      ends_at := (period_start + step) at time zone 'UTC';
      child_name := format('%I.%I', parent.schema_name, parent.table_name || '_p' || to_char(period_start, 'YYYYMM'));
      child_oid := to_regclass(child_name);
      expected_bound := format('FOR VALUES FROM (%L) TO (%L)', starts_at, ends_at);
      if child_oid is not null then
        -- The fixed TimeZone and DateStyle make the catalog's timestamptz
        -- deparse comparable to the bounds above on PostgreSQL 17.
        if not exists (
          select from pg_class c join pg_inherits i on i.inhrelid = c.oid
          where c.oid = child_oid and c.relkind = 'r' and c.relispartition
            and i.inhparent = parent_oid and not i.inhdetachpending
            and pg_get_expr(c.relpartbound, c.oid) = expected_bound
        ) then
          raise duplicate_table using message = format('partition name collision for %s (expected %s of %s)',
            child_name, expected_bound, parent_name);
        end if;
        continue;
      end if;

      if default_oid is null then
        execute format('create table %s partition of %s %s', child_name, parent_name, expected_bound);
      else
        if not drain_policy_created then
          execute format('lock table only %s in access exclusive mode', default_name);
          -- The partition stays under FORCE RLS. This policy is usable only
          -- by the maintenance owner and is removed before releasing the lock.
          execute format('create policy partition_drain on %s to %I using (true)', default_name, current_user);
          drain_policy_created := true;
        end if;
        -- Fill a standalone table before ATTACH builds the inherited indexes
        -- and enforces the parent constraints. The delete, insert and attach
        -- all roll back on any failure, including DEFAULT validation.
        execute format('create table %s (like %s including defaults including constraints)', child_name, parent_name);
        execute format(
          'with moved as (delete from only %s where %I >= $1 and %I < $2 returning *) insert into %s select * from moved',
          default_name, parent.time_column, parent.time_column, child_name
        ) using starts_at, ends_at;
        execute format('alter table %s attach partition %s %s', parent_name, child_name, expected_bound);
      end if;

      execute format('alter table %s enable row level security, force row level security', child_name);
      execute format('revoke all on table %s from public, smartsell_request', child_name);
    end loop;

    if drain_policy_created then
      execute format('drop policy partition_drain on %s', default_name);
    end if;
    if default_oid is null then
      execute format('create table %s partition of %s default', default_name, parent_name);
      execute format('alter table %s enable row level security, force row level security', default_name);
      execute format('revoke all on table %s from public, smartsell_request', default_name);
    end if;
  end loop;
end;
$$;

revoke all on function core.ensure_domain_partitions(date) from public, smartsell_request;
select core.ensure_domain_partitions();
