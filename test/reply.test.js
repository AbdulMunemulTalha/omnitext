import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInbox } from '../src/inbox.js';
import { setup, inbound } from './helpers.js';

function fakeFetch(response, ok = true) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
    return { ok, status: ok ? 200 : 400, json: async () => response ?? { message_id: `mid.out.${calls.length}` } };
  };
  return { calls, fetchImpl };
}

test('only the assigned moderator (or owner) can reply', async () => {
  const { db, config, mods, owner, user } = setup();
  const { fetchImpl } = fakeFetch();
  const inbox = createInbox(db, config, { fetchImpl });
  const c = inbox.ingestMessage(inbound()).conversation;
  const other = mods.find((m) => m !== c.assigned_user_id);

  await assert.rejects(inbox.sendReply(user(other), c.id, 'hi'), (err) => err.status === 404);
  const sent = await inbox.sendReply(user(c.assigned_user_id), c.id, 'Dam 1200 taka');
  assert.equal(sent.status, 'sent');
  const byOwner = await inbox.sendReply(user(owner), c.id, 'Thanks!');
  assert.equal(byOwner.status, 'sent');
  assert.equal(inbox.getConversation(c.id).assigned_user_id, c.assigned_user_id, 'owner reply does not steal the customer');
});

test('replying to an unassigned customer claims them', async () => {
  const { db, config, mods, user } = setup({ online: false });
  const inbox = createInbox(db, config, { fetchImpl: fakeFetch().fetchImpl });
  const c = inbox.ingestMessage(inbound()).conversation;
  assert.equal(c.assigned_user_id, null);
  await inbox.sendReply(user(mods[1]), c.id, 'Hello!');
  assert.equal(inbox.getConversation(c.id).assigned_user_id, mods[1]);
  await assert.rejects(inbox.sendReply(user(mods[0]), c.id, 'me too'), (err) => err.status === 404);
});

test('sends through the channel the customer used', async () => {
  const { db, config, user } = setup();
  const { calls, fetchImpl } = fakeFetch({ messages: [{ id: 'wamid.out' }] });
  const inbox = createInbox(db, config, { fetchImpl });
  const c = inbox.ingestMessage(inbound({ platform: 'whatsapp', channelExternalId: 'WA1', contactExternalId: '8801711111111' })).conversation;
  const msg = await inbox.sendReply(user(c.assigned_user_id), c.id, 'Order confirmed');
  assert.equal(calls[0].url, 'https://graph.facebook.com/v23.0/WA1/messages');
  assert.equal(calls[0].auth, 'Bearer tok');
  assert.deepEqual(calls[0].body, {
    messaging_product: 'whatsapp', recipient_type: 'individual', to: '8801711111111', type: 'text', text: { body: 'Order confirmed' },
  });
  assert.equal(msg.external_id, 'wamid.out');

  // A later "read" receipt from WhatsApp updates the message.
  inbox.applyStatus({ messageId: 'wamid.out', status: 'read' });
  inbox.applyStatus({ messageId: 'wamid.out', status: 'delivered' });
  assert.equal(db.prepare("SELECT status FROM messages WHERE external_id = 'wamid.out'").get().status, 'read');
});

test('uses the HUMAN_AGENT tag on Messenger after 24 hours', async () => {
  const { db, config, user } = setup();
  const { calls, fetchImpl } = fakeFetch();
  const inbox = createInbox(db, config, { fetchImpl });
  const timestamp = new Date(Date.now() - 30 * 3_600_000).toISOString();
  const c = inbox.ingestMessage(inbound({ timestamp })).conversation;
  await inbox.sendReply(user(c.assigned_user_id), c.id, 'Sorry for the delay');
  assert.equal(calls[0].url, 'https://graph.facebook.com/v23.0/me/messages');
  assert.equal(calls[0].body.messaging_type, 'MESSAGE_TAG');
  assert.equal(calls[0].body.tag, 'HUMAN_AGENT');
});

test('blocks WhatsApp free-form replies after 24 hours', async () => {
  const { db, config, user } = setup();
  const { calls, fetchImpl } = fakeFetch();
  const inbox = createInbox(db, config, { fetchImpl });
  const timestamp = new Date(Date.now() - 25 * 3_600_000).toISOString();
  const c = inbox.ingestMessage(inbound({ platform: 'whatsapp', channelExternalId: 'WA1', timestamp })).conversation;
  await assert.rejects(inbox.sendReply(user(c.assigned_user_id), c.id, 'hi'), (err) => err.status === 422);
  assert.equal(calls.length, 0);
});

test('records Meta errors on the message instead of losing it', async () => {
  const { db, config, user } = setup();
  const { fetchImpl } = fakeFetch({ error: { message: 'Invalid OAuth access token' } }, false);
  const inbox = createInbox(db, config, { fetchImpl });
  const c = inbox.ingestMessage(inbound()).conversation;
  const msg = await inbox.sendReply(user(c.assigned_user_id), c.id, 'hi');
  assert.equal(msg.status, 'failed');
  assert.equal(msg.error, 'Invalid OAuth access token');
});
