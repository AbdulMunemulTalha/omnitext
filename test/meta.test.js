import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { parseWebhook, verifySignature, messagingWindow } from '../src/platforms/meta.js';

test('parses Messenger messages and skips echoes of our own replies', () => {
  const { messages } = parseWebhook({
    object: 'page',
    entry: [{
      id: 'PAGE1',
      messaging: [
        { sender: { id: 'PSID1' }, recipient: { id: 'PAGE1' }, timestamp: 1767225600000, message: { mid: 'mid.1', text: 'price?' } },
        { sender: { id: 'PAGE1' }, recipient: { id: 'PSID1' }, timestamp: 1767225601000, message: { mid: 'mid.2', text: 'ours', is_echo: true, app_id: 42 } },
        { sender: { id: 'PAGE1' }, recipient: { id: 'PSID1' }, timestamp: 1767225602000, message: { mid: 'mid.3', text: 'from phone', is_echo: true, app_id: 99 } },
        { sender: { id: 'PSID1' }, recipient: { id: 'PAGE1' }, timestamp: 1767225603000, read: { watermark: 1 } },
      ],
    }],
  }, { appId: '42' });
  assert.equal(messages.length, 2);
  assert.deepEqual(
    { platform: messages[0].platform, contact: messages[0].contactExternalId, text: messages[0].text, dir: messages[0].direction },
    { platform: 'messenger', contact: 'PSID1', text: 'price?', dir: 'in' },
  );
  assert.equal(messages[0].timestamp, '2026-01-01T00:00:00.000Z');
  assert.equal(messages[1].direction, 'out');
  assert.equal(messages[1].contactExternalId, 'PSID1');
});

test('parses Instagram attachments', () => {
  const { messages } = parseWebhook({
    object: 'instagram',
    entry: [{ id: 'IG1', messaging: [{ sender: { id: 'IGSID' }, recipient: { id: 'IG1' }, timestamp: 1, message: { mid: 'ig.1', attachments: [{ type: 'image', payload: { url: 'https://cdn/x.jpg' } }] } }] }],
  });
  assert.equal(messages[0].platform, 'instagram');
  assert.deepEqual(messages[0].attachments, [{ type: 'image', url: 'https://cdn/x.jpg' }]);
});

test('parses WhatsApp messages, names and delivery statuses', () => {
  const { messages, statuses } = parseWebhook({
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA',
      changes: [{
        field: 'messages',
        value: {
          metadata: { phone_number_id: 'WA1' },
          contacts: [{ wa_id: '8801711111111', profile: { name: 'Sumi' } }],
          messages: [
            { from: '8801711111111', id: 'wamid.1', timestamp: '1767225600', type: 'text', text: { body: 'order dibo' } },
            { from: '8801711111111', id: 'wamid.2', timestamp: '1767225601', type: 'image', image: { id: 'MEDIA1', caption: 'ei ta' } },
          ],
          statuses: [{ id: 'wamid.out', status: 'read' }],
        },
      }],
    }],
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].contactName, 'Sumi');
  assert.equal(messages[0].channelExternalId, 'WA1');
  assert.equal(messages[0].timestamp, '2026-01-01T00:00:00.000Z');
  assert.equal(messages[1].text, 'ei ta');
  assert.deepEqual(messages[1].attachments, [{ type: 'image', mediaId: 'MEDIA1' }]);
  assert.deepEqual(statuses, [{ platform: 'whatsapp', messageId: 'wamid.out', status: 'read', error: null }]);
});

test('verifies X-Hub-Signature-256', () => {
  const body = Buffer.from('{"a":1}');
  const sig = `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`;
  assert.equal(verifySignature(body, sig, 'secret'), true);
  assert.equal(verifySignature(body, sig, 'other'), false);
  assert.equal(verifySignature(body, 'sha256=abc', 'secret'), false);
  assert.equal(verifySignature(body, undefined, 'secret'), false);
});

test('enforces Meta messaging windows', () => {
  const now = Date.parse('2026-01-10T00:00:00Z');
  const hoursAgo = (h) => new Date(now - h * 3_600_000).toISOString();
  assert.deepEqual(messagingWindow('whatsapp', hoursAgo(2), now), { ok: true, tag: null });
  assert.equal(messagingWindow('whatsapp', hoursAgo(25), now).ok, false);
  assert.deepEqual(messagingWindow('messenger', hoursAgo(30), now), { ok: true, tag: 'HUMAN_AGENT' });
  assert.equal(messagingWindow('instagram', hoursAgo(24 * 8), now).ok, false);
  assert.equal(messagingWindow('messenger', null, now).ok, false);
});
