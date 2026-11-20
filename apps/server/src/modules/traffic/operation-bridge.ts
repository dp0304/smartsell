import { createHmac } from 'node:crypto';
import { Problem, type Context, type Data } from '@smartsell/contracts';
import { acceptLead, activeForm } from './forms.js';
import { publicLink, resolveLink } from './links.js';
import { publicBio, publicPage } from './pages.js';
import { host, invalid, missing, object, productView, slug, text } from './operation-policy.js';

export type PublicTrafficRequest =
  | { type: 'redirect'; hostname: string; code: string; market?: string; userAgent?: string; purpose?: string; navigation?: boolean; visitor?: PublicVisitor }
  | { type: 'bio'; hostname: string; handle: string; market?: string }
  | { type: 'page'; slug: string; visitor?: PublicVisitor }
  | { type: 'submit'; formId: string; slug: string; versionId: string; body: unknown; visitor?: PublicVisitor }
  | { type: 'touchpoint'; slug: string; versionId: string; eventId: string; visitor?: PublicVisitor };

/** Session and optional short-link reference come from verified first-party attribution state. */
export type PublicVisitor = { consent: true; sessionRef: string; shortLinkId?: string };
export type PublicTrafficSecrets = { piiKey: Uint8Array; trackingKey?: Uint8Array };

function visitor(ctx: Context, value: PublicVisitor | undefined, key: Uint8Array | undefined) {
  if (!value?.consent || !key) return undefined;
  const ref = text(value.sessionRef, 'session ref');
  const digest = createHmac('sha256', key).update(JSON.stringify([ctx.workspaceId, ref])).digest();
  const shortLinkId = ctx.list('short_link').find(link => link.id === value.shortLinkId)?.id;
  return { ref: digest.toString('base64url'), bucket: Math.floor(digest.readUInt32BE() / 0x1_0000_0000 * 100), shortLinkId };
}
function classification(userAgent = '', purpose = '', navigation = false) {
  if (/facebookexternalhit|facebot|twitterbot|slackbot|linkedinbot|discordbot|whatsapp/i.test(userAgent)) return 'bot_preview';
  if (/bot|crawler|spider/i.test(userAgent)) return 'crawler';
  if (/prefetch|prerender/i.test(purpose)) return 'prefetch';
  return navigation && /Mozilla\/5\.0/i.test(userAgent) ? 'human_likely' : 'unknown';
}

/** Public adapters must resolve the host to one workspace before opening the transaction. */
export function trafficPublicBridge(ctx: Context, request: PublicTrafficRequest, secrets: PublicTrafficSecrets) {
  switch (request.type) {
    case 'redirect': {
      const link = publicLink(ctx, host(request.hostname), slug(request.code));
      const result = resolveLink(ctx, link, request.market === 'default' || !request.market ? undefined : slug(request.market));
      if (!result.location) throw new Problem(410, 'LINK_UNAVAILABLE', 'Link is unavailable');
      if (result.revision && result.choices.length && !request.market) return { type: 'market_choice' as const, choices: result.choices };
      if (result.revision) ctx.create('click_event', {
        short_link_id: link.id, revision_id: result.revision.id, occurred_at: ctx.now,
        classification: classification(request.userAgent, request.purpose, request.navigation), route_market_id: result.market,
      });
      return { type: 'redirect' as const, location: result.location, ...(request.visitor?.consent && result.revision ? { shortLinkId: link.id } : {}) };
    }
    case 'bio': return { type: 'bio' as const, ...publicBio(ctx, host(request.hostname), slug(request.handle), request.market ? slug(request.market) : undefined) };
    case 'page': {
      const page = publicPage(ctx, slug(request.slug), visitor(ctx, request.visitor, secrets.trackingKey)?.bucket);
      return { type: 'page' as const, slug: request.slug, versionId: page.row.id, locale: String(page.row.locale), title: String(page.row.title),
        blocks: page.blocks.map(block => {
          switch (block.type) {
            case 'product': return { type: block.type, title: block.title, label: block.label, ...productView(ctx, String(block.product_variant_id), page.page.market_id) };
            case 'cta': return { type: block.type, title: block.title, label: block.label, url: block.url };
            case 'form': {
              try {
                const { form, row, fields, choices } = activeForm(ctx, block.form_id);
                return { type: block.type, title: block.title || String(row.title), formId: form.id, formVersionId: row.id,
                  fields, choices: choices.map(({ key, label }) => ({ key, label })) };
              } catch (error) {
                if (!(error instanceof Problem)) throw error;
                return { type: 'unavailable' as const, title: block.title };
              }
            }
            default: return block;
          }
        }) };
    }
    case 'submit': {
      const session = visitor(ctx, request.visitor, secrets.trackingKey);
      const page = publicPage(ctx, slug(request.slug), session?.bucket);
      if (page.row.id !== request.versionId || !page.blocks.some(row => row.type === 'form' && row.form_id === request.formId)) return missing();
      const form = activeForm(ctx, text(request.formId, 'formId'));
      return { type: 'submit' as const, ...acceptLead(ctx, form, object(request.body), secrets.piiKey, page.row,
        session ? { sessionRef: session.ref, shortLinkId: session.shortLinkId } : undefined) };
    }
    case 'touchpoint': {
      const session = visitor(ctx, request.visitor, secrets.trackingKey);
      if (!session) return { type: 'touchpoint' as const, recorded: false };
      const page = publicPage(ctx, slug(request.slug), session.bucket);
      if (page.row.id !== request.versionId) return missing();
      const id = text(request.eventId, 'eventId', 80);
      if (!/^[a-z0-9_-]+$/i.test(id)) invalid('Invalid touchpoint event ID');
      if (!ctx.list('touchpoint_event').some(row => row.session_ref === session.ref && row.event_id === id)) {
        const data: Data = { event_type: 'page_view', event_id: id, landing_page_version_id: page.row.id,
          session_ref: session.ref, short_link_id: session.shortLinkId ?? null, consent_state: 'opted_in', occurred_at: ctx.now, ...page.experiment };
        ctx.create('touchpoint_event', data);
      }
      return { type: 'touchpoint' as const, recorded: true };
    }
  }
}
export type PublicTrafficResponse = ReturnType<typeof trafficPublicBridge>;
