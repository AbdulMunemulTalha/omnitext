import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInbox } from '../src/inbox.js';
import { setup, inbound } from './helpers.js';

function profileApi(answers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, fields: u.searchParams.get('fields'), auth: init.headers.authorization });
    const [status, body] = answers(u);
    return { ok: status < 400, status, json: async () => body };
  };
  return { calls, fetchImpl };
}

test('looks up a Messenger customer name from their profile', async () => {
  const { db, config } = setup();
  const api = profileApi(() => [200, { first_name: 'Rahim', last_name: 'Uddin' }]);
  const inbox = createInbox(db, config, { fetchImpl: api.fetchImpl });
  const result = inbox.ingestMessage(inbound({ contactExternalId: '2468' }));
  assert.equal(result.conversation.contact_name, null, 'webhook is answered before the lookup');
  assert.equal(await result.nameLookup, 'Rahim Uddin');
  assert.equal(inbox.getConversation(result.conversation.id).contact_name, 'Rahim Uddin');
  assert.deepEqual(api.calls[0], { path: '/v23.0/2468', fields: 'first_name,last_name', auth: 'Bearer tok' });

  // Known customers are not looked up again.
  const again = inbox.ingestMessage(inbound({ contactExternalId: '2468' }));
  await again.nameLookup;
  assert.equal(api.calls.length, 1);
});

test('uses the Instagram name, or the username when there is no name', async () => {
  const { db, config } = setup();
  const api = profileApi((u) => [200, u.pathname.endsWith('/ig-1') ? { name: 'Tania Akter' } : { username: 'tania.shop' }]);
  const inbox = createInbox(db, config, { fetchImpl: api.fetchImpl });
  const a = inbox.ingestMessage(inbound({ platform: 'instagram', channelExternalId: 'IG1', contactExternalId: 'ig-1' }));
  const b = inbox.ingestMessage(inbound({ platform: 'instagram', channelExternalId: 'IG1', contactExternalId: 'ig-2' }));
  assert.equal(await a.nameLookup, 'Tania Akter');
  assert.equal(await b.nameLookup, '@tania.shop');
  assert.equal(api.calls[0].fields, 'name,username');
});

test('a failed lookup does not break the inbox and is not retried straight away', async () => {
  const { db, config } = setup();
  const api = profileApi(() => [400, { error: { message: 'No profile access', code: 10 } }]);
  const inbox = createInbox(db, config, { fetchImpl: api.fetchImpl });
  const first = inbox.ingestMessage(inbound({ contactExternalId: '1357' }));
  assert.equal(await first.nameLookup, null);
  await inbox.ingestMessage(inbound({ contactExternalId: '1357' })).nameLookup;
  assert.equal(api.calls.length, 1);
});

test('WhatsApp names come from the webhook, so nothing is looked up', async () => {
  const { db, config } = setup();
  const api = profileApi(() => [500, {}]);
  const inbox = createInbox(db, config, { fetchImpl: api.fetchImpl });
  const r = inbox.ingestMessage(inbound({ platform: 'whatsapp', channelExternalId: 'WA1', contactExternalId: '8801711111111', contactName: 'Sumi' }));
  await r.nameLookup;
  assert.equal(api.calls.length, 0);
  assert.equal(r.conversation.contact_name, 'Sumi');
});

test('fills in names for customers saved before lookups existed', async () => {
  const { db, config } = setup();
  const offline = createInbox(db, { ...config, dryRun: true });
  offline.ingestMessage(inbound({ contactExternalId: 'old-1' }));
  offline.ingestMessage(inbound({ contactExternalId: 'old-2' }));
  const api = profileApi((u) => [200, { first_name: u.pathname.endsWith('old-1') ? 'Karim' : 'Nadia' }]);
  await createInbox(db, config, { fetchImpl: api.fetchImpl }).fillMissingNames();
  assert.deepEqual(db.prepare('SELECT name FROM contacts ORDER BY external_id').all().map((r) => r.name), ['Karim', 'Nadia']);
});
