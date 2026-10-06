import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { parseWebhook } from '../src/platforms/meta.js';
import { createInbox } from '../src/inbox.js';
import { createImporter, graphTime, toThread } from '../src/importer.js';
import { createApp } from '../src/app.js';
import { setup, inbound } from './helpers.js';

const HOUR = 3_600_000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const graph = (msAgo) => iso(msAgo).replace(/\.\d+Z$/, '+0000');

test('parses Graph timestamps with +0000 offsets', () => {
  assert.equal(graphTime('2026-10-03T10:15:35+0000'), '2026-10-03T10:15:35.000Z');
  assert.equal(graphTime('2026-10-03T16:15:35+0600'), '2026-10-03T10:15:35.000Z');
});

test('parses WhatsApp Business app history, contacts and echoes', () => {
  const wrap = (field, value) => ({
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA', changes: [{ field, value: { metadata: { display_phone_number: '8801700000000', phone_number_id: 'WA1' }, ...value } }] }],
  });
  const history = parseWebhook(wrap('history', {
    history: [{
      metadata: { phase: 1, chunk_order: 1, progress: 100 },
      threads: [{
        id: '8801711111111',
        messages: [
          { from: '8801711111111', id: 'wamid.a', timestamp: '1767225600', type: 'text', text: { body: 'dam koto?' } },
          { from: '8801700000000', to: '8801711111111', id: 'wamid.b', timestamp: '1767225660', type: 'text', text: { body: '1200 taka' } },
          { from: '8801711111111', id: 'wamid.c', timestamp: '1767225700', type: 'media_placeholder' },
        ],
      }],
    }],
  })).history;
  assert.equal(history.length, 1);
  assert.equal(history[0].progress, 100);
  const [thread] = history[0].threads;
  assert.equal(thread.contactExternalId, '8801711111111');
  assert.deepEqual(thread.messages.map((m) => [m.direction, m.text]), [['in', 'dam koto?'], ['out', '1200 taka'], ['in', '']]);
  assert.deepEqual(thread.messages[2].attachments, [{ type: 'media', mediaId: null }]);

  const declined = parseWebhook(wrap('history', { history: [{ errors: [{ code: 2593109, message: 'History sync is turned off by the business' }] }] })).history;
  assert.deepEqual(declined, [{ platform: 'whatsapp', channelExternalId: 'WA1', declined: true, error: 'History sync is turned off by the business' }]);

  const echoes = parseWebhook(wrap('smb_message_echoes', {
    message_echoes: [{ from: '8801700000000', to: '8801722222222', id: 'wamid.e', timestamp: '1767225600', type: 'text', text: { body: 'sent from phone' } }],
  })).messages;
  assert.deepEqual([echoes[0].direction, echoes[0].contactExternalId, echoes[0].text], ['out', '8801722222222', 'sent from phone']);

  const contacts = parseWebhook(wrap('smb_app_state_sync', {
    state_sync: [
      { type: 'contact', action: 'add', contact: { full_name: 'Sumi Apu', first_name: 'Sumi', phone_number: '+880 1711-111111' } },
      { type: 'contact', action: 'remove', contact: { full_name: 'Gone', phone_number: '8801799999999' } },
    ],
  })).contacts;
  assert.deepEqual(contacts, [{ platform: 'whatsapp', channelExternalId: 'WA1', contactExternalId: '8801711111111', name: 'Sumi Apu' }]);
});

