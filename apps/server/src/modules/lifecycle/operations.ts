import { queueManualExternalWork } from '../../integration/manual-external-work.js';
import { ADMIN, APPROVE, READ, WRITE, Problem, type Context, type Input, type Operation, type Row } from '@smartsell/contracts';
import { appendConsent, channels, consentFor, createConsentText, purposes, refreshConsent } from './consent.js';
import { saveSegmentVersion, saveSuppression, snapshotAudience } from './audience.js';
import { localEspOperations, previewLocalEsp } from './local-esp.js';
import { conflict, dto, flag, instant, integer, invalid, oneOf, optional, strings, text, unavailable, zone } from './dto.js';

const customerRead = ['owner','admin','manager','editor','reviewer','analyst'] as const;
const planning = ['owner','admin','manager','editor','analyst'] as const;
const healthChannels = ['email','sms','whatsapp','push'] as const;
const healthCounts = ['sent','bounced','complained','unsubscribed','suppressed_total','opened','clicked','purchased'] as const;
const id = (input: Input, field: string) => text(input.params.id ?? input.body[field], field);
const rows = (ctx: Context, kind: string, key: string, value: unknown) => ctx.list(kind).filter(r => r[key] === value);
const customerView = (row: Row) => ({ id: row.id, version: row.version, created_at: row.created_at, updated_at: row.updated_at,
  status: row.status, brand_id: row.brand_id, market_id: row.market_id, primary_locale: row.primary_locale,
  lifecycle_stage: row.lifecycle_stage, purchase_summary: row.purchase_summary });
const basic = (path: string, method: Operation['method'], name: string, roles: Operation['roles'], summary: string,
  run: Operation['run'], versionKind?: string, external?: boolean): Operation => ({ path, method, name, roles, summary, run, versionKind, external });

function reproject(ctx: Context, customerId: string) {
  for (const channel of channels) for (const purpose of purposes) {
    const previous = ctx.list('consent_state').find(r => r.customer_id === customerId && r.channel === channel && r.purpose === purpose);
    const current = refreshConsent(ctx, customerId, channel, purpose);
    if ((previous?.state ?? 'unknown') !== current.state) ctx.emit('lifecycle.consent.changed', { customer_id: customerId, channel, purpose, state: current.state, record_id: current.last_record_id });
  }
}

