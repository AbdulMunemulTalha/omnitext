import { nowIso } from './db.js';
import { InboxError } from './inbox.js';

export const ORDER_STATUSES = ['confirmed', 'shipped', 'delivered', 'cancelled', 'returned'];
export const PAYMENT_METHODS = ['cod', 'bkash', 'nagad', 'rocket', 'bank'];
const AREAS = ['inside_dhaka', 'outside_dhaka'];
const AREA_LABEL = { inside_dhaka: 'inside Dhaka', outside_dhaka: 'outside Dhaka' };

// Accepts 01711-111111, +8801711111111, 8801711111111 or 008801711111111 and
// returns the 11-digit local form couriers expect, or null if it isn't a BD mobile.
export function normalizeBdPhone(input) {
  let digits = String(input ?? '').replace(/[\s\-().]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('880')) digits = digits.slice(2);
  return /^01[3-9]\d{8}$/.test(digits) ? digits : null;
}

function wholeTaka(value, field) {
  const n = Number(value ?? 0);
  if (!Number.isInteger(n) || n < 0) throw new InboxError(400, `${field} must be a whole number of taka`);
  return n;
}

function text(value, field, { required = true, max = 500 } = {}) {
  const s = String(value ?? '').trim();
  if (required && !s) throw new InboxError(400, `${field} is required`);
  if (s.length > max) throw new InboxError(400, `${field} is too long`);
  return s;
}

// Validates form input and works out the money. deliveryCharge may be given to
// override the shop's default for the area (e.g. free delivery offers).
export function buildOrder(input, workspace) {
  const area = AREAS.includes(input?.area) ? input.area : null;
  if (!area) throw new InboxError(400, 'Choose inside or outside Dhaka');
  const phone = normalizeBdPhone(input.phone);
  if (!phone) throw new InboxError(400, 'Phone must be a Bangladeshi mobile number like 01711111111');
  const paymentMethod = input.paymentMethod ?? 'cod';
  if (!PAYMENT_METHODS.includes(paymentMethod)) throw new InboxError(400, 'Unknown payment method');

  if (!Array.isArray(input.items) || input.items.length === 0) throw new InboxError(400, 'Add at least one product');
  const items = input.items.map((item, i) => {
    const qty = wholeTaka(item?.qty ?? 1, `Quantity of item ${i + 1}`);
    if (qty < 1) throw new InboxError(400, `Quantity of item ${i + 1} must be at least 1`);
    return { name: text(item?.name, `Name of item ${i + 1}`, { max: 200 }), qty, price: wholeTaka(item?.price, `Price of item ${i + 1}`) };
  });

  const subtotal = items.reduce((sum, item) => sum + item.qty * item.price, 0);
  const deliveryCharge = input.deliveryCharge === undefined || input.deliveryCharge === null || input.deliveryCharge === ''
    ? workspace[area === 'inside_dhaka' ? 'delivery_inside_dhaka' : 'delivery_outside_dhaka']
    : wholeTaka(input.deliveryCharge, 'Delivery charge');
  const discount = wholeTaka(input.discount, 'Discount');
  const advancePaid = wholeTaka(input.advancePaid, 'Advance paid');
  const total = subtotal + deliveryCharge - discount;
  if (total < 0) throw new InboxError(400, 'Discount is larger than the order total');
  if (advancePaid > total) throw new InboxError(400, 'Advance paid is larger than the order total');

  return {
    customerName: text(input.customerName, 'Customer name', { max: 120 }),
    phone,
    address: text(input.address, 'Address'),
    area,
    items,
    subtotal,
    deliveryCharge,
    discount,
    advancePaid,
    codAmount: total - advancePaid,
    paymentMethod,
    note: text(input.note, 'Note', { required: false }),
  };
}

const taka = (n) => `৳${n.toLocaleString('en-IN')}`;

export function orderSummary(order) {
  const lines = [
    `Order #${order.id} confirmed ✅`,
    `${order.customer_name}, ${order.phone}`,
    order.address,
    '',
    ...order.items.map((item) => `${item.qty} × ${item.name} — ${taka(item.qty * item.price)}`),
    `Delivery (${AREA_LABEL[order.area]}): ${taka(order.delivery_charge)}`,
  ];
  if (order.discount) lines.push(`Discount: −${taka(order.discount)}`);
  if (order.advance_paid) lines.push(`Advance paid: −${taka(order.advance_paid)}`);
  lines.push(`Cash on delivery: ${taka(order.cod_amount)}`, '', 'Thank you for your order!');
  return lines.join('\n');
}

