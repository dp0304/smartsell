import { checkUsage } from '../asset/rights.js';
import { ADMIN, READ, type Context, type Operation } from '@smartsell/contracts';
import { array, conflict, expires, forbidden, identifier, invalid, missing, record, resource, row, text, type ResourceRef, type TeamHost } from './model.js';

export function ambassadorOperations(host: TeamHost): Operation[] {
  const materialFor = host.ambassador?.material ?? ((ctx: Context, ref: ResourceRef) => {
    if (ref.resource_type !== 'asset') return undefined;
    const asset = ctx.list('asset').find(row => row.id === ref.resource_id);
    const version = ctx.list('asset_version').find(row => row.id === ref.revision_id && row.asset_id === ref.resource_id);
    if (!asset || !version) return undefined;
    const [rights] = checkUsage(ctx, { asset_ids: [asset.id], asset_version_id: version.id, usage: 'organic_social' });
    if (!rights?.allowed || !('valid_until' in rights)) return undefined;
    return { title: String(asset.title ?? asset.name ?? asset.id), text: String(version.caption ?? asset.title ?? asset.name ?? asset.id),
      rights_until: typeof rights.valid_until === 'string' ? rights.valid_until : '9999-12-31T00:00:00Z' };
  });
  const participants = READ.filter(role => role !== 'agent');
  const activeMaterials = (ctx: Context, kit: ReturnType<typeof row>) => {
    const now = Date.parse(ctx.now);
    if (!(Date.parse(String(kit.expires_at)) > now)) return [];
    const refs = Array.isArray(kit.materials) ? kit.materials.map(value => resource(record(value, 'material'))) : [resource(kit)];
    return refs.flatMap(ref => {
      const material = materialFor(ctx, ref);
      return material && Date.parse(material.rights_until) > now ? [{ ref, material }] : [];
    });
  };
  const ready = (ctx: Context, id: string) => {
    const kit = row(ctx, 'ambassador_kit', id);
    const materials = activeMaterials(ctx, kit);
    if (!materials.length) throw missing();
    return { materials, multi: Array.isArray(kit.materials) };
  };
  const enrollment = (ctx: Context, kitId: string) => ctx.list('ambassador_enrollment')
    .find(item => item.kit_id === kitId && item.user_id === ctx.actorId);
  return [
    { name: 'team_ambassador_kits_list', path: '/ambassador-kits', method: 'GET', roles: participants,
      summary: 'List active, rights-cleared ambassador kits', run(ctx) {
        return ctx.list('ambassador_kit').flatMap(kit => {
          const materials = activeMaterials(ctx, kit);
          if (!materials.length) return [];
          return [{ id: kit.id, label: kit.label, expires_at: kit.expires_at,
            ...(Array.isArray(kit.materials) && { material_count: materials.length }),
            enrolled: enrollment(ctx, kit.id)?.status === 'active' }];
        });
      } },
    { name: 'team_ambassador_kit_create', path: '/ambassador-kits', method: 'POST', roles: ADMIN,
      summary: 'Create a rights-bound kit for one or more exact asset revisions', run(ctx, { body }) {
        const legacy = body.materials === undefined;
        const refs = legacy ? [resource(body)] : array(body.materials, 'materials', value => resource(record(value, 'material')));
        const expiry = expires(ctx, body.expires_at, 90);
        if (!refs.length || new Set(refs.map(ref => ref.revision_id)).size !== refs.length) throw invalid('materials');
        for (const ref of refs) {
          const material = materialFor(ctx, ref);
          const rightsEnd = Date.parse(material?.rights_until ?? '');
          // Legacy single-revision kits retain their original lifetime rule.
          if (legacy ? !(rightsEnd >= Date.parse(expiry)) : !(rightsEnd > Date.parse(ctx.now))) {
            throw invalid(legacy ? 'expires_at' : 'materials');
          }
        }
        const kit = ctx.create('ambassador_kit', { ...(legacy ? refs[0] : { materials: refs }), expires_at: expiry, label: text(body.label, 'label', 100) });
        return { id: kit.id, label: kit.label, expires_at: kit.expires_at };
      } },
    { name: 'team_ambassador_enroll', path: '/ambassador-kits/:id/enroll', method: 'POST', roles: participants,
      summary: 'Opt in to a current ambassador kit', run(ctx, { params }) {
        const id = identifier(params.id, 'id');
        ready(ctx, id);
        const current = enrollment(ctx, id);
        if (current?.status === 'active') return { enrolled: true };
        if (current) ctx.update('ambassador_enrollment', current.id, { status: 'active', enrolled_at: ctx.now, last_claimed_at: null, claimed_revision_ids: [] });
        else ctx.create('ambassador_enrollment', { kit_id: id, user_id: ctx.actorId, status: 'active', enrolled_at: ctx.now });
        return { enrolled: true };
      } },
    { name: 'team_ambassador_leave', path: '/ambassador-kits/:id/leave', method: 'POST', roles: participants,
      summary: 'Opt out, including when the kit has expired', run(ctx, { params }) {
        const current = enrollment(ctx, identifier(params.id, 'id'));
        if (!current) throw missing();
        if (current.status === 'active') ctx.update('ambassador_enrollment', current.id, { status: 'withdrawn', withdrawn_at: ctx.now });
        return { enrolled: false };
      } },
    { name: 'team_ambassador_claim', path: '/ambassador-kits/:id/claim', method: 'POST', roles: participants,
      summary: 'Claim rights-cleared material without counting a share', run(ctx, { params }) {
        const id = identifier(params.id, 'id');
        const { materials, multi } = ready(ctx, id);
        const current = enrollment(ctx, id);
        if (current?.status !== 'active') throw forbidden();
        const copies = materials.map(({ ref, material }) => ({ ...ref, title: text(material.title, 'title', 500), text: text(material.text, 'text', 20_000) }));
        ctx.update('ambassador_enrollment', current.id, { last_claimed_at: ctx.now,
          ...(multi && { claimed_revision_ids: copies.map(copy => copy.revision_id) }) });
        return multi ? { materials: copies } : { title: copies[0]!.title, text: copies[0]!.text };
      } },
    { name: 'team_ambassador_record_share', path: '/ambassador-kits/:id/shares', method: 'POST', roles: participants,
      summary: 'Record a reported share and label host-verified results', run(ctx, { body, params }) {
        const id = identifier(params.id, 'id');
        const { materials, multi } = ready(ctx, id);
        const current = enrollment(ctx, id);
        if (current?.status !== 'active' || !current.last_claimed_at || String(current.last_claimed_at) < String(current.enrolled_at)) throw forbidden();
        let selected: (typeof materials)[number] | undefined = materials[0];
        if (multi) {
          const resourceId = identifier(body.resource_id, 'resource_id');
          const revisionId = identifier(body.revision_id, 'revision_id');
          selected = materials.find(({ ref }) => ref.resource_id === resourceId && ref.revision_id === revisionId);
        }
        if (!selected) throw missing();
        if (multi && !(Array.isArray(current.claimed_revision_ids) && current.claimed_revision_ids.includes(selected.ref.revision_id))) throw forbidden();
        let url: URL;
        try { url = new URL(text(body.url, 'url', 2048)); } catch { throw invalid('url'); }
        if (url.protocol !== 'https:' || url.username || url.password) throw invalid('url');
        if (ctx.list('ambassador_share').some(item => item.enrollment_id === current.id && item.url === url.href)) throw conflict('Share already recorded');
        const verified = host.ambassador?.verify?.(ctx, selected.ref, url.href) === true;
        const share = ctx.create('ambassador_share', { enrollment_id: current.id, ...selected.ref, url: url.href, status: verified ? 'verified' : 'reported' });
        return { id: share.id, status: share.status };
      } },
  ];
}