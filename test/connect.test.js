import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/app.js';
import { decryptSecret, encryptSecret, parseKey } from '../src/secrets.js';
import { setup } from './helpers.js';

const KEY = randomBytes(32).toString('hex');

// Answers the Graph API calls the connect flow makes, and records them.
function fakeMeta() {
  const calls = [];
  const routes = [];
  const on = (method, pattern, reply) => routes.push({ method, pattern, reply });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const call = { method, path: u.pathname, params: Object.fromEntries(u.searchParams), auth: init.headers?.authorization, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const route = routes.find((r) => r.method === method && r.pattern.test(u.pathname + u.search));
    const [status, data] = route ? route.reply(call) : [404, { error: { message: `unexpected ${method} ${u.pathname}` } }];
    return { ok: status < 400, status, json: async () => data };
  };
  return { calls, on, fetchImpl };
}

let server;
let base;
let ctx;
let meta;

before(async () => {
  meta = fakeMeta();
  ctx = setup({
    env: { META_APP_ID: 'APP', META_APP_SECRET: 'SECRET', META_WHATSAPP_CONFIG_ID: 'WACFG', TOKEN_ENCRYPTION_KEY: KEY, PUBLIC_URL: 'https://inbox.example.com/' },
  });
  ({ server } = createApp(ctx.db, ctx.config, { fetchImpl: meta.fetchImpl }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

async function call(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    redirect: 'manual',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, data, location: res.headers.get('location') };
}

const login = async (email) => (await call('/api/auth/login', { method: 'POST', body: { email, password: 'password123' } })).data.token;

test('encrypts tokens and still reads old plain-text ones', () => {
  const key = parseKey(KEY);
  const stored = encryptSecret('EAAB-page-token', key);
  assert.match(stored, /^enc:v1:/);
  assert.ok(!stored.includes('EAAB'));
  assert.equal(decryptSecret(stored, key), 'EAAB-page-token');
  assert.equal(decryptSecret('plain-old-token', key), 'plain-old-token');
  assert.throws(() => decryptSecret(stored, parseKey(randomBytes(32).toString('hex'))));
  assert.throws(() => parseKey('too-short'), /32 bytes/);
});

test('connects a Facebook Page and its Instagram account after login', async () => {
  meta.on('GET', /\/oauth\/access_token\?.*code=GOOD/, () => [200, { access_token: 'SHORT' }]);
  meta.on('GET', /\/oauth\/access_token\?.*fb_exchange_token=SHORT/, () => [200, { access_token: 'LONG' }]);
  meta.on('GET', /\/me\/accounts/, (c) => (c.params.after
    ? [200, { data: [{ id: '222', name: 'Second Shop', access_token: 'PAGE2' }] }]
    : [200, {
      data: [{ id: '111', name: 'Demo Fashion', access_token: 'PAGE1', instagram_business_account: { id: '999', username: 'demofashion' } }],
      paging: { next: 'https://graph.facebook.com/v23.0/me/accounts?after=abc' },
    }]));
  meta.on('POST', /\/111\/subscribed_apps/, () => [200, { success: true }]);
  meta.on('GET', /\/111\/conversations/, () => [200, { data: [] }]);

  const ownerToken = await login('owner@shop.test');
  const modToken = await login('nadia@shop.test');
  assert.equal((await call('/api/connect/facebook/start', { token: modToken })).status, 403);

  const start = await call('/api/connect/facebook/start', { token: ownerToken });
  const loginUrl = new URL(start.data.url);
  assert.equal(loginUrl.origin + loginUrl.pathname, 'https://www.facebook.com/v23.0/dialog/oauth');
  assert.equal(loginUrl.searchParams.get('redirect_uri'), 'https://inbox.example.com/auth/facebook/callback');
  assert.match(loginUrl.searchParams.get('scope'), /pages_messaging/);
  const state = loginUrl.searchParams.get('state');

  // A forged or reused state is refused.
  const forged = await call('/auth/facebook/callback?state=nope&code=GOOD');
  assert.match(decodeURIComponent(forged.location), /expired/);

  const back = await call(`/auth/facebook/callback?state=${state}&code=GOOD`);
  assert.equal(back.status, 302);
  const pendingId = new URL(back.location, base).searchParams.get('connect');
  assert.ok(pendingId);
  const exchange = meta.calls.find((c) => c.params.code === 'GOOD');
  assert.equal(exchange.params.redirect_uri, 'https://inbox.example.com/auth/facebook/callback');
  assert.equal(exchange.params.client_secret, 'SECRET');
  assert.match(decodeURIComponent((await call(`/auth/facebook/callback?state=${state}&code=GOOD`)).location), /expired/);

  // Page tokens never reach the browser.
  const pages = await call(`/api/connect/facebook/${pendingId}`, { token: ownerToken });
  assert.deepEqual(pages.data.map((p) => p.name), ['Demo Fashion', 'Second Shop']);
  assert.ok(!JSON.stringify(pages.data).includes('PAGE1'));
  assert.equal(pages.data[0].instagram.username, 'demofashion');
  assert.ok(!ctx.db.prepare('SELECT payload FROM pending_connections').get().payload.includes('PAGE1'));

  const done = await call(`/api/connect/facebook/${pendingId}`, { method: 'POST', token: ownerToken, body: { messenger: ['111'], instagram: ['999'] } });
  assert.deepEqual(done.data, { connected: ['Demo Fashion', '@demofashion'], problems: [], importing: true });
  const subscribe = meta.calls.find((c) => c.path.endsWith('/111/subscribed_apps'));
  assert.equal(subscribe.auth, 'Bearer PAGE1');
  assert.equal(subscribe.body.subscribed_fields, 'messages,message_echoes');

  const channels = ctx.db.prepare("SELECT platform, external_id, name, access_token FROM channels WHERE external_id IN ('111', '999') ORDER BY platform").all();
  assert.deepEqual(channels.map((c) => [c.platform, c.external_id, c.name]), [['instagram', '999', '@demofashion'], ['messenger', '111', 'Demo Fashion']]);
  for (const c of channels) {
    assert.match(c.access_token, /^enc:v1:/);
    assert.equal(decryptSecret(c.access_token, ctx.config.tokenKey), 'PAGE1');
  }
  // The pending connection is used up.
  assert.equal((await call(`/api/connect/facebook/${pendingId}`, { token: ownerToken })).status, 404);
});

test('reports a cancelled Facebook login', async () => {
  const ownerToken = await login('owner@shop.test');
  const state = new URL((await call('/api/connect/facebook/start', { token: ownerToken })).data.url).searchParams.get('state');
  const back = await call(`/auth/facebook/callback?state=${state}&error=access_denied&error_reason=user_denied`);
  assert.match(decodeURIComponent(back.location), /connect_error=Facebook connection was cancelled/);
});

test('connects a WhatsApp number from Embedded Signup', async () => {
  meta.on('GET', /\/oauth\/access_token\?.*code=WACODE/, () => [200, { access_token: 'BIZTOKEN' }]);
  meta.on('POST', /\/55555\/subscribed_apps/, () => [200, { success: true }]);
  meta.on('POST', /\/77777\/register/, () => [200, { success: true }]);
  meta.on('GET', /\/77777\?/, () => [200, { verified_name: 'Demo Fashion', display_phone_number: '+880 1700-000000' }]);

  const ownerToken = await login('owner@shop.test');
  const res = await call('/api/connect/whatsapp', { method: 'POST', token: ownerToken, body: { code: 'WACODE', phoneNumberId: '77777', wabaId: '55555' } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.connected, ['Demo Fashion · +880 1700-000000']);
  assert.match(res.data.pin, /^\d{6}$/);

  const register = meta.calls.find((c) => c.path.endsWith('/77777/register'));
  assert.deepEqual(register.body, { messaging_product: 'whatsapp', pin: res.data.pin });
  assert.equal(register.auth, 'Bearer BIZTOKEN');
  const exchange = meta.calls.find((c) => c.params.code === 'WACODE');
  assert.equal(exchange.params.redirect_uri, undefined);

  const channel = ctx.db.prepare("SELECT * FROM channels WHERE platform = 'whatsapp' AND external_id = '77777'").get();
  assert.equal(channel.waba_id, '55555');
  assert.equal(decryptSecret(channel.access_token, ctx.config.tokenKey), 'BIZTOKEN');

  const bad = await call('/api/connect/whatsapp', { method: 'POST', token: ownerToken, body: { code: 'WACODE', phoneNumberId: '../x', wabaId: '55555' } });
  assert.equal(bad.status, 400);
});

test('a channel whose token Meta rejects is flagged for reconnection', async () => {
  meta.on('POST', /\/me\/messages/, () => [400, { error: { message: 'Error validating access token: session has expired', code: 190 } }]);
  const ownerToken = await login('owner@shop.test');
  const channel = ctx.db.prepare("SELECT * FROM channels WHERE platform = 'messenger' AND external_id = '111'").get();
  // A customer writes in on the connected Page, then the reply fails.
  ctx.db.prepare("INSERT INTO contacts (workspace_id, channel_id, external_id) VALUES (?, ?, 'PSID1')").run(channel.workspace_id, channel.id);
  const contact = ctx.db.prepare("SELECT id FROM contacts WHERE external_id = 'PSID1'").get();
  const conv = Number(ctx.db.prepare('INSERT INTO conversations (workspace_id, channel_id, contact_id, last_inbound_at) VALUES (?, ?, ?, ?)')
    .run(channel.workspace_id, channel.id, contact.id, new Date().toISOString()).lastInsertRowid);
  const reply = await call(`/api/conversations/${conv}/messages`, { method: 'POST', token: ownerToken, body: { text: 'hi' } });
  assert.equal(reply.data.status, 'failed');
  const sent = meta.calls.findLast((c) => c.path.endsWith('/me/messages'));
  assert.equal(sent.auth, 'Bearer PAGE1', 'the decrypted token is used');

  const channels = await call('/api/channels', { token: ownerToken });
  assert.equal(channels.data.find((c) => c.externalId === '111').needsReconnect, true);
  assert.ok(!JSON.stringify(channels.data).includes('enc:v1'), 'tokens are not exposed');
});

test('connects a WhatsApp Business app number and starts syncing its chats', async () => {
  meta.on('GET', /\/oauth\/access_token\?.*code=COEX/, () => [200, { access_token: 'COEXTOKEN' }]);
  meta.on('POST', /\/66666\/subscribed_apps/, () => [200, { success: true }]);
  meta.on('GET', /\/66666\/phone_numbers/, () => [200, { data: [{ id: '88888', display_phone_number: '+880 1700-000001' }] }]);
  meta.on('GET', /\/88888\?/, () => [200, { verified_name: 'Rupa Fashion', display_phone_number: '+880 1700-000001' }]);
  meta.on('POST', /\/88888\/smb_app_data/, () => [200, { messaging_product: 'whatsapp', request_id: 'r1' }]);

  const ownerToken = await login('owner@shop.test');
  const before = meta.calls.length;
  // Business app sign-ups report only the WhatsApp account; the number is looked up.
  const res = await call('/api/connect/whatsapp', { method: 'POST', token: ownerToken, body: { code: 'COEX', wabaId: '66666', coexistence: true } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.deepEqual(res.data.connected, ['Rupa Fashion · +880 1700-000001']);
  assert.equal(res.data.importing, true);
  assert.equal(res.data.pin, null, 'the number stays registered to the Business app');

  const calls = meta.calls.slice(before);
  assert.ok(!calls.some((c) => c.path.endsWith('/register')), 'does not re-register a Business app number');
  assert.deepEqual(calls.filter((c) => c.path.endsWith('/smb_app_data')).map((c) => c.body.sync_type), ['smb_app_state_sync', 'history']);
  const channel = ctx.db.prepare("SELECT * FROM channels WHERE external_id = '88888'").get();
  assert.equal(channel.import_status, 'running');
  assert.equal(channel.waba_id, '66666');

  const channels = await call('/api/channels', { token: ownerToken });
  const wa = channels.data.find((c) => c.externalId === '88888');
  assert.equal(wa.importStatus, 'running');
  assert.equal((await call(`/api/channels/${wa.id}/import`, { method: 'POST', token: ownerToken })).status, 400,
    'WhatsApp history can only be synced at connection');
});
