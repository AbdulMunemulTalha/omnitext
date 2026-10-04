import { Router } from 'express';
import { randomBytes, randomInt } from 'node:crypto';
import { requireAuth, requireOwner } from '../auth.js';
import { nowIso, transaction } from '../db.js';
import { InboxError } from '../inbox.js';
import { createMetaClient } from '../platforms/metaConnect.js';
import { encryptSecret, decryptSecret } from '../secrets.js';

const STATE_MINUTES = 15;
const PENDING_MINUTES = 30;

const minutesFromNow = (m) => new Date(Date.now() + m * 60_000).toISOString();

// Adds a channel, or refreshes its token if this workspace already has it.
function upsertChannel(db, workspaceId, { platform, externalId, name, token, wabaId = null, pageId = null }) {
  const existing = db.prepare('SELECT * FROM channels WHERE platform = ? AND external_id = ?').get(platform, externalId);
  if (existing && existing.workspace_id !== workspaceId) {
    throw new InboxError(409, `${name} is already connected to another Quicky account`);
  }
  if (existing) {
    db.prepare(`UPDATE channels SET name = ?, access_token = ?, waba_id = COALESCE(?, waba_id), page_id = COALESCE(?, page_id),
      needs_reconnect = 0 WHERE id = ?`).run(name, token, wabaId, pageId, existing.id);
    return existing.id;
  }
  return Number(db.prepare(`INSERT INTO channels (workspace_id, platform, external_id, name, access_token, waba_id, page_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(workspaceId, platform, externalId, name, token, wabaId, pageId).lastInsertRowid);
}

export function connectRoutes(db, config, { fetchImpl, emit = () => {}, importer = null } = {}) {
  const router = Router();
  const auth = requireAuth(db);
  const meta = createMetaClient({ ...config.meta, fetchImpl });

  function requireMetaApp(_req, _res, next) {
    if (!config.meta.appId || !config.meta.appSecret) {
      throw new InboxError(503, 'Facebook connection is not set up on this server (META_APP_ID and META_APP_SECRET)');
    }
    next();
  }

  function cleanupExpired() {
    const now = nowIso();
    db.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').run(now);
    db.prepare('DELETE FROM pending_connections WHERE expires_at <= ?').run(now);
  }

  function loadPending(req) {
    cleanupExpired();
    const row = db.prepare('SELECT * FROM pending_connections WHERE id = ? AND workspace_id = ?')
      .get(String(req.params.id), req.user.workspace_id);
    if (!row) throw new InboxError(404, 'This connection has expired. Please connect again.');
    return { row, pages: JSON.parse(decryptSecret(row.payload, config.tokenKey)) };
  }

  router.get('/api/connect/facebook/start', auth, requireOwner, requireMetaApp, (req, res) => {
    cleanupExpired();
    const redirectUri = `${config.publicUrl || `${req.protocol}://${req.get('host')}`}/auth/facebook/callback`;
    const state = randomBytes(24).toString('base64url');
    db.prepare('INSERT INTO oauth_states (state, workspace_id, user_id, redirect_uri, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(state, req.user.workspace_id, req.user.id, redirectUri, minutesFromNow(STATE_MINUTES));
    res.json({ url: meta.loginUrl({ redirectUri, state, configId: config.meta.loginConfigId }) });
  });

  // Facebook sends the browser here after login. The owner is not identified by
  // a token on this request, only by the one-time state created above.
  router.get('/auth/facebook/callback', async (req, res) => {
    const fail = (message) => res.redirect(`/app?connect_error=${encodeURIComponent(message)}`);
    const state = db.prepare('SELECT * FROM oauth_states WHERE state = ? AND expires_at > ?').get(String(req.query.state ?? ''), nowIso());
    if (!state) return fail('This Facebook login link has expired. Please try again.');
    db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state.state);
    if (req.query.error || !req.query.code) {
      return fail(req.query.error_reason === 'user_denied'
        ? 'Facebook connection was cancelled.'
        : String(req.query.error_description || 'Facebook did not complete the login.'));
    }

    let pages;
    try {
      const userToken = await meta.userTokenFromCode({ code: String(req.query.code), redirectUri: state.redirect_uri });
      pages = await meta.listPages(userToken);
    } catch (err) {
      return fail(`Facebook error: ${err.message}`);
    }
    if (!pages.length) {
      return fail('No Facebook Pages were shared. Connect again and tick your business Page when Facebook asks.');
    }

    const id = randomBytes(18).toString('base64url');
    db.prepare('INSERT INTO pending_connections (id, workspace_id, payload, expires_at) VALUES (?, ?, ?, ?)')
      .run(id, state.workspace_id, encryptSecret(JSON.stringify(pages), config.tokenKey), minutesFromNow(PENDING_MINUTES));
    res.redirect(`/app?connect=${id}`);
  });

  router.get('/api/connect/facebook/:id', auth, requireOwner, (req, res) => {
    const { pages } = loadPending(req);
    const connected = new Set(db.prepare('SELECT platform, external_id FROM channels WHERE workspace_id = ?')
      .all(req.user.workspace_id).map((c) => `${c.platform}:${c.external_id}`));
    res.json(pages.map((p) => ({
      id: p.id,
      name: p.name,
      messengerConnected: connected.has(`messenger:${p.id}`),
      instagram: p.instagram && { ...p.instagram, connected: connected.has(`instagram:${p.instagram.id}`) },
    })));
  });

  router.post('/api/connect/facebook/:id', auth, requireOwner, requireMetaApp, async (req, res) => {
    const { row, pages } = loadPending(req);
    const messenger = new Set((req.body?.messenger ?? []).map(String));
    const instagram = new Set((req.body?.instagram ?? []).map(String));
    const chosen = pages.filter((p) => messenger.has(p.id) || (p.instagram && instagram.has(p.instagram.id)));
    if (!chosen.length) throw new InboxError(400, 'Choose at least one Page or Instagram account');

    const connected = [];
    const problems = [];
    const channelIds = [];
    for (const page of chosen) {
      try {
        await meta.subscribePage(page.id, page.accessToken);
      } catch (err) {
        problems.push(`${page.name}: ${err.message}`);
        continue;
      }
      const token = encryptSecret(page.accessToken, config.tokenKey);
      try {
        transaction(db, () => {
          if (messenger.has(page.id)) {
            channelIds.push(upsertChannel(db, req.user.workspace_id,
              { platform: 'messenger', externalId: page.id, name: page.name, token, pageId: page.id }));
            connected.push(page.name);
          }
          if (page.instagram && instagram.has(page.instagram.id)) {
            const name = page.instagram.username ? `@${page.instagram.username}` : `${page.name} (Instagram)`;
            channelIds.push(upsertChannel(db, req.user.workspace_id,
              { platform: 'instagram', externalId: page.instagram.id, name, token, pageId: page.id }));
            connected.push(name);
          }
        });
      } catch (err) {
        if (!(err instanceof InboxError)) throw err;
        problems.push(err.message);
      }
    }
    db.prepare('DELETE FROM pending_connections WHERE id = ?').run(row.id);
    // Bring in the conversations these accounts already have, in the background.
    for (const channelId of channelIds) importer?.start(channelId);
    emit(req.user.workspace_id, 'channels', null);
    res.json({ connected, problems, importing: channelIds.length > 0 });
  });

  // Called by the dashboard after Meta's WhatsApp Embedded Signup popup finishes.
  // `coexistence` means the business connected the number it already uses in the
  // WhatsApp Business app: it stays registered there, and its contacts and chat
  // history can be synced (only once, within 24 hours of onboarding).
  router.post('/api/connect/whatsapp', auth, requireOwner, requireMetaApp, async (req, res) => {
    const { code, wabaId, coexistence = false } = req.body ?? {};
    let phoneNumberId = req.body?.phoneNumberId ?? null;
    if (![code, wabaId].every((v) => typeof v === 'string' && v.trim())) {
      throw new InboxError(400, 'WhatsApp signup did not finish. Please try again.');
    }
    if (!/^\d+$/.test(wabaId) || (phoneNumberId !== null && !/^\d+$/.test(String(phoneNumberId)))) {
      throw new InboxError(400, 'Unexpected WhatsApp account ID');
    }

    let token;
    try {
      token = await meta.businessTokenFromCode(code);
      await meta.subscribeWaba(wabaId, token);
      // Newer sign-up flows (and Business app numbers) only report the account, not the number.
      if (!phoneNumberId) {
        const numbers = await meta.wabaPhoneNumbers(wabaId, token);
        if (!numbers.length) throw new InboxError(400, 'No phone number was added in WhatsApp signup. Please run it again and add your number.');
        phoneNumberId = String(numbers[0].id);
      }
    } catch (err) {
      if (err instanceof InboxError) throw err;
      throw new InboxError(502, `WhatsApp error: ${err.message}`);
    }

    const problems = [];
    let registeredPin = null;
    if (!coexistence) {
      // A number that already uses the Cloud API is registered with its own PIN,
      // in which case this fails harmlessly.
      const pin = String(randomInt(0, 1_000_000)).padStart(6, '0');
      try {
        await meta.registerPhone(phoneNumberId, token, pin);
        registeredPin = pin;
      } catch (err) {
        problems.push(`Could not register the number for messaging: ${err.message}`);
      }
    }

    let name = `WhatsApp ${phoneNumberId}`;
    try {
      const info = await meta.phoneNumber(phoneNumberId, token);
      name = [info.verified_name, info.display_phone_number].filter(Boolean).join(' · ') || name;
    } catch { /* keep the fallback name */ }

    const channelId = upsertChannel(db, req.user.workspace_id, {
      platform: 'whatsapp', externalId: phoneNumberId, name, token: encryptSecret(token, config.tokenKey), wabaId,
    });

    let importing = false;
    if (coexistence) {
      // Contacts first (they carry the names), then chat history. Both arrive as webhooks.
      try {
        await meta.requestAppDataSync(phoneNumberId, token, 'smb_app_state_sync');
      } catch (err) {
        problems.push(`Could not sync WhatsApp contacts: ${err.message}`);
      }
      try {
        await meta.requestAppDataSync(phoneNumberId, token, 'history');
        db.prepare("UPDATE channels SET import_status = 'running', import_count = 0, import_error = NULL WHERE id = ?").run(channelId);
        importing = true;
      } catch (err) {
        problems.push(`Could not start chat history sync: ${err.message}`);
      }
    }
    emit(req.user.workspace_id, 'channels', null);
    res.json({ connected: [name], problems, pin: registeredPin, importing });
  });

  router.use('/api/connect', (err, _req, res, _next) => {
    if (err instanceof InboxError) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return router;
}
