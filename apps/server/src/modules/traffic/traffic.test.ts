import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { DomainError } from '../types.ts';
import { commands as lifecycle } from '../lifecycle/index.ts';
import { context } from '../lifecycle/test-context.ts';
import { commands, readLeadContact, resolveShortLink, submitLandingPage, viewLandingPage } from './index.ts';
import { verifyDestinationDomain } from './policy.ts';

const denied = (error: unknown) => error instanceof DomainError && error.status === 404;

test('exact-host DNS proof gates link creation and redirects, including after revocation', async () => {
  const ctx = context();
  const domain = await commands.request_destination_domain!.run(ctx, { hostname: 'Shop.acme.com' });
  const fields = { destination_url: 'https://shop.acme.com/items?sku=one&utm_source=untrusted#order', utm_params: { utm_source: 'Social Media' } };
  await assert.rejects(commands.links_create!.run(ctx, fields), /Verify the exact/);
  await assert.rejects(verifyDestinationDomain(ctx, domain.id, async () => [['wrong']]), /did not match/);
  const verified = await verifyDestinationDomain(ctx, domain.id, async name => {
    assert.equal(name, '_smartsell.shop.acme.com.');
    return [['smartsell-verification=', domain.data.challenge]];
  });
  for (const destination_url of ['https://shop.acme.com.evil.org/', 'https://shop.acme.com@evil.org/', 'https://shop.acme.com:8443/', 'https://127.0.0.1/', 'http://shop.acme.com/']) {
    await assert.rejects(commands.links_create!.run(ctx, { ...fields, destination_url }), DomainError);
  }
  const initial = await commands.links_create!.run(ctx, { ...fields, publish_target_id: 'target-1' });
  assert.match(initial.link.id, /^[A-Za-z0-9_-]{32}$/);
  assert.deepEqual(await resolveShortLink(ctx, initial.link.id, { userAgent: 'Slackbot' }), { location: 'https://shop.acme.com/items?sku=one&utm_source=social-media#order' });
  const change = { short_link_id: initial.link.id, expected_version: initial.link.version, destination_url: 'https://shop.acme.com/second', reason: 'New page' };
  await assert.rejects(commands.change_link_destination!.run(ctx, change), /Confirm/);
  const revised = await commands.change_link_destination!.run(ctx, { ...change, confirm_in_use: true });
  assert.deepEqual(await resolveShortLink(ctx, initial.link.id), { location: 'https://shop.acme.com/second?utm_source=social-media' });
  const events = await ctx.list('traffic', 'click_event');
  assert.deepEqual(events.map(row => [row.data.revision_id, row.data.classification]), [[initial.revision.id, 'bot_preview'], [revised.revision.id, 'unknown']]);
  assert.deepEqual(await commands.links_get_stats!.run(ctx, { short_link_id: initial.link.id }), { redirects: 2, human_likely: 0, bot_filtered: 1, unknown: 1 });
  await assert.rejects(resolveShortLink(context('other'), initial.link.id), denied);
  await commands.revoke_destination_domain!.run(ctx, { destination_domain_id: domain.id, expected_version: verified.version });
  await assert.rejects(resolveShortLink(ctx, initial.link.id), /Verify the exact/);
  assert.equal((await ctx.list('traffic', 'click_event')).length, 2);
});

test('short links enforce marketplace destinations and use verified fallback at expiration', async () => {
  const ctx = context();
  const store = await ctx.insert('commerce', 'store', { provider: 'shopee' });
  const product = await ctx.insert('commerce', 'product', { store_id: store.id });
  const variant = await ctx.insert('commerce', 'product_variant', { product_id: product.id });
  const purchaseUrl = 'https://shopee.tw/product/123/456';
  await ctx.insert('commerce', 'listing_snapshot', { variant_id: variant.id, market_id: 'tw', purchase_url: purchaseUrl, is_current: true });
  for (const hostname of ['shopee.tw', 'shop.acme.com']) await ctx.insert('traffic', 'destination_domain', { hostname, status: 'verified' });
  await assert.rejects(commands.links_create!.run(ctx, {
    product_variant_id: variant.id, market_id: 'tw', destination_url: 'https://shop.acme.com/items',
  }), /current Shopee product/);
  const registered = await commands.register_landing_destination!.run(ctx, { url: purchaseUrl, kind: 'store_product', product_variant_id: variant.id, market_id: 'tw' });
  const linked = await commands.links_create!.run(ctx, { landing_destination_id: registered.id, utm_params: { utm_campaign: 'Launch' } });
  assert.equal(linked.link.data.product_variant_id, variant.id);
  assert.deepEqual(await resolveShortLink(ctx, linked.link.id), { location: `${purchaseUrl}?utm_campaign=launch` });
  const expires_at = '2026-10-02T00:00:00Z';
  const expiring = await commands.links_create!.run(ctx, { destination_url: 'https://shop.acme.com/promo', fallback_url: 'https://shop.acme.com/expired', expires_at });
  ctx.now = expires_at;
  assert.deepEqual(await resolveShortLink(ctx, expiring.link.id), { location: 'https://shop.acme.com/expired' });
});

