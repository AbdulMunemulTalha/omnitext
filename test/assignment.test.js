import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInbox } from '../src/inbox.js';
import { setup, inbound } from './helpers.js';

test('new customers are spread across on-duty moderators', () => {
  const { db, config, mods } = setup();
  const inbox = createInbox(db, config);
  const a = inbox.ingestMessage(inbound({ contactExternalId: 'c1' })).conversation;
  const b = inbox.ingestMessage(inbound({ contactExternalId: 'c2' })).conversation;
  const c = inbox.ingestMessage(inbound({ contactExternalId: 'c3', platform: 'whatsapp', channelExternalId: 'WA1' })).conversation;
  assert.deepEqual([a.assigned_user_id, b.assigned_user_id].sort(), [...mods].sort());
  assert.ok(mods.includes(c.assigned_user_id));
});

test('a returning customer always goes back to the same moderator', () => {
  const { db, config, owner, user } = setup();
  const inbox = createInbox(db, config);
  const first = inbox.ingestMessage(inbound({ contactExternalId: 'rahim' })).conversation;
  // Lots of other customers arrive in the meantime.
  for (let i = 0; i < 5; i += 1) inbox.ingestMessage(inbound({ contactExternalId: `other-${i}` }));
  const again = inbox.ingestMessage(inbound({ contactExternalId: 'rahim', text: 'size M please' })).conversation;
  assert.equal(again.id, first.id);
  assert.equal(again.assigned_user_id, first.assigned_user_id);

  // Even after the order is marked done, a new message reopens it with the same moderator.
  inbox.setStatus(user(owner), first.id, 'closed');
  const reopened = inbox.ingestMessage(inbound({ contactExternalId: 'rahim', text: 'payment done' })).conversation;
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.assigned_user_id, first.assigned_user_id);
});

test('nobody on duty leaves customers waiting until someone clocks in', () => {
  const { db, config, mods, user } = setup({ online: false });
  const inbox = createInbox(db, config);
  const c1 = inbox.ingestMessage(inbound({ contactExternalId: 'c1' })).conversation;
  const c2 = inbox.ingestMessage(inbound({ contactExternalId: 'c2' })).conversation;
  assert.equal(c1.assigned_user_id, null);
  assert.equal(c2.assigned_user_id, null);

  assert.equal(inbox.setOnDuty(user(mods[0]), true), 2);
  assert.equal(inbox.getConversation(c1.id).assigned_user_id, mods[0]);
  assert.equal(inbox.getConversation(c2.id).assigned_user_id, mods[0]);
});

test('webhook retries and unknown pages are ignored', () => {
  const { db, config } = setup();
  const inbox = createInbox(db, config);
  const evt = inbound();
  inbox.ingestMessage(evt);
  assert.deepEqual(inbox.ingestMessage(evt), { ignored: 'duplicate' });
  assert.deepEqual(inbox.ingestMessage(inbound({ channelExternalId: 'OTHER' })), { ignored: 'unknown_channel' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
});

test('moderators only see their own and unassigned customers', () => {
  const { db, config, mods, owner, user } = setup();
  const inbox = createInbox(db, config);
  inbox.ingestMessage(inbound({ contactExternalId: 'c1' }));
  inbox.ingestMessage(inbound({ contactExternalId: 'c2' }));
  const [m1, m2] = mods.map(user);
  assert.equal(inbox.listConversations(m1, { filter: 'mine' }).length, 1);
  assert.equal(inbox.listConversations(m1, { filter: 'all' }).length, 1, 'moderators cannot list everything');
  assert.equal(inbox.listConversations(user(owner), { filter: 'all' }).length, 2);
  const theirs = inbox.listConversations(m2, { filter: 'mine' })[0];
  assert.throws(() => inbox.listMessages(m1, theirs.id), /not found/);
});