function csvCell(value) {
  if (typeof value === 'number') return String(value);
  let s = String(value ?? '');
  // Stop spreadsheet apps from running customer-typed text as a formula.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function ordersCsv(orders) {
  const header = ['order_id', 'created_at', 'status', 'customer_name', 'phone', 'address', 'area', 'items',
    'subtotal', 'delivery_charge', 'discount', 'advance_paid', 'cod_amount', 'payment_method', 'note'];
  const rows = orders.map((o) => [
    o.id, o.created_at, o.status, o.customer_name, o.phone, o.address, o.area,
    o.items.map((i) => `${i.qty} x ${i.name}`).join('; '),
    o.subtotal, o.delivery_charge, o.discount, o.advance_paid, o.cod_amount, o.payment_method, o.note,
  ]);
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

const orderRow = (row) => row && { ...row, items: JSON.parse(row.items) };

export function createOrders(db, inbox, { emit = () => {} } = {}) {
  const getOrder = (id) => orderRow(db.prepare(`
    SELECT o.*, u.name AS created_by_name FROM orders o LEFT JOIN users u ON u.id = o.created_by_user_id WHERE o.id = ?
  `).get(id));

  // Owners see every order; moderators see the ones they took and the ones on
  // customers they handle.
  function visibleTo(user, order) {
    if (!order || order.workspace_id !== user.workspace_id) return false;
    if (user.role === 'owner' || order.created_by_user_id === user.id) return true;
    const conversation = order.conversation_id && inbox.getConversation(order.conversation_id);
    return Boolean(conversation && conversation.assigned_user_id === user.id);
  }

  function publish(order) {
    emit(order.workspace_id, 'order', order);
    return order;
  }

  return {
    // Fills the order form from what we already know about the customer.
    draftFor(user, conversationId) {
      const conversation = inbox.getConversation(conversationId);
      if (!inbox.canAccess(user, conversation)) throw new InboxError(404, 'Conversation not found');
      const last = db.prepare('SELECT customer_name, phone, address, area FROM orders WHERE conversation_id = ? ORDER BY id DESC LIMIT 1')
        .get(conversationId);
      if (last) return { customerName: last.customer_name, phone: last.phone, address: last.address, area: last.area };
      return {
        customerName: conversation.contact_name ?? '',
        phone: conversation.platform === 'whatsapp' ? normalizeBdPhone(conversation.contact_external_id) ?? '' : '',
        address: '',
        area: 'inside_dhaka',
      };
    },

    async create(user, conversationId, input, { sendSummary = false } = {}) {
      const conversation = inbox.getConversation(conversationId);
      if (!inbox.canAccess(user, conversation)) throw new InboxError(404, 'Conversation not found');
      if (conversation.assigned_user_id && conversation.assigned_user_id !== user.id && user.role !== 'owner') {
        throw new InboxError(403, `This customer is handled by ${conversation.assigned_user_name}`);
      }
      const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(user.workspace_id);
      const o = buildOrder(input ?? {}, workspace);
      const { lastInsertRowid } = db.prepare(`
        INSERT INTO orders (workspace_id, conversation_id, created_by_user_id, customer_name, phone, address, area, items,
          subtotal, delivery_charge, discount, advance_paid, cod_amount, payment_method, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(user.workspace_id, conversationId, user.id, o.customerName, o.phone, o.address, o.area, JSON.stringify(o.items),
        o.subtotal, o.deliveryCharge, o.discount, o.advancePaid, o.codAmount, o.paymentMethod, o.note);
      const order = publish(getOrder(Number(lastInsertRowid)));

      // The order is saved even if Meta won't take the message (e.g. outside the 24h window).
      let summaryError = null;
      if (sendSummary) {
        try {
          const message = await inbox.sendReply(user, conversationId, orderSummary(order));
          if (message.status === 'failed') summaryError = message.error;
        } catch (err) {
          summaryError = err.message;
        }
      }
      return { order, summaryError };
    },

    list(user, { status, q } = {}) {
      const where = ['o.workspace_id = ?'];
      const params = [user.workspace_id];
      if (ORDER_STATUSES.includes(status)) { where.push('o.status = ?'); params.push(status); }
      if (q) {
        where.push("(o.customer_name LIKE ? ESCAPE '\\' OR o.phone LIKE ? ESCAPE '\\' OR CAST(o.id AS TEXT) = ?)");
        const like = `%${String(q).trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        params.push(like, like, String(q).trim().replace(/^#/, ''));
      }
      if (user.role !== 'owner') {
        where.push('(o.created_by_user_id = ? OR o.conversation_id IN (SELECT id FROM conversations WHERE assigned_user_id = ?))');
        params.push(user.id, user.id);
      }
      return db.prepare(`
        SELECT o.*, u.name AS created_by_name FROM orders o LEFT JOIN users u ON u.id = o.created_by_user_id
        WHERE ${where.join(' AND ')} ORDER BY o.id DESC LIMIT 500
      `).all(...params).map(orderRow);
    },

    forConversation(user, conversationId) {
      const conversation = inbox.getConversation(conversationId);
      if (!inbox.canAccess(user, conversation)) throw new InboxError(404, 'Conversation not found');
      return db.prepare(`
        SELECT o.*, u.name AS created_by_name FROM orders o LEFT JOIN users u ON u.id = o.created_by_user_id
        WHERE o.conversation_id = ? ORDER BY o.id DESC
      `).all(conversationId).map(orderRow);
    },

    update(user, orderId, { status, note } = {}) {
      const order = getOrder(orderId);
      if (!visibleTo(user, order)) throw new InboxError(404, 'Order not found');
      if (status !== undefined && !ORDER_STATUSES.includes(status)) throw new InboxError(400, 'Unknown order status');
      db.prepare('UPDATE orders SET status = COALESCE(?, status), note = COALESCE(?, note), updated_at = ? WHERE id = ?')
        .run(status ?? null, note === undefined ? null : text(note, 'Note', { required: false }), nowIso(), orderId);
      return publish(getOrder(orderId));
    },
  };
}
