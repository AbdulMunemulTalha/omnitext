import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { setup } from './helpers.js';

let server;
let base;

before(async () => {
  const ctx = setup();
  ({ server } = createApp(ctx.db, ctx.config));
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
  try { data = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, data, type: res.headers.get('content-type') };
}

test('serves the landing page at / and the app at /app', async () => {
  const landing = await call('/');
  assert.equal(landing.status, 200);
  assert.match(landing.data, /Get started/);
  const app = await call('/app');
  assert.equal(app.status, 200);
  assert.match(app.data, /id="onboarding"/);
});

test('a new shop starts onboarding and walks through the steps', async () => {
  const signup = await call('/api/auth/signup', {
    method: 'POST', body: { businessName: 'Rupa Fashion', name: 'Rupa', email: 'rupa@shop.test', password: 'password123' },
  });
  const token = signup.data.token;
  const me = await call('/api/me', { token });
  assert.equal(me.data.workspace.onboardingStep, 'business');

  const bad = [
    [{ phone: '12345' }, /Bangladeshi mobile/],
    [{ category: 'weapons' }, /what you sell/],
    [{ onboardingStep: 'launch' }, /Unknown onboarding step/],
    [{ name: '  ' }, /Business name/],
    [{ deliveryInsideDhaka: -5 }, /whole number/],
  ];
  for (const [body, message] of bad) {
    const res = await call('/api/workspace', { method: 'PATCH', token, body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(res.data.error, message);
  }

  const saved = await call('/api/workspace', {
    method: 'PATCH', token,
    body: { name: 'Rupa Fashion House', phone: '+880 1711-111111', category: 'fashion', deliveryInsideDhaka: 60, deliveryOutsideDhaka: 120, onboardingStep: 'channels' },
  });
  assert.deepEqual(
    { ...saved.data, id: undefined },
    { id: undefined, name: 'Rupa Fashion House', phone: '01711111111', category: 'fashion', onboardingStep: 'channels', deliveryInsideDhaka: 60, deliveryOutsideDhaka: 120 },
  );

  await call('/api/team', { method: 'POST', token, body: { name: 'Mim', email: 'mim@shop.test', password: 'password123' } });
  const login = await call('/api/auth/login', { method: 'POST', body: { email: 'mim@shop.test', password: 'password123' } });
  assert.equal((await call('/api/workspace', { method: 'PATCH', token: login.data.token, body: { onboardingStep: 'done' } })).status, 403,
    'moderators cannot change onboarding');

  const done = await call('/api/workspace', { method: 'PATCH', token, body: { onboardingStep: 'done' } });
  assert.equal(done.data.onboardingStep, 'done');
});

test('shops created before onboarding existed are treated as set up', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { openDb } = await import('../src/db.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'omnitext-'));
  try {
    const old = new DatabaseSync(join(dir, 'old.db'));
    old.exec("CREATE TABLE workspaces (id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT ''); INSERT INTO workspaces (name) VALUES ('Old shop');");
    old.close();
    const db = openDb(join(dir, 'old.db'));
    assert.equal(db.prepare('SELECT onboarding_step FROM workspaces').get().onboarding_step, 'done');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
