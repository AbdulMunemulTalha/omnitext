import { Router } from 'express';
import { parseWebhook, verifySignature } from '../platforms/meta.js';

// One callback URL serves Messenger, Instagram and WhatsApp: configure the same
// URL and verify token for all three products in the Meta app dashboard.
export function webhookRoutes(config, inbox) {
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

    const { messages, statuses } = parseWebhook(req.body, { appId: config.meta.appId });
    const outcome = { stored: 0, ignored: 0, failed: 0 };
    for (const message of messages) {
      try {
        const result = inbox.ingestMessage(message);
        outcome[result.ignored ? 'ignored' : 'stored'] += 1;
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
  });

  return router;
}
