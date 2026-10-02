import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { transaction } from '../db.js';
import { hashPassword, verifyPassword, createSession, deleteSession, bearerToken, requireAuth, requireOwner } from '../auth.js';
import { InboxError } from '../inbox.js';
import { ordersCsv } from '../orders.js';
import { encryptSecret } from '../secrets.js';

const PLATFORMS = ['messenger', 'instagram', 'whatsapp'];

const publicUser = (u) => ({
  id: u.id, name: u.name, email: u.email, role: u.role,
  isOnline: Boolean(u.is_online), isActive: u.is_active === undefined ? true : Boolean(u.is_active),
});

const publicChannel = (c) => ({
  id: c.id, platform: c.platform, externalId: c.external_id, name: c.name, connected: Boolean(c.access_token),
  needsReconnect: Boolean(c.needs_reconnect),
});

const publicWorkspace = (w) => ({
  id: w.id, name: w.name, deliveryInsideDhaka: w.delivery_inside_dhaka, deliveryOutsideDhaka: w.delivery_outside_dhaka,
});

function required(body, fields) {
  for (const f of fields) {
    if (typeof body?.[f] !== 'string' || !body[f].trim()) throw new InboxError(400, `${f} is required`);
  }
}

const id = (req) => Number(req.params.id);

export function apiRoutes(db, config, inbox, orders) {
  const router = Router();
  const auth = requireAuth(db);

  router.post('/auth/signup', (req, res) => {
    required(req.body, ['businessName', 'name', 'email', 'password']);
    const { businessName, name, email, password } = req.body;
    if (password.length < 8) throw new InboxError(400, 'Password must be at least 8 characters');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new InboxError(409, 'Email already registered');
    const userId = transaction(db, () => {
      const ws = db.prepare('INSERT INTO workspaces (name) VALUES (?)').run(businessName.trim());
      return Number(db.prepare(`INSERT INTO users (workspace_id, name, email, password_hash, role, is_online)
        VALUES (?, ?, ?, ?, 'owner', 1)`).run(ws.lastInsertRowid, name.trim(), email.trim(), hashPassword(password)).lastInsertRowid);
    });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    res.status(201).json({ token: createSession(db, userId), user: publicUser(user) });
  });

  router.post('/auth/login', (req, res) => {
    required(req.body, ['email', 'password']);
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND is_active = 1').get(req.body.email.trim());
    if (!user || !verifyPassword(req.body.password, user.password_hash)) {
      throw new InboxError(401, 'Wrong email or password');
    }
    res.json({ token: createSession(db, user.id), user: publicUser(user) });
  });

  router.post('/auth/logout', auth, (req, res) => {
    deleteSession(db, bearerToken(req));
    res.sendStatus(204);
  });

  router.get('/me', auth, (req, res) => {
    const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.user.workspace_id);
    res.json({
      user: publicUser(req.user),
      workspace: publicWorkspace(ws),
      devTools: !config.isProduction,
      connect: {
        facebook: Boolean(config.meta.appId && config.meta.appSecret),
        whatsapp: Boolean(config.meta.appId && config.meta.appSecret && config.meta.whatsappConfigId),
        appId: config.meta.appId,
        whatsappConfigId: config.meta.whatsappConfigId,
        graphVersion: config.meta.graphVersion,
      },
    });
  });

  router.post('/me/duty', auth, (req, res) => {
    const assigned = inbox.setOnDuty(req.user, Boolean(req.body?.online));
    res.json({ online: Boolean(req.body?.online), assigned });
  });

  router.get('/conversations', auth, (req, res) => {
    res.json(inbox.listConversations(req.user, { filter: req.query.filter, status: req.query.status === 'closed' ? 'closed' : 'open' }));
  });

  router.get('/conversations/:id/messages', auth, (req, res) => {
    res.json(inbox.listMessages(req.user, id(req)));
  });

  // Express 5 forwards the rejected promise to the error handler below.
  router.post('/conversations/:id/messages', auth, async (req, res) => {
    res.status(201).json(await inbox.sendReply(req.user, id(req), req.body?.text));
  });

  router.post('/conversations/:id/read', auth, (req, res) => {
    res.json(inbox.markRead(req.user, id(req)));
  });

  router.post('/conversations/:id/status', auth, (req, res) => {
    res.json(inbox.setStatus(req.user, id(req), req.body?.status));
  });

  router.post('/conversations/:id/assign', auth, requireOwner, (req, res) => {
    const userId = req.body?.userId == null ? null : Number(req.body.userId);
    res.json(inbox.reassign(req.user, id(req), userId));
  });

  router.patch('/workspace', auth, requireOwner, (req, res) => {
    const fields = { deliveryInsideDhaka: 'delivery_inside_dhaka', deliveryOutsideDhaka: 'delivery_outside_dhaka' };
    for (const [key, column] of Object.entries(fields)) {
      if (req.body?.[key] === undefined) continue;
      const value = Number(req.body[key]);
      if (!Number.isInteger(value) || value < 0) throw new InboxError(400, 'Delivery charge must be a whole number of taka');
      db.prepare(`UPDATE workspaces SET ${column} = ? WHERE id = ?`).run(value, req.user.workspace_id);
    }
    res.json(publicWorkspace(db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.user.workspace_id)));
  });

  router.get('/conversations/:id/orders', auth, (req, res) => {
    res.json({ draft: orders.draftFor(req.user, id(req)), orders: orders.forConversation(req.user, id(req)) });
  });

  router.post('/conversations/:id/orders', auth, async (req, res) => {
    const { sendSummary, ...input } = req.body ?? {};
    res.status(201).json(await orders.create(req.user, id(req), input, { sendSummary: Boolean(sendSummary) }));
  });

  router.get('/orders', auth, (req, res) => {
    res.json(orders.list(req.user, { status: req.query.status, q: req.query.q }));
  });

  router.get('/orders.csv', auth, (req, res) => {
    const date = new Date().toISOString().slice(0, 10);
    res.type('text/csv; charset=utf-8')
      .attachment(`orders-${date}.csv`)
      // The BOM makes Excel read Bangla names correctly.
      .send(`\uFEFF${ordersCsv(orders.list(req.user, { status: req.query.status, q: req.query.q }))}`);
  });

  router.patch('/orders/:id', auth, (req, res) => {
    res.json(orders.update(req.user, id(req), { status: req.body?.status, note: req.body?.note }));
  });

  router.get('/saved-replies', auth, (req, res) => {
    res.json(db.prepare('SELECT id, shortcut, text FROM saved_replies WHERE workspace_id = ? ORDER BY shortcut').all(req.user.workspace_id));
  });

  router.post('/saved-replies', auth, requireOwner, (req, res) => {
    required(req.body, ['shortcut', 'text']);
    const shortcut = req.body.shortcut.trim().replace(/^\//, '').toLowerCase();
    if (!/^[a-z0-9_-]{1,30}$/.test(shortcut)) throw new InboxError(400, 'Shortcut can only use letters, numbers, - and _');
    db.prepare(`
      INSERT INTO saved_replies (workspace_id, shortcut, text) VALUES (?, ?, ?)
      ON CONFLICT (workspace_id, shortcut) DO UPDATE SET text = excluded.text
    `).run(req.user.workspace_id, shortcut, req.body.text.trim());
    res.status(201).json(db.prepare('SELECT id, shortcut, text FROM saved_replies WHERE workspace_id = ? AND shortcut = ?')
      .get(req.user.workspace_id, shortcut));
  });

  router.delete('/saved-replies/:id', auth, requireOwner, (req, res) => {
    db.prepare('DELETE FROM saved_replies WHERE id = ? AND workspace_id = ?').run(id(req), req.user.workspace_id);
    res.sendStatus(204);
  });

  router.get('/team', auth, (req, res) => {
    const rows = db.prepare(`
      SELECT u.*, (SELECT COUNT(*) FROM conversations c WHERE c.assigned_user_id = u.id AND c.status = 'open') AS open_count
      FROM users u WHERE u.workspace_id = ? ORDER BY u.role DESC, u.name
    `).all(req.user.workspace_id);
    res.json(rows.map((u) => ({ ...publicUser(u), openCount: u.open_count })));
  });

  router.post('/team', auth, requireOwner, (req, res) => {
    required(req.body, ['name', 'email']);
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(req.body.email.trim())) {
      throw new InboxError(409, 'Email already registered');
    }
    const password = req.body.password?.trim() || randomBytes(6).toString('base64url');
    const { lastInsertRowid } = db.prepare(`INSERT INTO users (workspace_id, name, email, password_hash, role)
      VALUES (?, ?, ?, ?, 'moderator')`).run(req.user.workspace_id, req.body.name.trim(), req.body.email.trim(), hashPassword(password));
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
    res.status(201).json({ user: publicUser(user), password });
  });

  router.patch('/team/:id', auth, requireOwner, (req, res) => {
    const member = db.prepare("SELECT * FROM users WHERE id = ? AND workspace_id = ? AND role = 'moderator'")
      .get(id(req), req.user.workspace_id);
    if (!member) throw new InboxError(404, 'Moderator not found');
    if (typeof req.body?.isActive === 'boolean') {
      transaction(db, () => {
        db.prepare('UPDATE users SET is_active = ?, is_online = 0 WHERE id = ?').run(req.body.isActive ? 1 : 0, member.id);
        if (!req.body.isActive) {
          // A removed moderator's customers go back to the queue for the rest of the team.
          db.prepare("UPDATE conversations SET assigned_user_id = NULL WHERE assigned_user_id = ? AND status = 'open'").run(member.id);
          db.prepare('DELETE FROM sessions WHERE user_id = ?').run(member.id);
        }
      });
    }
    res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(member.id)));
  });

  router.get('/channels', auth, (req, res) => {
    res.json(db.prepare('SELECT * FROM channels WHERE workspace_id = ? ORDER BY id').all(req.user.workspace_id).map(publicChannel));
  });

  router.post('/channels', auth, requireOwner, (req, res) => {
    required(req.body, ['platform', 'externalId', 'name']);
    const { platform, externalId, name, accessToken = '' } = req.body;
    if (!PLATFORMS.includes(platform)) throw new InboxError(400, 'Unknown platform');
    if (db.prepare('SELECT 1 FROM channels WHERE platform = ? AND external_id = ?').get(platform, externalId.trim())) {
      throw new InboxError(409, 'This account is already connected');
    }
    const { lastInsertRowid } = db.prepare(`INSERT INTO channels (workspace_id, platform, external_id, name, access_token)
      VALUES (?, ?, ?, ?, ?)`).run(req.user.workspace_id, platform, externalId.trim(), name.trim(),
      encryptSecret(String(accessToken).trim(), config.tokenKey));
    res.status(201).json(publicChannel(db.prepare('SELECT * FROM channels WHERE id = ?').get(lastInsertRowid)));
  });

  router.delete('/channels/:id', auth, requireOwner, (req, res) => {
    db.prepare('DELETE FROM channels WHERE id = ? AND workspace_id = ?').run(id(req), req.user.workspace_id);
    res.sendStatus(204);
  });

  // Lets you try the inbox without a Meta app: pretends a customer wrote in.
  if (!config.isProduction) {
    router.post('/dev/simulate', auth, (req, res) => {
      const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND workspace_id = ?')
        .get(Number(req.body?.channelId), req.user.workspace_id);
      if (!channel) throw new InboxError(404, 'Channel not found');
      required(req.body, ['customerId', 'text']);
      const result = inbox.ingestMessage({
        platform: channel.platform,
        channelExternalId: channel.external_id,
        contactExternalId: req.body.customerId.trim(),
        contactName: req.body.customerName?.trim() || null,
        direction: 'in',
        messageId: `sim_${randomBytes(8).toString('hex')}`,
        text: req.body.text,
        attachments: [],
        timestamp: new Date().toISOString(),
      });
      res.status(201).json(result);
    });
  }

  router.use((err, req, res, next) => {
    if (err instanceof InboxError) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return router;
}
