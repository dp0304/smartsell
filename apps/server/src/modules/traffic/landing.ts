import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { admins, DomainError, text, writers, type Commands, type Context, type Entity, type Fields } from '../types.ts';
import { getConsentText, recordLeadConsent, serviceContactCustomers } from '../lifecycle/index.ts';
import { flag, invalid, object, oneOf } from '../lifecycle/validation.ts';
import { conflict, opaque, own, publicId, traffic } from './policy.ts';
import { productionSemantics } from '../../production.ts';

const channels = ['email', 'sms', 'whatsapp'] as const;
type Channel = typeof channels[number];
type Option = { channel: Channel; consent_text_version_id: string };
type Contact = { name?: string; email?: string; phone?: string; message?: string };
export interface PublicLandingPage {
  slug: string;
  version_id: string;
  title: string;
  description: string;
  service_contact_only: boolean;
  service_contact?: { channel: Channel; text: string };
  channel_options: { channel: Channel; text: string }[];
}
export interface PublicLandingSubmission extends Contact {
  version_id: string;
  service_contact?: boolean;
  marketing?: Partial<Record<Channel, boolean>>;
}

async function parseVersion(ctx: Context, input: Fields) {
  function choice(raw: unknown): Option {
    const data = object(raw, ['channel', 'consent_text_version_id']);
    return { channel: oneOf(data.channel, channels, 'channel'), consent_text_version_id: text(data, 'consent_text_version_id', 128) };
  }
  const service_contact = input.service_contact === undefined ? null : choice(input.service_contact);
  const raw = input.channel_options ?? [];
  if (!Array.isArray(raw) || raw.length > channels.length) invalid('Invalid channel_options');
  const channel_options = raw.map(choice);
  const service_contact_only = flag(input.service_contact_only, 'service_contact_only');
  if (service_contact_only && (!service_contact || channel_options.length)) invalid('A service-only form needs a service option and cannot offer marketing');
  if (new Set(channel_options.map(option => option.channel)).size !== channel_options.length) invalid('Duplicate marketing channels');
  if (service_contact) await getConsentText(ctx, service_contact.consent_text_version_id, service_contact.channel, 'service');
  for (const option of channel_options) await getConsentText(ctx, option.consent_text_version_id, option.channel, 'marketing');
  return {
    title: text(input, 'title', 160), description: input.description === undefined ? '' : text(input, 'description', 2000),
    service_contact_only, service_contact, channel_options,
  };
}

async function published(ctx: Context, slug: string) {
  const page = await own(ctx, 'landing_page', publicId(slug));
  if (page.data.slug !== slug || page.data.status !== 'published' || !page.data.published_version_id) {
    throw new DomainError('not_found', 'Landing page not found', 404);
  }
  const version = await own(ctx, 'landing_page_version', page.data.published_version_id);
  if (version.data.page_id !== page.id) throw new DomainError('not_found', 'Landing page not found', 404);
  return { page, version };
}

export async function viewLandingPage(ctx: Context, slug: string): Promise<PublicLandingPage> {
  const { version } = await published(ctx, slug);
  const { title, description, service_contact_only } = version.data;
  async function viewOption(option: Option, purpose: 'service' | 'marketing') {
    const copy = await getConsentText(ctx, option.consent_text_version_id, option.channel, purpose);
    return { channel: option.channel, text: copy.data.text as string };
  }
  return {
    slug, version_id: version.id, title, description, service_contact_only,
    ...(version.data.service_contact ? { service_contact: await viewOption(version.data.service_contact, 'service') } : {}),
    channel_options: await Promise.all((version.data.channel_options as Option[]).map(option => viewOption(option, 'marketing'))),
  };
}

function contactKey() {
  const raw = process.env.SMARTSELL_TRAFFIC_CONTACT_KEY;
  if (raw === undefined && !productionSemantics()) return undefined;
  if (!raw || !/^[A-Za-z0-9_-]{43}$/.test(raw) || Buffer.from(raw, 'base64url').length !== 32) {
    throw new DomainError('contact_storage_unavailable', 'Lead contact storage is unavailable', 503);
  }
  return Buffer.from(raw, 'base64url');
}

