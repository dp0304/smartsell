import type { Context, Row } from '@smartsell/contracts';
import { factDate, inPeriod, optionalString, visibleAt } from './validation.ts';

export const stages = ['page_view', 'product_view', 'add_to_cart', 'form_submit', 'checkout_start'] as const;
export function consentedTouchpoints(ctx: Context, cutoff: string): Row[] {
  const unique = new Map<string, Row>();
  const ambiguous = new Set<string>();
  for (const event of ctx.list('touchpoint_event')) {
    const key = optionalString(event.event_id);
    const occurred = factDate(event.occurred_at);
    if (!key || !occurred || occurred > cutoff || !visibleAt(event, cutoff)) continue;
    const identityKey = JSON.stringify([event.session_ref ?? null, key]);
    const prior = unique.get(identityKey);
    const identity = (row: Row) => JSON.stringify([row.event_type, row.short_link_id, row.session_ref, row.consent_state, factDate(row.occurred_at)]);
    if (prior && identity(prior) !== identity(event)) ambiguous.add(identityKey);
    if (!prior) unique.set(identityKey, event);
  }
  return [...unique].filter(([id, event]) => !ambiguous.has(id) && ['opted_in', 'granted'].includes(String(event.consent_state))).map(([, event]) => event);
}

export function linkActivity(ctx: Context, range: { from: string; to: string }, cutoff: string, linkId?: string, campaignId?: string) {
  const links = ctx.list('short_link').filter(link => visibleAt(link, cutoff) && (!linkId || link.id === linkId)
    && (!campaignId || link.campaign_id === campaignId));
  const clicks = ctx.list('click_event').filter(event => visibleAt(event, cutoff) && inPeriod(event.occurred_at, range)
    && factDate(event.occurred_at)! <= cutoff);
  const events = consentedTouchpoints(ctx, cutoff).filter(event => inPeriod(event.occurred_at, range));
  return links.map(link => {
    const redirects = new Map(clicks.filter(click => click.short_link_id === link.id).map(click => [click.id, click]));
    const classified = [...redirects.values()];
    const filtered = classified.filter(click => ['human_likely', 'unknown'].includes(String(click.classification)));
    const completeClassification = classified.every(click => ['human_likely', 'unknown', 'bot_preview', 'crawler', 'prefetch'].includes(String(click.classification)));
    const stagesObserved = stages.map(type => {
      const count = events.filter(event => event.short_link_id === link.id && event.event_type === type).length;
      return { event_type: type, value: count || null, availability: count ? 'observed' : 'not_collected' };
    });
    return { short_link_id: link.id, campaign_id: optionalString(link.campaign_id), content_item_id: optionalString(link.content_item_id),
      redirects: redirects.size || null, clicks_filtered: redirects.size && completeClassification ? filtered.length : null, stages: stagesObserved };
  });
}
