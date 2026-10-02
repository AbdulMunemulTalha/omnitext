import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInbox } from '../src/inbox.js';
import { createOrders, buildOrder, normalizeBdPhone, orderSummary, ordersCsv } from '../src/orders.js';
import { setup, inbound } from './helpers.js';

const WORKSPACE = { delivery_inside_dhaka: 70, delivery_outside_dhaka: 130 };
const baseOrder = {
  customerName: 'Rahim', phone: '01711111111', address: 'House 5, Road 3, Dhanmondi', area: 'inside_dhaka',
  items: [{ name: 'Red kurti (M)', qty: 2, price: 650 }],
};

test('normalizes Bangladeshi mobile numbers', () => {
  for (const input of ['01711111111', '017-1111-1111', '+8801711111111', '8801711111111', '008801711111111', '+880 1711 111111']) {
    assert.equal(normalizeBdPhone(input), '01711111111', input);
  }
  for (const input of ['01211111111', '0171111111', '12345', '', null]) {
    assert.equal(normalizeBdPhone(input), null, String(input));
  }
});

test('works out delivery and cash on delivery', () => {
  const inside = buildOrder(baseOrder, WORKSPACE);
  assert.equal(inside.subtotal, 1300);
  assert.equal(inside.deliveryCharge, 70);
  assert.equal(inside.codAmount, 1370);

  const outside = buildOrder({ ...baseOrder, area: 'outside_dhaka', discount: 100, advancePaid: 200 }, WORKSPACE);
  assert.equal(outside.deliveryCharge, 130);
  assert.equal(outside.codAmount, 1300 + 130 - 100 - 200);

  const freeDelivery = buildOrder({ ...baseOrder, deliveryCharge: 0 }, WORKSPACE);
  assert.equal(freeDelivery.codAmount, 1300);
});

test('rejects orders that do not add up', () => {
  assert.throws(() => buildOrder({ ...baseOrder, phone: '12345' }, WORKSPACE), /Bangladeshi mobile/);
  assert.throws(() => buildOrder({ ...baseOrder, items: [] }, WORKSPACE), /at least one product/);
  assert.throws(() => buildOrder({ ...baseOrder, items: [{ name: 'x', qty: 1, price: 10.5 }] }, WORKSPACE), /whole number/);
  assert.throws(() => buildOrder({ ...baseOrder, items: [{ name: 'x', qty: 0, price: 10 }] }, WORKSPACE), /at least 1/);
  assert.throws(() => buildOrder({ ...baseOrder, advancePaid: 5000 }, WORKSPACE), /Advance paid/);
  assert.throws(() => buildOrder({ ...baseOrder, area: 'mars' }, WORKSPACE), /inside or outside Dhaka/);
  assert.throws(() => buildOrder({ ...baseOrder, address: '  ' }, WORKSPACE), /Address is required/);
});

test('summary message lists products and the amount to collect', () => {
  const summary = orderSummary({
    id: 7, customer_name: 'Rahim', phone: '01711111111', address: 'Dhanmondi', area: 'outside_dhaka',
    items: [{ name: 'Panjabi', qty: 1, price: 120000 }], delivery_charge: 130, discount: 0, advance_paid: 200, cod_amount: 119930,
  });
  assert.match(summary, /Order #7 confirmed/);
  assert.match(summary, /1 × Panjabi — ৳1,20,000/);
  assert.match(summary, /Delivery \(outside Dhaka\): ৳130/);
  assert.match(summary, /Advance paid: −৳200/);
  assert.match(summary, /Cash on delivery: ৳1,19,930/);
  assert.doesNotMatch(summary, /Discount/);
});

test('CSV export escapes commas and blocks spreadsheet formulas', () => {
  const csv = ordersCsv([{
    id: 1, created_at: '2026-10-01T10:00:00.000Z', status: 'confirmed', customer_name: '=HYPERLINK("x")', phone: '01711111111',
    address: 'House 5, Road 3', area: 'inside_dhaka', items: [{ name: 'Kurti', qty: 2, price: 650 }],
    subtotal: 1300, delivery_charge: 70, discount: 0, advance_paid: 0, cod_amount: 1370, payment_method: 'cod', note: '',
  }]);
  const [header, row] = csv.split('\r\n');
  assert.ok(header.startsWith('order_id,created_at,status,customer_name'));
  assert.ok(row.includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(row.includes('"House 5, Road 3"'));
  assert.ok(row.includes('2 x Kurti'));
});

function fakeFetch() {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ message_id: `mid.${calls.length}` }) };
    },
  };
}

test('moderator takes an order and the customer gets the summary on the same app', async () => {
  const { db, config, mods, owner, user } = setup();
  const { calls, fetchImpl } = fakeFetch();
  const inbox = createInbox(db, config, { fetchImpl });
  const orders = createOrders(db, inbox);
  const c = inbox.ingestMessage(inbound({ platform: 'whatsapp', channelExternalId: 'WA1', contactExternalId: '8801711111111', contactName: 'Sumi' })).conversation;
  const mod = user(c.assigned_user_id);

  assert.deepEqual(orders.draftFor(mod, c.id), { customerName: 'Sumi', phone: '01711111111', address: '', area: 'inside_dhaka' });

  const { order, summaryError } = await orders.create(mod, c.id, { ...baseOrder, customerName: 'Sumi' }, { sendSummary: true });
  assert.equal(summaryError, null);
  assert.equal(order.cod_amount, 1370);
  assert.equal(order.created_by_name, mod.name);
  assert.match(calls[0].text.body, /Order #\d+ confirmed/);

  // Next time the form remembers the address.
  assert.equal(orders.draftFor(mod, c.id).address, baseOrder.address);

  const other = user(mods.find((m) => m !== mod.id));
  await assert.rejects(orders.create(other, c.id, baseOrder), (err) => err.status === 404);
  assert.equal(orders.list(other).length, 0);
  assert.throws(() => orders.update(other, order.id, { status: 'shipped' }), /not found/);

  assert.equal(orders.list(mod).length, 1);
  assert.equal(orders.update(mod, order.id, { status: 'shipped' }).status, 'shipped');
  assert.equal(orders.list(user(owner), { status: 'shipped' }).length, 1);
  assert.equal(orders.list(user(owner), { q: '0171111' }).length, 1);
  assert.equal(orders.list(user(owner), { q: `#${order.id}` }).length, 1);
  assert.equal(orders.list(user(owner), { q: 'nobody' }).length, 0);
});

test('order is kept even when the summary cannot be sent', async () => {
  const { db, config, user } = setup();
  const { calls, fetchImpl } = fakeFetch();
  const inbox = createInbox(db, config, { fetchImpl });
  const orders = createOrders(db, inbox);
  const timestamp = new Date(Date.now() - 30 * 3_600_000).toISOString();
  const c = inbox.ingestMessage(inbound({ platform: 'whatsapp', channelExternalId: 'WA1', timestamp })).conversation;
  const { order, summaryError } = await orders.create(user(c.assigned_user_id), c.id, baseOrder, { sendSummary: true });
  assert.ok(order.id);
  assert.match(summaryError, /24 hours/);
  assert.equal(calls.length, 0);
});