const contactScope = (ctx: Context, id: string) => Buffer.from(JSON.stringify([ctx.tenantId, ctx.workspaceId, id]));
function encodeContact(ctx: Context, id: string, contact: Contact) {
  const key = contactKey();
  if (!key) return { contact }; // Local development storage. Access is gated by the caller and record policy.
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(contactScope(ctx, id));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(contact), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64url'), ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
}

function decodeContact(ctx: Context, id: string, row: Entity): Contact {
  const key = contactKey();
  if (!row.data.ciphertext && !productionSemantics()) return row.data.contact;
  if (!key) throw new DomainError('contact_storage_unavailable', 'Lead contact storage is unavailable', 503);
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.data.iv, 'base64url'));
    cipher.setAAD(contactScope(ctx, id));
    cipher.setAuthTag(Buffer.from(row.data.tag, 'base64url'));
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(row.data.ciphertext, 'base64url')), cipher.final()]).toString('utf8')) as Contact;
  } catch {
    throw new DomainError('contact_storage_unavailable', 'Lead contact storage is unavailable', 503);
  }
}

/** Private read for a trusted authenticated adapter. Command responses are cached, so they must not carry contact details. */
export async function readLeadContact(ctx: Context, leadId: string): Promise<Contact> {
  if (!admins.includes(ctx.role)) throw new DomainError('forbidden', 'Cannot access lead contact', 403);
  const id = publicId(leadId);
  await own(ctx, 'lead', id);
  return decodeContact(ctx, id, await own(ctx, 'lead_contact', id));
}

export async function submitLandingPage(ctx: Context, slug: string, input: PublicLandingSubmission): Promise<{ accepted: true }> {
  const data = object(input, ['version_id', 'email', 'phone', 'name', 'message', 'service_contact', 'marketing']);
  const { page, version } = await published(ctx, slug);
  if (data.version_id !== version.id) conflict('Landing page changed. Reload before submitting.');
  const optional = (key: keyof Contact, limit: number) => data[key] === undefined || data[key] === '' ? undefined : text(data, key, limit);
  const email = optional('email', 254);
  const phone = optional('phone', 16);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) invalid('Invalid email');
  if (phone && !/^\+[1-9]\d{6,14}$/.test(phone)) invalid('Invalid phone');
  if (!email && !phone) invalid('Email or phone is required');
  const contact = { email, phone, name: optional('name', 120), message: optional('message', 2000) };
  const marketing = object(data.marketing ?? {}, channels);
  const choices: { channel: Channel; purpose: 'service' | 'marketing'; textVersionId: string }[] = [];
  function add(option: Option | null | undefined, purpose: 'service' | 'marketing') {
    if (!option) invalid(`This form does not offer that ${purpose} option`);
    if (option.channel === 'email' ? !email : !phone) invalid(`Missing contact for ${option.channel}`);
    choices.push({ channel: option.channel, purpose, textVersionId: option.consent_text_version_id });
  }
  if (flag(data.service_contact, 'service_contact')) add(version.data.service_contact, 'service');
  for (const channel of channels) {
    if (flag(marketing[channel], channel)) add((version.data.channel_options as Option[]).find(option => option.channel === channel), 'marketing');
  }
  const id = opaque();
  const contactData = encodeContact(ctx, id, contact);
  const consents = await recordLeadConsent(ctx, id, version.id, choices);
  const lead = await ctx.insert(traffic, 'lead', {
    source_page_version_id: version.id, landing_page_id: page.id, campaign_id: page.data.campaign_id,
    ...consents, status: choices.some(choice => choice.purpose === 'service') ? 'contact_permitted' : 'contact_not_permitted',
    submitted_at: ctx.now,
  }, id);
  await ctx.insert(traffic, 'lead_contact', contactData, id);
  await ctx.emit('traffic.form.submitted', { lead_id: lead.id, landing_page_version_id: version.id });
  await ctx.emit('traffic.lead.created', { lead_id: lead.id, status: lead.data.status });
  return { accepted: true };
}

