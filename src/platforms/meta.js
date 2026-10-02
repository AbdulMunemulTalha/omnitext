import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

const HOUR = 3_600_000;

export function verifySignature(rawBody, header, appSecret) {
  if (!rawBody || !header || !header.startsWith('sha256=')) return false;
  const expected = Buffer.from(createHmac('sha256', appSecret).update(rawBody).digest('hex'));
  const actual = Buffer.from(header.slice(7));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function toIso(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return new Date().toISOString();
  // WhatsApp sends seconds, Messenger and Instagram send milliseconds.
  return new Date(n < 1e12 ? n * 1000 : n).toISOString();
}

function parseMessaging(platform, entry, { appId }) {
  const out = [];
  for (const event of entry.messaging ?? []) {
    const msg = event.message;
    if (!msg?.mid || msg.is_deleted) continue;
    const isEcho = Boolean(msg.is_echo);
    // Echoes of replies this app sent are already stored; echoes from the
    // native apps (Business Suite, phone) are kept so history stays complete.
    if (isEcho && appId && String(msg.app_id) === String(appId)) continue;
    out.push({
      platform,
      channelExternalId: String(entry.id),
      contactExternalId: String(isEcho ? event.recipient?.id : event.sender?.id),
      contactName: null,
      direction: isEcho ? 'out' : 'in',
      messageId: msg.mid,
      text: msg.text ?? '',
      attachments: (msg.attachments ?? []).map((a) => ({ type: a.type, url: a.payload?.url ?? null })),
      timestamp: toIso(event.timestamp),
    });
  }
  return out;
}

const WHATSAPP_MEDIA = ['image', 'video', 'audio', 'document', 'sticker'];

function whatsappText(m) {
  switch (m.type) {
    case 'text': return m.text?.body ?? '';
    case 'button': return m.button?.text ?? '';
    case 'interactive': return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? '';
    case 'location': return `Location: ${m.location?.latitude}, ${m.location?.longitude}${m.location?.name ? ` (${m.location.name})` : ''}`;
    default: return m[m.type]?.caption ?? '';
  }
}

function parseWhatsApp(entry) {
  const messages = [];
  const statuses = [];
  for (const change of entry.changes ?? []) {
    if (change.field !== 'messages') continue;
    const value = change.value ?? {};
    const phoneNumberId = String(value.metadata?.phone_number_id ?? '');
    const names = new Map((value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name ?? null]));
    for (const m of value.messages ?? []) {
      messages.push({
        platform: 'whatsapp',
        channelExternalId: phoneNumberId,
        contactExternalId: String(m.from),
        contactName: names.get(m.from) ?? null,
        direction: 'in',
        messageId: m.id,
        text: whatsappText(m),
        attachments: WHATSAPP_MEDIA.includes(m.type) ? [{ type: m.type, mediaId: m[m.type]?.id ?? null }] : [],
        timestamp: toIso(m.timestamp),
      });
    }
    for (const s of value.statuses ?? []) {
      statuses.push({
        platform: 'whatsapp',
        messageId: s.id,
        status: s.status,
        error: s.errors?.[0]?.title ?? s.errors?.[0]?.message ?? null,
      });
    }
  }
  return { messages, statuses };
}

// Turns any Messenger, Instagram or WhatsApp webhook payload into a flat list
// of normalized messages and delivery statuses.
export function parseWebhook(body, { appId = '' } = {}) {
  const messages = [];
  const statuses = [];
  for (const entry of body?.entry ?? []) {
    if (body.object === 'page') messages.push(...parseMessaging('messenger', entry, { appId }));
    else if (body.object === 'instagram') messages.push(...parseMessaging('instagram', entry, { appId }));
    else if (body.object === 'whatsapp_business_account') {
      const parsed = parseWhatsApp(entry);
      messages.push(...parsed.messages);
      statuses.push(...parsed.statuses);
    }
  }
  return { messages, statuses };
}

// Meta only allows free-form replies for 24h after the customer's last message.
// Messenger and Instagram allow a human agent 7 days with the HUMAN_AGENT tag;
// WhatsApp needs an approved template after 24h.
export function messagingWindow(platform, lastInboundAt, now = Date.now()) {
  if (!lastInboundAt) return { ok: false, reason: 'The customer has not messaged this channel yet.' };
  const age = now - new Date(lastInboundAt).getTime();
  if (age <= 24 * HOUR) return { ok: true, tag: null };
  if (platform !== 'whatsapp' && age <= 7 * 24 * HOUR) return { ok: true, tag: 'HUMAN_AGENT' };
  return {
    ok: false,
    reason: platform === 'whatsapp'
      ? 'More than 24 hours since the customer last wrote. WhatsApp only allows approved template messages now.'
      : 'More than 7 days since the customer last wrote. Meta does not allow replies this late.',
  };
}

export class MetaApiError extends Error {
  constructor(message, code = null) {
    super(message);
    this.code = code;
  }
}

// Meta's error code for an expired, revoked or otherwise invalid access token.
export const INVALID_TOKEN = 190;

export async function graphRequest(url, { method = 'GET', accessToken, body, fetchImpl = globalThis.fetch } = {}) {
  const res = await fetchImpl(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) {
    throw new MetaApiError(data?.error?.message || `Meta API returned ${res.status}`, data?.error?.code ?? null);
  }
  return data;
}

const graphPost = (url, accessToken, body, fetchImpl) => graphRequest(url, { method: 'POST', accessToken, body, fetchImpl });

export async function sendText({ channel, contact, text, tag, graphVersion, dryRun, fetchImpl = globalThis.fetch }) {
  if (dryRun || !channel.access_token) return { externalId: `dry_${randomBytes(8).toString('hex')}` };
  const base = `https://graph.facebook.com/${graphVersion}`;

  if (channel.platform === 'whatsapp') {
    const data = await graphPost(`${base}/${channel.external_id}/messages`, channel.access_token, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: contact.external_id,
      type: 'text',
      text: { body: text },
    }, fetchImpl);
    return { externalId: data.messages?.[0]?.id ?? null };
  }

  const payload = { recipient: { id: contact.external_id }, message: { text } };
  if (tag) Object.assign(payload, { messaging_type: 'MESSAGE_TAG', tag });
  else payload.messaging_type = 'RESPONSE';
  const data = await graphPost(`${base}/me/messages`, channel.access_token, payload, fetchImpl);
  return { externalId: data.message_id ?? null };
}
