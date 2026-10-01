import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/app.js';
import { setup } from './helpers.js';

let server;
let base;
let ctx;

before(async () => {
  ctx = setup({ env: { META_APP_SECRET: 'appsecret', META_VERIFY_TOKEN: 'verify-me', DRY_RUN: '1' } });
  ({ server } = createApp(ctx.db, ctx.config));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

async function call(path, { method = 'GET', body, token, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* plain text */ }
  return { status: res.status, data };
}

const login = async (email) => (await call('/api/auth/login', { method: 'POST', body: { email, password: 'password123' } })).data.token;

test('answers the Meta webhook verification challenge', async () => {
  const ok = await call('/webhooks/meta?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345');
  assert.equal(ok.status, 200);
  assert.equal(ok.data, 12345);
  const bad = await call('/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1');
  assert.equal(bad.status, 403);
});

test('rejects unsigned webhooks and routes signed ones to a moderator', async () => {
  const payload = JSON.stringify({
    object: 'page',
    entry: [{ id: 'PAGE1', messaging: [{ sender: { id: 'PSID9' }, recipient: { id: 'PAGE1' }, timestamp: Date.now(), message: { mid: 'mid.api', text: 'stock ache?' } }] }],
  });
  assert.equal((await call('/webhooks/meta', { method: 'POST', body: payload })).status, 401);

  const sig = `sha256=${createHmac('sha256', 'appsecret').update(payload).digest('hex')}`;
  const res = await call('/webhooks/meta', { method: 'POST', body: payload, headers: { 'x-hub-signature-256': sig } });
  assert.equal(res.status, 200);

  const tokens = await Promise.all(['nadia@shop.test', 'karim@shop.test'].map(login));
  const lists = await Promise.all(tokens.map((token) => call('/api/conversations?filter=mine', { token })));
  const owners = lists.map((l) => l.data.length);
  assert.deepEqual(owners.sort(), [0, 1], 'exactly one moderator gets the customer');

  const mine = lists.findIndex((l) => l.data.length === 1);
  const conversation = lists[mine].data[0];
  const reply = await call(`/api/conversations/${conversation.id}/messages`, { method: 'POST', token: tokens[mine], body: { text: 'Ji ache' } });
  assert.equal(reply.status, 201);
  assert.equal(reply.data.status, 'sent');
  const blocked = await call(`/api/conversations/${conversation.id}/messages`, { method: 'POST', token: tokens[1 - mine], body: { text: 'hi' } });
  assert.equal(blocked.status, 404);
});

test('owner can add moderators and remove them, releasing their customers', async () => {
  const ownerToken = await login('owner@shop.test');
  const created = await call('/api/team', { method: 'POST', token: ownerToken, body: { name: 'Rina', email: 'rina@shop.test', password: 'password123' } });
  assert.equal(created.status, 201);

  const modToken = await login('rina@shop.test');
  assert.equal((await call('/api/team', { method: 'POST', token: modToken, body: { name: 'X', email: 'x@shop.test' } })).status, 403);

  const all = await call('/api/conversations?filter=all', { token: ownerToken });
  const conversation = all.data[0];
  await call(`/api/conversations/${conversation.id}/assign`, { method: 'POST', token: ownerToken, body: { userId: created.data.user.id } });
  await call(`/api/team/${created.data.user.id}`, { method: 'PATCH', token: ownerToken, body: { isActive: false } });
  assert.equal(ctx.db.prepare('SELECT assigned_user_id FROM conversations WHERE id = ?').get(conversation.id).assigned_user_id, null);
  assert.equal((await call('/api/me', { token: modToken })).status, 401, 'removed moderator is signed out');
});