const versionFields = ['title', 'description', 'service_contact_only', 'service_contact', 'channel_options'];
export const landingCommands = {
  pages_create_draft: { roles: writers, async run(ctx, input) {
    object(input, [...versionFields, 'page_id', 'expected_version', 'campaign_id']);
    const values = await parseVersion(ctx, input);
    if (input.page_id === undefined && input.expected_version !== undefined) invalid('expected_version requires page_id');
    if (input.page_id !== undefined && input.campaign_id !== undefined) invalid('campaign_id is set when creating a page');
    const slug = opaque();
    const page = input.page_id === undefined
      ? await ctx.insert(traffic, 'landing_page', { slug, status: 'draft', campaign_id: input.campaign_id === undefined ? null : text(input, 'campaign_id', 128) }, slug)
      : await own(ctx, 'landing_page', text(input, 'page_id', 128));
    if (input.page_id !== undefined && input.expected_version !== page.version) conflict('Page version has changed');
    const version = await ctx.insert(traffic, 'landing_page_version', { ...values, page_id: page.id, version_no: (page.data.version_no ?? 0) + 1 });
    const updated = await ctx.update(traffic, 'landing_page', page.id, { draft_version_id: version.id, version_no: version.data.version_no }, page.version);
    return { page: updated, version };
  } },
  publish_landing_page: { roles: admins, async run(ctx, input) {
    object(input, ['page_id', 'version_id', 'expected_version']);
    const page = await own(ctx, 'landing_page', text(input, 'page_id', 128));
    if (input.expected_version !== page.version) conflict('Page version has changed');
    const version = await own(ctx, 'landing_page_version', text(input, 'version_id', 128));
    if (version.data.page_id !== page.id) throw new DomainError('not_found', 'Page version not found', 404);
    const updated = await ctx.update(traffic, 'landing_page', page.id, { published_version_id: version.id, status: 'published' }, page.version);
    await ctx.emit('traffic.landing_page.published', { landing_page_id: page.id, version_id: version.id });
    return updated;
  } },
  unpublish_landing_page: { roles: admins, async run(ctx, input) {
    object(input, ['page_id', 'expected_version']);
    const page = await own(ctx, 'landing_page', text(input, 'page_id', 128));
    if (input.expected_version !== page.version || page.data.status !== 'published') conflict('Page is not currently published at that version');
    const updated = await ctx.update(traffic, 'landing_page', page.id, { status: 'unpublished', published_version_id: null }, page.version);
    await ctx.emit('traffic.landing_page.unpublished', { landing_page_id: page.id });
    return updated;
  } },
  leads_list: { roles: writers, async run(ctx, input) {
    object(input, ['status', 'page_id']);
    const pageId = input.page_id === undefined ? undefined : text(input, 'page_id', 128);
    const status = input.status === undefined ? undefined : oneOf(input.status, ['contact_permitted', 'contact_not_permitted', 'closed'], 'status');
    const eligible = await serviceContactCustomers(ctx);
    return (await ctx.list(traffic, 'lead'))
      .map(({ id, version, data }) => ({
        id, version, page_id: data.landing_page_id, submitted_at: data.submitted_at,
        status: data.status === 'closed' ? 'closed' : eligible.has(data.customer_id) ? 'contact_permitted' : 'contact_not_permitted',
      }))
      .filter(row => (!pageId || pageId === row.page_id) && (!status || status === row.status));
  } },
  close_lead: { roles: writers, async run(ctx, input) {
    object(input, ['lead_id', 'expected_version']);
    const lead = await own(ctx, 'lead', text(input, 'lead_id', 128));
    if (input.expected_version !== lead.version) conflict('Lead version has changed');
    if (lead.data.status === 'closed') return { id: lead.id, status: 'closed', version: lead.version };
    const updated = await ctx.update(traffic, 'lead', lead.id, { status: 'closed' }, lead.version);
    await ctx.emit('traffic.lead.status_changed', { lead_id: lead.id, status: 'closed' });
    return { id: updated.id, status: 'closed', version: updated.version };
  } },
} satisfies Commands;