test('imported history is filed sensibly and never duplicated', () => {
  const { db, config } = setup({ online: true });
  const inbox = createInbox(db, config);
  const channel = db.prepare("SELECT id FROM channels WHERE platform = 'messenger'").get().id;
  const msg = (id, direction, msAgo, text = id) => ({ messageId: id, direction, text, attachments: [], timestamp: iso(msAgo) });
  const threads = [
    { contactExternalId: 'waiting', contactName: 'Waiting Customer', messages: [msg('w1', 'out', 3 * HOUR), msg('w2', 'in', 2 * HOUR)] },
    { contactExternalId: 'answered', contactName: 'Answered', messages: [msg('a1', 'in', 5 * HOUR), msg('a2', 'out', 4 * HOUR)] },
    { contactExternalId: 'old', contactName: 'Old Customer', messages: [msg('o1', 'in', 30 * 24 * HOUR)] },
  ];
  assert.deepEqual(inbox.importHistory(channel, threads), { conversations: 3, messages: 5 });
  const rows = Object.fromEntries(db.prepare(`SELECT ct.external_id, ct.name, c.status, c.assigned_user_id, c.last_message_preview, c.last_inbound_at
    FROM conversations c JOIN contacts ct ON ct.id = c.contact_id`).all().map((r) => [r.external_id, r]));
  assert.equal(rows.waiting.status, 'open', 'a recent unanswered customer stays open');
  assert.notEqual(rows.waiting.assigned_user_id, null, 'and is given to a moderator');
  assert.equal(rows.waiting.last_message_preview, 'w2');
  assert.equal(rows.answered.status, 'closed');
  assert.equal(rows.old.status, 'closed');
  assert.equal(rows.old.name, 'Old Customer');
  // Every chat shows in the inbox list; there is no separate "closed" list.
  const owner = db.prepare("SELECT * FROM users WHERE role = 'owner'").get();
  assert.equal(inbox.listConversations(owner, { filter: 'all' }).length, 3);
  assert.equal(inbox.listConversations(owner, { filter: 'unassigned' }).length, 2);

  // Importing again, or the same message arriving live, adds nothing.
  assert.deepEqual(inbox.importHistory(channel, threads), { conversations: 3, messages: 0 });
  assert.deepEqual(inbox.ingestMessage(inbound({ contactExternalId: 'waiting', messageId: 'w2' })), { ignored: 'duplicate' });
  // A new live message lands in the same conversation, with the same moderator.
  const live = inbox.ingestMessage(inbound({ contactExternalId: 'waiting', messageId: 'w3' })).conversation;
  assert.equal(live.assigned_user_id, rows.waiting.assigned_user_id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 6);
});

test('imports past Messenger and Instagram conversations from the Conversations API', async () => {
  const { db, config } = setup();
  db.prepare("UPDATE channels SET page_id = 'PAGE1' WHERE platform = 'instagram'").run();
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(`${u.pathname}?platform=${u.searchParams.get('platform')}&after=${u.searchParams.get('after')}`);
    const platform = u.searchParams.get('platform');
    let data;
    if (platform === 'messenger' && !u.searchParams.get('after')) {
      data = {
        data: [{
          updated_time: graph(HOUR),
          participants: { data: [{ id: 'PSID1', name: 'Rahim Uddin' }, { id: 'PAGE1', name: 'Shop' }] },
          messages: { data: [
            { id: 'm_2', message: 'Ji ache', from: { id: 'PAGE1' }, created_time: graph(HOUR) },
            { id: 'm_1', message: 'Stock ache?', from: { id: 'PSID1' }, created_time: graph(2 * HOUR),
              attachments: { data: [{ mime_type: 'image/jpeg', image_data: { url: 'https://cdn/x.jpg' } }] } },
          ] },
        }],
        paging: { next: `https://graph.facebook.com/v23.0/PAGE1/conversations?platform=messenger&after=abc` },
      };
    } else if (platform === 'messenger') {
      data = { data: [{ updated_time: graph(400 * 24 * HOUR), participants: { data: [{ id: 'ANCIENT' }, { id: 'PAGE1' }] }, messages: { data: [] } }],
        paging: { next: 'https://graph.facebook.com/v23.0/PAGE1/conversations?platform=messenger&after=never' } };
    } else {
      data = { data: [{
        updated_time: graph(HOUR),
        participants: { data: [{ id: 'IG1', username: 'shop' }, { id: 'IGSID9', username: 'tania.shop' }] },
        messages: { data: [{ id: 'ig_1', message: 'Size L?', from: { id: 'IGSID9' }, created_time: graph(HOUR) }] },
      }] };
    }
    return { ok: true, status: 200, json: async () => data };
  };
  const inbox = createInbox(db, config, { fetchImpl });
  const importer = createImporter(db, config, inbox, { fetchImpl });
  const channelId = (p) => db.prepare('SELECT id FROM channels WHERE platform = ?').get(p).id;

  await importer.start(channelId('messenger'));
  await importer.start(channelId('instagram'));
  assert.ok(!calls.some((c) => c.includes('after=never')), 'stops paging once conversations are older than the cutoff');
  assert.ok(calls.some((c) => c.startsWith('/v23.0/PAGE1/conversations?platform=instagram')), 'Instagram is read through its Page');

  const msgs = db.prepare(`SELECT ct.name, m.direction, m.text, m.attachments FROM messages m
    JOIN conversations c ON c.id = m.conversation_id JOIN contacts ct ON ct.id = c.contact_id ORDER BY m.created_at`).all();
  assert.deepEqual(msgs.map((m) => [m.name, m.direction, m.text]), [
    ['Rahim Uddin', 'in', 'Stock ache?'],
    ['Rahim Uddin', 'out', 'Ji ache'],
    ['@tania.shop', 'in', 'Size L?'],
  ]);
  assert.deepEqual(JSON.parse(msgs[0].attachments), [{ type: 'image', url: 'https://cdn/x.jpg' }]);
  const status = db.prepare('SELECT import_status, import_count FROM channels WHERE platform = ?').get('messenger');
  assert.deepEqual({ ...status }, { import_status: 'done', import_count: 1 });

  assert.equal(toThread({ participants: { data: [{ id: 'PAGE1' }] }, messages: { data: [] } },
    { platform: 'messenger', businessId: 'PAGE1', channelExternalId: 'PAGE1' }), null, 'skips threads without a customer');
});