export const operations: Operation[] = [
  ...localEspOperations(),
  basic('/customers','GET','customers_list',customerRead,'List masked customer profiles',ctx => ctx.list('customer').map(customerView)),
  basic('/customers','POST','customers_create',planning,'Create a customer profile', (ctx, {body}) => {
    dto(body, ['brand_id','market_id','primary_locale','lifecycle_stage','purchased_product_ids','last_interaction_at']);
    const customer = ctx.create('customer', { brand_id: optional(body.brand_id, 'brand_id'), market_id: optional(body.market_id, 'market_id'),
      primary_locale: optional(body.primary_locale, 'primary_locale'), purchased_product_ids: strings(body.purchased_product_ids, 'purchased_product_ids'),
      lifecycle_stage: oneOf(body.lifecycle_stage ?? 'prospect', ['prospect','first_purchase','repeat','lapsed'], 'lifecycle_stage'),
      last_interaction_at: body.last_interaction_at === undefined ? undefined : instant(body.last_interaction_at, 'last_interaction_at'), status: 'active' });
    ctx.emit('lifecycle.customer.created', { customer_id: customer.id });
    return customerView(customer);
  }),
  basic('/customers/:id','GET','customers_get',customerRead,'Get a masked customer profile and identities', (ctx, input) => {
    const customer = ctx.get('customer', id(input, 'customer_id'));
    return { ...customerView(customer), identities: rows(ctx, 'customer_identity', 'customer_id', customer.id).map(r => ({ id: r.id, kind: r.kind, verified: r.verified })),
      consents: channels.flatMap(channel => purposes.map(purpose => ({ channel, purpose, ...consentFor(ctx, customer.id, channel, purpose) }))) };
  }),
  basic('/customers/:id/identities','POST','customers_link_identity',ADMIN,'Link a pseudonymous identity with evidence', (ctx, input) => {
    const {body} = input;
    dto(body, ['kind','namespace','value_hash','verified','verification_method','evidence_ids']);
    const customer = ctx.get('customer', id(input, 'customer_id'));
    if (customer.status !== 'active') conflict('Identity requires an active customer');
    const kind = oneOf(body.kind, ['store_customer','email','phone','esp_profile','social_participant','lead'], 'kind');
    const namespace = text(body.namespace, 'namespace');
    const value_hash = text(body.value_hash, 'value_hash');
    if (!/^[a-f\d]{64}$/i.test(value_hash)) invalid('Expected a SHA-256 identity hash');
    const evidence_ids = strings(body.evidence_ids, 'evidence_ids');
    if (!evidence_ids.length) invalid('Identity evidence is required');
    const verified = flag(body.verified, 'verified');
    const verification_method = verified ? oneOf(body.verification_method, ['store_account','double_opt_in','otp','esp_verified','manual_evidence'], 'verification_method') : undefined;
    if (ctx.list('customer_identity').some(r => r.kind === kind && r.namespace === namespace && r.value_hash === value_hash.toLowerCase())) conflict('Identity already linked');
    const row = ctx.create('customer_identity', { customer_id: customer.id, kind, namespace, value_hash: value_hash.toLowerCase(), verified, verification_method, evidence_ids });
    return { id: row.id, customer_id: customer.id, kind, verified };
  }, 'customer'),
  basic('/customer-identities/:id','DELETE','customers_unlink_identity',ADMIN,'Unlink a customer identity', (ctx, input) => {
    dto(input.body, ['evidence_ids']);
    if (!strings(input.body.evidence_ids, 'evidence_ids').length) invalid('Unlink evidence is required');
    const row = ctx.get('customer_identity', id(input, 'identity_id'));
    ctx.remove('customer_identity', row.id);
    ctx.emit('lifecycle.customer.identity_unlinked', { identity_id: row.id, customer_id: row.customer_id, evidence_ids: input.body.evidence_ids });
    return { id: row.id, removed: true };
  }, 'customer_identity'),
  basic('/customers/merge','POST','customers_merge',ADMIN,'Merge customer profiles with manual evidence', (ctx, {body}) => {
    dto(body, ['from_customer_id','into_customer_id','evidence_ids']);
    const from = ctx.get('customer', text(body.from_customer_id, 'from_customer_id'));
    const into = ctx.get('customer', text(body.into_customer_id, 'into_customer_id'));
    const evidence_ids = strings(body.evidence_ids, 'evidence_ids');
    if (!evidence_ids.length || from.id === into.id || from.status !== 'active' || into.status !== 'active' || from.brand_id !== into.brand_id) invalid('Merge requires two active profiles in the same brand and evidence');
    const identities = rows(ctx, 'customer_identity', 'customer_id', from.id);
    const merge = ctx.create('customer_merge', { from_customer_id: from.id, into_customer_id: into.id, basis: 'manual_evidence',
      evidence_ids, identity_ids: identities.map(r => r.id), decided_by: ctx.actorId });
    for (const identity of identities) ctx.update('customer_identity', identity.id, { customer_id: into.id });
    ctx.update('customer', from.id, { status: 'merged', merged_into_id: into.id });
    reproject(ctx, into.id);
    ctx.emit('lifecycle.customer.merged', { from_customer_id: from.id, into_customer_id: into.id, merge_id: merge.id });
    return merge;
  }),
  basic('/customer-merges/:id/revert','POST','customers_revert_merge',ADMIN,'Restore customer profile and original identity ownership', (ctx, input) => {
    dto(input.body, []);
    const merge = ctx.get('customer_merge', id(input, 'merge_id'));
    const into = ctx.get('customer', String(merge.into_customer_id));
    const from = ctx.get('customer', String(merge.from_customer_id));
    if (merge.reverted_at || from.status !== 'merged' || into.status !== 'active') conflict('Merge cannot be reverted in its current state');
    const restoredIds = strings(merge.identity_ids, 'identity_ids');
    for (const identity of rows(ctx, 'customer_identity', 'customer_id', into.id).filter(r => restoredIds.includes(r.id))) {
      ctx.update('customer_identity', identity.id, { customer_id: from.id });
    }
    ctx.update('customer', from.id, { status: 'active', merged_into_id: null });
    reproject(ctx, from.id);
    reproject(ctx, into.id);
    ctx.emit('lifecycle.customer.split', { from_customer_id: from.id, into_customer_id: into.id, merge_id: merge.id });
    return ctx.update('customer_merge', merge.id, { reverted_at: ctx.now, reverted_by: ctx.actorId });
  }, 'customer_merge'),
  basic('/customers/:id/consents','GET','customers_get_consents',customerRead,'Read channel consent and masked ledger', (ctx, input) => {
    const customer = ctx.get('customer', id(input, 'customer_id'));
    return { states: channels.flatMap(channel => purposes.map(purpose => ({ channel, purpose, ...consentFor(ctx, customer.id, channel, purpose) }))),
      records: rows(ctx, 'consent_record', 'customer_id', customer.id).map(r => ({ id: r.id, channel: r.channel, purpose: r.purpose,
        action: r.action, source: r.source, captured_at: r.captured_at, consent_text_version_id: r.consent_text_version_id })) };
  }),
  basic('/customers/:id/consents','POST','lifecycle_record_consent',ADMIN,'Append an evidence-backed consent event', (ctx, input) => {
    dto(input.body, ['channel','purpose','action','source','source_ref','identity_id','consent_text_version_id','captured_at','evidence_ids','requires_double_opt_in','pending_until','imported_state']);
    if (input.body.source === 'lp_form') invalid('Form records are accepted from traffic');
    return appendConsent(ctx, { ...input.body, customer_id: id(input, 'customer_id') });
  }),
  basic('/consent-conflicts','GET','lifecycle_list_consent_conflicts',ADMIN,'List unresolved source consent conflicts', ctx => ctx.list('consent_state').filter(r => r.state === 'conflict')),
  basic('/consent-texts','GET','lifecycle_list_consent_texts',READ,'List consent text versions', ctx => ctx.list('consent_text_version')),
  basic('/consent-texts/:id','GET','lifecycle_get_consent_text',READ,'Read a consent text version', (ctx, input) => ctx.get('consent_text_version', id(input, 'consent_text_version_id'))),
  basic('/consent-texts','POST','lifecycle_create_consent_text',ADMIN,'Create an immutable consent text version', (ctx, {body}) => createConsentText(ctx, body)),
  basic('/lifecycle/suppressions','POST','lifecycle_record_suppression',ADMIN,'Record a source-specific channel suppression', (ctx, {body}) => saveSuppression(ctx, body)),
  basic('/segments','GET','segments_list',customerRead,'List segment metadata', ctx => ctx.list('segment')),
  basic('/segments/:id','GET','segments_get',customerRead,'Read segment metadata', (ctx, input) => ctx.get('segment', id(input, 'segment_id'))),
  basic('/segments','POST','segments_create',planning,'Create a segment and its initial definition', (ctx, {body}) => {
    dto(body, ['name','brand_id','mode','esp_segment_ref','definition','required_consent']);
    const mode = oneOf(body.mode ?? 'local_definition', ['esp_native','local_definition'], 'mode');
    const esp_segment_ref = optional(body.esp_segment_ref, 'esp_segment_ref');
    if ((mode === 'esp_native') !== !!esp_segment_ref) invalid('ESP segment reference must match segment mode');
    const segment = ctx.create('segment', { name: text(body.name, 'name'), brand_id: optional(body.brand_id, 'brand_id'), mode, esp_segment_ref });
    saveSegmentVersion(ctx, segment.id, body);
    return ctx.get('segment', segment.id);
  }),
  basic('/segments/:id/versions','POST','segments_create_version',planning,'Append an immutable segment definition', (ctx, input) => {
    dto(input.body, ['definition','required_consent']);
    const version = saveSegmentVersion(ctx, id(input, 'segment_id'), input.body);
    return { id: version.id, segment_id: version.segment_id, version_no: version.version_no, content_hash: version.content_hash };
  }, 'segment'),
  basic('/segments/:id/preview','POST','segments_preview',customerRead,'Preview audience with aggregate exclusion counts', (ctx, input) => {
    dto(input.body, ['segment_version_id']);
    const selected = optional(input.body.segment_version_id, 'segment_version_id');
    const segmentId = input.params.id;
    const versionId = selected ?? text(ctx.get('segment', text(segmentId, 'segment_id')).current_version_id, 'current_version_id');
    if (segmentId && ctx.get('segment_version', versionId).segment_id !== segmentId) invalid('Segment version belongs to another segment');
    const providerMembers = previewLocalEsp(ctx, ctx.get('segment_version', versionId));
    return providerMembers ? providerMembers.then(members => snapshotAudience(ctx, versionId, 'preview', undefined, members))
      : snapshotAudience(ctx, versionId, 'preview');
  }),
  basic('/segments/:id/snapshots','GET','segments_list_snapshots',customerRead,'Compare saved audience previews and reported ESP send counts', (ctx, input) => {
    const segment = ctx.get('segment', id(input, 'segment_id'));
    const versions = new Set(rows(ctx, 'segment_version', 'segment_id', segment.id).map(version => version.id));
    return ctx.list('segment_snapshot').filter(snapshot => versions.has(String(snapshot.segment_version_id)));
  }),
  basic('/esp-accounts','GET','lifecycle_list_esp_accounts',customerRead,'List ESP account references', ctx => ctx.list('esp_account')),
  basic('/esp-accounts','POST','lifecycle_create_esp_account',ADMIN,'Register an ESP reference for a channel', (ctx, {body}) => {
    dto(body, ['provider','external_account_id','connection_id','brand_id','channel','is_sending_system_of_record']);
    const provider = text(body.provider, 'provider');
    const external_account_id = text(body.external_account_id, 'external_account_id');
    const brand_id = text(body.brand_id, 'brand_id');
    const channel = oneOf(body.channel, ['email','sms','whatsapp','push'], 'channel');
    const connection_id = optional(body.connection_id, 'connection_id');
    if (connection_id) ctx.get('connection', connection_id);
    const is_sending_system_of_record = flag(body.is_sending_system_of_record, 'is_sending_system_of_record');
    if (ctx.list('esp_account').some(r => r.provider === provider && r.external_account_id === external_account_id && r.channel === channel ||
      is_sending_system_of_record && r.brand_id === brand_id && r.channel === channel && r.is_sending_system_of_record)) conflict('Conflicting ESP account or sending system');
    return ctx.create('esp_account', { provider, external_account_id, connection_id, brand_id, channel, is_sending_system_of_record });
  }),
  basic('/esp-campaigns','GET','lifecycle_list_campaigns',customerRead,'List lifecycle campaign references', ctx => ctx.list('esp_campaign_ref')),
  basic('/esp-campaigns','POST','lifecycle_create_campaign_draft',WRITE,'Create a local lifecycle campaign draft', (ctx, {body}) => {
    dto(body, ['esp_account_id','campaign_id','channel','segment_version_id','template_ref','product_refs','planned_send_at','tz']);
    const account = ctx.get('esp_account', text(body.esp_account_id, 'esp_account_id'));
    const channel = oneOf(body.channel ?? account.channel, channels, 'channel');
    const version = ctx.get('segment_version', text(body.segment_version_id, 'segment_version_id'));
    const segment = ctx.get('segment', String(version.segment_id));
    if (channel !== account.channel || segment.brand_id !== account.brand_id || (version.required_consent as {channel?: string})?.channel !== channel ||
        (version.required_consent as {purpose?: string})?.purpose !== 'marketing') invalid('Campaign requires brand and channel matched marketing audience');
    return ctx.create('esp_campaign_ref', { esp_account_id: account.id, campaign_id: optional(body.campaign_id, 'campaign_id'), channel,
      segment_version_id: version.id, template_ref: text(body.template_ref, 'template_ref'), product_refs: strings(body.product_refs, 'product_refs'),
      planned_send_at: body.planned_send_at === undefined ? undefined : instant(body.planned_send_at, 'planned_send_at'), tz: zone(body.tz ?? 'UTC'), status: 'draft' });
  }),
  basic('/esp-campaigns/:id','GET','lifecycle_get_campaign',customerRead,'Get lifecycle campaign reference', (ctx, input) => ctx.get('esp_campaign_ref', id(input, 'esp_campaign_id'))),
  basic('/esp-campaigns/:id/send-observation','POST','lifecycle_import_campaign_send',ADMIN,'Import actual audience size from an ESP send report', (ctx, input) => {
    const {body} = input;
    dto(body, ['source_ref','external_campaign_id','sent_at','esp_count']);
    const campaign = ctx.get('esp_campaign_ref', id(input, 'esp_campaign_id'));
    const source_ref = text(body.source_ref, 'source_ref');
    const external_campaign_id = text(body.external_campaign_id, 'external_campaign_id');
    const taken_at = instant(body.sent_at, 'sent_at');
    const esp_count = integer(body.esp_count, 'esp_count');
    if (Date.parse(taken_at) > Date.parse(ctx.now)) invalid('Send observation cannot be in the future');
    if (campaign.send_snapshot_id) {
      const prior = ctx.get('segment_snapshot', String(campaign.send_snapshot_id));
      if (prior.source_ref === source_ref && prior.external_campaign_id === external_campaign_id &&
          prior.taken_at === taken_at && prior.esp_count === esp_count) return prior;
      conflict('Campaign already has a send observation');
    }
    if (ctx.list('segment_snapshot').some(snapshot => snapshot.purpose === 'send_execution' &&
        snapshot.esp_account_id === campaign.esp_account_id && snapshot.external_campaign_id === external_campaign_id)) {
      conflict('ESP campaign is already linked to a send observation');
    }
    if (campaign.external_campaign_id && campaign.external_campaign_id !== external_campaign_id) invalid('ESP campaign reference does not match');
    const snapshot = ctx.create('segment_snapshot', { purpose: 'send_execution', segment_version_id: campaign.segment_version_id,
      esp_campaign_ref_id: campaign.id, esp_account_id: campaign.esp_account_id, external_campaign_id, taken_at, esp_count,
      source: 'esp_report_import', source_ref, audience_coverage: 'esp_report_count_only' });
    ctx.update('esp_campaign_ref', campaign.id, { external_campaign_id, send_snapshot_id: snapshot.id });
    ctx.emit('lifecycle.esp_campaign.send_observed', { esp_campaign_ref_id: campaign.id, segment_snapshot_id: snapshot.id });
    return snapshot;
  }),
  basic('/esp-campaigns/:id/export','POST','lifecycle_export_campaign',WRITE,'Export local campaign configuration and fresh audience estimate', (ctx, input) => {
    dto(input.body, []);
    const campaign = ctx.get('esp_campaign_ref', id(input, 'esp_campaign_id'));
    if (campaign.status !== 'draft') conflict('Campaign is not an exportable draft');
    const audience = snapshotAudience(ctx, String(campaign.segment_version_id), 'schedule_estimate');
    return { mode: 'manual', campaign, audience, requires_esp_verification: true };
  }),
  ...(['test-send','schedule'] as const).map(action => basic(`/esp-campaigns/:id/${action}`, 'POST', `lifecycle_${action.replace('-', '_')}_campaign`, APPROVE,
    'Queue an approved ESP action and require provider verification', (ctx, input) => {
      dto(input.body, []);
      const campaign = ctx.get('esp_campaign_ref', id(input, 'esp_campaign_id'));
      if (campaign.status !== 'draft') conflict('ESP action requires a current draft');
      const account = ctx.get('esp_account', String(campaign.esp_account_id));
      const audience = snapshotAudience(ctx, String(campaign.segment_version_id), 'schedule_estimate');
      if (audience.eligible_count === 0) throw new Problem(409, 'NO_ELIGIBLE_AUDIENCE', 'No eligible marketing audience', {
        excluded: audience.excluded, audience_coverage: audience.audience_coverage,
      });
      const task = queueManualExternalWork(ctx, { key: `esp:${action}:${campaign.id}:${campaign.version}`,
        title: action === 'test-send' ? 'Verify consent and run ESP test send' : 'Verify audience and schedule delivery in the ESP',
        resourceType: 'esp_campaign_ref', resourceId: campaign.id, brandId: account.brand_id,
        event: 'lifecycle.esp_campaign.manual_required', references: { esp_campaign_ref_id: campaign.id, action, version: String(campaign.version) } });
      return { status: 'manual_required', work_item_id: task.id };
    }, 'esp_campaign_ref')),
  basic('/esp-campaigns/:id/cancel','POST','lifecycle_cancel_campaign',APPROVE,'Cancel a local draft campaign', (ctx, input) => {
    dto(input.body, []);
    const campaign = ctx.get('esp_campaign_ref', id(input, 'esp_campaign_id'));
    if (campaign.status !== 'draft') unavailable('ESP execution adapter is unavailable');
    if (ctx.list('esp_attempt').some(row => row.esp_campaign_ref_id === campaign.id && row.action === 'schedule' && row.status !== 'failed')) {
      conflict('Read back the pending local ESP schedule before cancelling');
    }
    for (const task of ctx.list('work_item').filter(row => row.source_type === 'manual_external' && row.resource_type === 'esp_campaign_ref' && row.resource_id === campaign.id && row.status === 'open')) {
      ctx.update('work_item', task.id, { status: 'cancelled' });
    }
    return ctx.update('esp_campaign_ref', campaign.id, { status: 'cancelled' });
  }, 'esp_campaign_ref'),
  basic('/esp-flows','GET','lifecycle_list_flows',customerRead,'List lifecycle flows and cart-exit coverage', ctx => ctx.list('esp_flow_ref').map(r => ({ ...r,
    missing_purchase_exit: r.kind === 'abandoned_cart' && !(r.steps_snapshot as {exit_on_purchase?: boolean})?.exit_on_purchase }))),
  basic('/esp-flows','POST','lifecycle_create_flow_draft',WRITE,'Save a local flow draft', (ctx, {body}) => {
    dto(body, ['esp_account_id','kind','trigger','wait_minutes','exit_on_purchase']);
    const account = ctx.get('esp_account', text(body.esp_account_id, 'esp_account_id'));
    return ctx.create('esp_flow_ref', { esp_account_id: account.id,
      kind: oneOf(body.kind, ['welcome','abandoned_cart','post_purchase','winback','other'], 'kind'),
      trigger_snapshot: { event: text(body.trigger, 'trigger') }, steps_snapshot: { wait_minutes: integer(body.wait_minutes ?? 0, 'wait_minutes'),
        exit_on_purchase: flag(body.exit_on_purchase, 'exit_on_purchase') }, status: 'draft' });
  }),
  basic('/esp-flows/:id/status','POST','lifecycle_change_flow_status',APPROVE,'Change local review mode or require ESP capability', (ctx, input) => {
    dto(input.body, ['status']);
    const status = oneOf(input.body.status, ['manual','live','paused','archived'], 'status');
    const flow = ctx.get('esp_flow_ref', id(input, 'flow_id'));
    if (status !== 'manual' || !['draft','manual'].includes(String(flow.status))) unavailable('ESP execution adapter is unavailable');
    return ctx.update('esp_flow_ref', flow.id, { review_mode: 'manual' });
  }, 'esp_flow_ref'),
  basic('/lifecycle/health','GET','lifecycle_get_health',customerRead,'Read ESP-reported delivery health and coverage', (ctx, {query}) => {
    const from = query.from ? instant(query.from, 'from') : undefined;
    const until = query.until ? instant(query.until, 'until') : undefined;
    const accounts = ctx.list('esp_account').filter(r => !query.brand_id || r.brand_id === query.brand_id);
    const byId = new Map(accounts.map(account => [account.id, account]));
    const snapshots = ctx.list('deliverability_snapshot').filter(r => byId.has(String(r.esp_account_id)) &&
      (!from || Date.parse(String(r.observed_at)) >= Date.parse(from)) && (!until || Date.parse(String(r.observed_at)) <= Date.parse(until)));
    const reported = new Set(snapshots.map(snapshot => byId.get(String(snapshot.esp_account_id))?.channel));
    const registered = new Set(accounts.map(account => account.channel));
    const channel_coverage = healthChannels.map(channel => ({ channel, coverage: reported.has(channel) ? 'imported_esp_reports_only'
      : registered.has(channel) ? 'no_report_in_period' : 'not_connected' }));
    return { coverage: snapshots.length ? 'imported_esp_reports_only' : 'unavailable', channel_coverage, snapshots };
  }),
  basic('/lifecycle/health','POST','lifecycle_import_health',ADMIN,'Import observed ESP delivery health counts', (ctx, {body}) => {
    dto(body, ['esp_account_id','period_from','period_until','observed_at','source_ref', ...healthCounts]);
    const account = ctx.get('esp_account', text(body.esp_account_id, 'esp_account_id'));
    const period_from = instant(body.period_from, 'period_from');
    const period_until = instant(body.period_until, 'period_until');
    const observed_at = instant(body.observed_at, 'observed_at');
    if (period_from >= period_until || period_until > observed_at || Date.parse(observed_at) > Date.parse(ctx.now)) invalid('Invalid ESP observation interval');
    const source_ref = text(body.source_ref, 'source_ref');
    if (rows(ctx, 'deliverability_snapshot', 'esp_account_id', account.id).some(r => r.source_ref === source_ref)) conflict('Report has already been imported');
    const counts = Object.fromEntries(healthCounts.filter(k => body[k] !== undefined).map(k => [k, integer(body[k], k)]));
    if (!Object.keys(counts).length) invalid('At least one reported count is required');
    return ctx.create('deliverability_snapshot', { esp_account_id: account.id, period_from, period_until, observed_at, source: 'esp_report_import', source_ref, ...counts });
  }),
  basic('/lifecycle/frequency-rules','POST','lifecycle_create_frequency_rule',ADMIN,'Add an observed-send frequency cap', (ctx, {body}) => {
    dto(body, ['channel','max_per_window','window_hours','scope','brand_id','applies_to']);
    const scope = oneOf(body.scope, ['brand','workspace'], 'scope');
    const brand_id = optional(body.brand_id, 'brand_id');
    if ((scope === 'brand') !== !!brand_id) invalid('Brand must match frequency rule scope');
    return ctx.create('frequency_rule', { channel: oneOf(body.channel, ['email','sms','whatsapp','push'], 'channel'), brand_id, scope,
      max_per_window: integer(body.max_per_window, 'max_per_window', 1), window_hours: integer(body.window_hours, 'window_hours', 1),
      applies_to: oneOf(body.applies_to ?? 'both', ['campaign','flow','both'], 'applies_to') });
  }),
  basic('/lifecycle/send-observations','POST','lifecycle_import_send_observation',ADMIN,'Record an observed ESP send for frequency accounting', (ctx, {body}) => {
    dto(body, ['esp_account_id','customer_id','external_send_id','sent_at']);
    const account = ctx.get('esp_account', text(body.esp_account_id, 'esp_account_id'));
    const customer = ctx.get('customer', text(body.customer_id, 'customer_id'));
    const external_send_id = text(body.external_send_id, 'external_send_id');
    const sent_at = instant(body.sent_at, 'sent_at');
    if (customer.brand_id !== account.brand_id || Date.parse(sent_at) > Date.parse(ctx.now)) invalid('Invalid ESP send observation');
    const previous = rows(ctx, 'contact_send_observation', 'esp_account_id', account.id).find(r => r.external_send_id === external_send_id && r.customer_id === customer.id);
    if (previous && previous.sent_at !== sent_at) conflict('ESP observation conflicts with the recorded send');
    return previous ?? ctx.create('contact_send_observation', { esp_account_id: account.id, channel: account.channel, brand_id: account.brand_id, customer_id: customer.id, external_send_id, sent_at });
  }),
  basic('/customers/:id/erasure-requests','POST','lifecycle_request_customer_data',ADMIN,'Open an export or erasure request', (ctx, input) => {
    dto(input.body, ['kind']);
    const customer = ctx.get('customer', id(input, 'customer_id'));
    const kind = oneOf(input.body.kind, ['export','erase'], 'kind');
    if (rows(ctx, 'erasure_request', 'customer_id', customer.id).some(r => r.kind === kind && r.status === 'requested')) throw new Problem(409, 'STATE_CONFLICT', 'Request already open');
    return ctx.create('erasure_request', { customer_id: customer.id, kind, status: 'requested', requested_by: ctx.actorId });
  }),
];