test('published landing enforces shown version and separates consent from private lead contact', async t => {
  const previousKey = process.env.SMARTSELL_TRAFFIC_CONTACT_KEY;
  process.env.SMARTSELL_TRAFFIC_CONTACT_KEY = randomBytes(32).toString('base64url');
  t.after(() => {
    if (previousKey === undefined) delete process.env.SMARTSELL_TRAFFIC_CONTACT_KEY;
    else process.env.SMARTSELL_TRAFFIC_CONTACT_KEY = previousKey;
  });
  const ctx = context();
  const service = await lifecycle.create_consent_text!.run(ctx, { channel: 'email', purpose: 'service', locale: 'en', text: 'Reply about this inquiry' });
  const marketing = await lifecycle.create_consent_text!.run(ctx, { channel: 'sms', purpose: 'marketing', locale: 'en', text: 'Send SMS updates' });
  const options = {
    title: 'A landing page', description: 'Say hello',
    service_contact: { channel: 'email', consent_text_version_id: service.id },
    channel_options: [{ channel: 'sms', consent_text_version_id: marketing.id }],
  };
  const draft = await commands.pages_create_draft!.run(ctx, options);
  await assert.rejects(viewLandingPage(ctx, draft.page.id), denied);
  const first = await commands.publish_landing_page!.run(ctx, { page_id: draft.page.id, version_id: draft.version.id, expected_version: draft.page.version });
  const view = await viewLandingPage(ctx, draft.page.id);
  assert.deepEqual(view.channel_options, [{ channel: 'sms', text: 'Send SMS updates' }]);
  assert.deepEqual(view.service_contact, { channel: 'email', text: 'Reply about this inquiry' });
  const next = await commands.pages_create_draft!.run(ctx, { ...options, title: 'Updated', page_id: draft.page.id, expected_version: first.version });
  assert.equal((await viewLandingPage(ctx, draft.page.id)).title, 'A landing page');
  const published = await commands.publish_landing_page!.run(ctx, { page_id: draft.page.id, version_id: next.version.id, expected_version: next.page.version });
  const submission = { version_id: next.version.id, email: 'hello@example.org', phone: '+14155550100', name: 'Lead', message: 'Please reply', service_contact: true, marketing: { sms: true } };
  await assert.rejects(submitLandingPage(ctx, draft.page.id, { ...submission, version_id: view.version_id }), /Reload/);
  await assert.rejects(submitLandingPage(ctx, draft.page.id, { ...submission, marketing: { email: true } }), /does not offer/);
  assert.deepEqual(await submitLandingPage(ctx, draft.page.id, submission), { accepted: true });
  const masked = await commands.leads_list!.run(ctx, {});
  assert.equal(masked[0].status, 'contact_permitted');
  assert.ok(!JSON.stringify(masked).includes(submission.email));
  const stored = await ctx.get('traffic', 'lead_contact', masked[0].id);
  assert.ok(stored?.data.ciphertext);
  assert.ok(!JSON.stringify(stored).includes(submission.email));
  assert.deepEqual(await readLeadContact(ctx, masked[0].id), { email: submission.email, phone: submission.phone, name: submission.name, message: submission.message });
  await assert.rejects(readLeadContact({ ...ctx, role: 'editor' }, masked[0].id), (error: DomainError) => error.status === 403);
  const rows = await ctx.list('lifecycle', 'consent_record');
  assert.deepEqual(rows.map(row => [row.data.channel, row.data.purpose, row.data.action, row.data.consent_text_version_id]), [
    ['email', 'service', 'opt_in', service.id], ['sms', 'marketing', 'pending', marketing.id],
  ]);
  assert.ok(!JSON.stringify(ctx.events).includes(submission.email));
  assert.equal((await lifecycle.segments_preview!.run(ctx, { channel: 'sms' })).excluded.pending, 1);
  await lifecycle.record_consent!.run(ctx, { customer_id: rows[0]?.data.customer_id, channel: 'email', purpose: 'service', action: 'withdrawn', evidence_ref: 'request-1' });
  assert.equal((await commands.leads_list!.run(ctx, {}))[0]?.status, 'contact_not_permitted');
  await assert.rejects(viewLandingPage(context('other'), draft.page.id), denied);
  await commands.unpublish_landing_page!.run(ctx, { page_id: draft.page.id, expected_version: published.version });
  await assert.rejects(submitLandingPage(ctx, draft.page.id, submission), denied);
});