test('an import failure is reported on the channel', async () => {
  const { db, config } = setup();
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: '(#200) Requires pages_read_engagement' } }) });
  const inbox = createInbox(db, config, { fetchImpl });
  const importer = createImporter(db, config, inbox, { fetchImpl });
  const id = db.prepare("SELECT id FROM channels WHERE platform = 'messenger'").get().id;
  await importer.start(id);
  const row = db.prepare('SELECT import_status, import_error FROM channels WHERE id = ?').get(id);
  assert.equal(row.import_status, 'failed');
  assert.match(row.import_error, /pages_read_engagement/);
});

test('WhatsApp history and contact webhooks fill the inbox', async () => {
  const ctx = setup({ env: { META_APP_SECRET: 'appsecret' } });
  const { server } = createApp(ctx.db, ctx.config);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => {
    const raw = JSON.stringify(body);
    return fetch(`${base}/webhooks/meta`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', 'appsecret').update(raw).digest('hex')}` },
      body: raw,
    });
  };
  const wrap = (field, value) => ({ object: 'whatsapp_business_account',
    entry: [{ id: 'W', changes: [{ field, value: { metadata: { display_phone_number: '8801700000000', phone_number_id: 'WA1' }, ...value } }] }] });
  try {
    ctx.db.prepare("UPDATE channels SET import_status = 'running' WHERE platform = 'whatsapp'").run();
    assert.equal((await post(wrap('smb_app_state_sync', { state_sync: [{ action: 'add', contact: { full_name: 'Sumi Apu', phone_number: '8801711111111' } }] }))).status, 200);
    assert.equal((await post(wrap('history', { history: [{ metadata: { progress: 100 }, threads: [{ id: '8801711111111', messages: [
      { from: '8801711111111', id: 'wamid.h1', timestamp: String(Math.floor(Date.now() / 1000) - 3600), type: 'text', text: { body: 'order dibo' } },
    ] }] }] }))).status, 200);
    await new Promise((r) => setTimeout(r, 50));
    const row = ctx.db.prepare(`SELECT ct.name, c.status FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
      WHERE ct.external_id = '8801711111111'`).get();
    assert.deepEqual({ ...row }, { name: 'Sumi Apu', status: 'open' });
    assert.equal(ctx.db.prepare("SELECT import_status FROM channels WHERE platform = 'whatsapp'").get().import_status, 'done');

    await post(wrap('history', { history: [{ errors: [{ message: 'History sync is turned off by the business' }] }] }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(ctx.db.prepare("SELECT import_status FROM channels WHERE platform = 'whatsapp'").get().import_status, 'declined');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
