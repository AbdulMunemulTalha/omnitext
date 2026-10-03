import { Router } from 'express';
import { parseWebhook, verifySignature } from '../platforms/meta.js';

// One callback URL serves Messenger, Instagram and WhatsApp: configure the same
// URL and verify token for all three products in the Meta app dashboard.
export function webhookRoutes(config, inbox, { db, emit = () => {} } = {}) {
  const router = Router();

  router.get('/webhooks/meta', (req, res) => {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
    if (mode === 'subscribe' && config.meta.verifyToken && token === config.meta.verifyToken) {
      return res.type('text/plain').send(String(challenge));
    }
    res.sendStatus(403);
  });

  router.post('/webhooks/meta', (req, res) => {
    if (config.meta.appSecret) {
      if (!verifySignature(req.rawBody, req.get('x-hub-signature-256'), config.meta.appSecret)) {
        // Never log the secret itself; its length is enough to spot a bad paste (Meta's are 32 characters).
        console.warn(`webhook rejected: bad or missing signature (object=${req.body?.object ?? '?'}, `
          + `signature header ${req.get('x-hub-signature-256') ? 'present' : 'missing'}, `
          + `app secret length ${config.meta.appSecret.length})`);
        return res.sendStatus(401);
      }
    } else if (config.isProduction) {
      console.error('META_APP_SECRET is not set; refusing unsigned webhook');
      return res.sendStatus(500);
    }

    const { messages, statuses, history, contacts } = parseWebhook(req.body, { appId: config.meta.appId });
    const outcome = { stored: 0, ignored: 0, failed: 0 };
    for (const message of messages) {
      try {
        const result = inbox.ingestMessage(message);
        outcome[result.ignored ? 'ignored' : 'stored'] += 1;
        // Enough to trace a message without logging what the customer wrote.
        const kinds = message.attachments.map((at) => at.type).join(',') || 'none';
        const where = result.ignored
          ? `ignored: ${result.ignored} (${message.platform} account ${message.channelExternalId})`
          : `shop ${result.conversation.workspace_id}, conversation ${result.conversation.id}`;
        console.log(`  ${message.direction === 'in' ? 'customer message' : 'sent by the page/account itself'}: `
          + `${where}, text ${message.text.length} chars, attachments ${kinds}`);
      } catch (err) {
        outcome.failed += 1;
        console.error('Failed to store webhook message', message.messageId, err);
      }
    }
    for (const status of statuses) inbox.applyStatus(status);
    // One line per delivery, without message contents.
    console.log(`webhook ${req.body?.object ?? '?'}: ${messages.length} messages (${outcome.stored} stored, `
      + `${outcome.ignored} ignored, ${outcome.failed} failed), ${statuses.length} statuses`);
    // Always acknowledge quickly, otherwise Meta retries and eventually disables the webhook.
    res.sendStatus(200);
    // History chunks can hold thousands of messages, so they are stored after answering Meta.
    if (history.length || contacts.length) setImmediate(() => storeSyncedData(history, contacts));
  });

  const findChannel = (platform, externalId) =>
    db.prepare('SELECT id, workspace_id FROM channels WHERE platform = ? AND external_id = ?').get(platform, externalId);

  function setImport(channel, fields) {
    const sets = Object.keys(fields).map((k) => `${k} = ${k === 'import_count' ? 'import_count + ?' : '?'}`).join(', ');
    db.prepare(`UPDATE channels SET ${sets} WHERE id = ?`).run(...Object.values(fields), channel.id);
    emit(channel.workspace_id, 'channels', null);
  }

  function storeSyncedData(history, contacts) {
    for (const contact of contacts) {
      const channel = findChannel(contact.platform, contact.channelExternalId);
      if (channel) inbox.setContactName(channel.id, contact.contactExternalId, contact.name);
    }
    for (const chunk of history) {
      const channel = findChannel(chunk.platform, chunk.channelExternalId);
      if (!channel) continue;
      try {
        if (chunk.declined) {
          setImport(channel, { import_status: 'declined', import_error: chunk.error });
          console.log(`history sync for channel ${channel.id}: declined by the business`);
          continue;
        }
        const { conversations, messages } = inbox.importHistory(channel.id, chunk.threads);
        setImport(channel, {
          import_count: conversations,
          ...(chunk.progress === 100 ? { import_status: 'done' } : {}),
        });
        console.log(`history sync for channel ${channel.id}: ${conversations} conversations, ${messages} new messages`
          + `${chunk.progress === null ? '' : `, ${chunk.progress}% done`}`);
      } catch (err) {
        console.error('Failed to store WhatsApp history', err);
      }
    }
  }

  return router;
}
