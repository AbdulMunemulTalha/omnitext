import { graphRequest } from './platforms/meta.js';
import { decryptSecret } from './secrets.js';

// Meta only returns the 20 most recent messages of each conversation.
const MESSAGES_PER_CONVERSATION = 20;
const MAX_CONVERSATIONS = 300;
const MAX_AGE_DAYS = 180;
const PAGE_SIZE = 25;

// Graph returns "2026-10-03T10:15:35+0000", which not every parser accepts.
export function graphTime(value) {
  const iso = String(value).replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

function attachmentsOf(message) {
  return (message.attachments?.data ?? []).map((a) => {
    if (a.image_data?.url) return { type: 'image', url: a.image_data.url };
    if (a.video_data?.url) return { type: 'video', url: a.video_data.url };
    return { type: a.mime_type?.split('/')[0] || 'file', url: a.file_url ?? null };
  });
}

// One Conversations API conversation -> the thread shape inbox.importHistory takes.
export function toThread(conversation, { platform, businessId, channelExternalId }) {
  const customer = (conversation.participants?.data ?? []).find((p) => String(p.id) !== String(businessId));
  if (!customer) return null;
  const name = customer.name || (customer.username ? `@${customer.username}` : null);
  const messages = (conversation.messages?.data ?? []).map((m) => ({
    platform,
    channelExternalId,
    contactExternalId: String(customer.id),
    direction: String(m.from?.id) === String(businessId) ? 'out' : 'in',
    messageId: m.id,
    text: m.message ?? '',
    attachments: attachmentsOf(m),
    timestamp: graphTime(m.created_time),
  })).reverse(); // API lists newest first
  return { contactExternalId: String(customer.id), contactName: name, messages };
}

export function createImporter(db, config, inbox, { fetchImpl, emit = () => {} } = {}) {
  const base = `https://graph.facebook.com/${config.meta.graphVersion}`;
  const running = new Set();

  function setStatus(channelId, fields) {
    const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE channels SET ${sets} WHERE id = ?`).run(...Object.values(fields), channelId);
    const channel = db.prepare('SELECT workspace_id FROM channels WHERE id = ?').get(channelId);
    if (channel) emit(channel.workspace_id, 'channels', null);
  }

  async function importMetaChannel(channel) {
    const token = decryptSecret(channel.access_token, config.tokenKey);
    // Instagram history is read through the linked Facebook Page.
    const pageId = channel.page_id || (channel.platform === 'messenger'
      ? channel.external_id
      : (await graphRequest(`${base}/me?fields=id`, { accessToken: token, fetchImpl })).id);

    const fields = `participants,updated_time,messages.limit(${MESSAGES_PER_CONVERSATION}){id,message,from,created_time,attachments}`;
    let next = `${base}/${pageId}/conversations?platform=${channel.platform}&limit=${PAGE_SIZE}&fields=${encodeURIComponent(fields)}`;
    const cutoff = Date.now() - MAX_AGE_DAYS * 86_400_000;
    let conversations = 0;
    while (next && conversations < MAX_CONVERSATIONS) {
      const page = await graphRequest(next, { accessToken: token, fetchImpl });
      const recent = (page.data ?? []).filter((c) => Date.parse(graphTime(c.updated_time)) >= cutoff);
      const threads = recent
        .map((c) => toThread(c, { platform: channel.platform, businessId: channel.external_id, channelExternalId: channel.external_id }))
        .filter(Boolean);
      conversations += inbox.importHistory(channel.id, threads).conversations;
      setStatus(channel.id, { import_count: conversations });
      // Conversations come newest first, so an old one means the rest are older.
      next = recent.length < (page.data ?? []).length ? null : page.paging?.next ?? null;
    }
    return conversations;
  }

  return {
    // Runs in the background; progress is stored on the channel and pushed to the dashboard.
    start(channelId) {
      const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
      if (!channel || running.has(channelId)) return false;
      if (!['messenger', 'instagram'].includes(channel.platform) || !channel.access_token || config.dryRun) return false;
      running.add(channelId);
      setStatus(channelId, { import_status: 'running', import_count: 0, import_error: null });
      const done = importMetaChannel(channel)
        .then((count) => setStatus(channelId, { import_status: 'done', import_count: count }))
        .catch((err) => {
          console.warn(`import of ${channel.platform} channel ${channelId} failed: ${err.message}`);
          setStatus(channelId, { import_status: 'failed', import_error: err.message });
        })
        .finally(() => running.delete(channelId));
      return done;
    },
  };
}
