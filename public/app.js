const $ = (sel) => document.querySelector(sel);
const PLATFORM_LABEL = { messenger: 'Messenger', instagram: 'Instagram', whatsapp: 'WhatsApp' };

const state = {
  token: localStorage.getItem('omnitext_token'),
  me: null,
  team: [],
  filter: 'mine',
  status: 'open',
  conversations: new Map(),
  activeId: null,
  messages: [],
  socket: null,
  savedReplies: [],
  conversationOrders: [],
};

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && state.token) {
    signOut();
    throw new Error('Session expired');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

// WhatsApp IDs are phone numbers: 8801711111111 -> +880 1711-111111.
function formatPhone(waId) {
  const digits = String(waId).replace(/\D/g, '');
  const bd = /^880(1\d{3})(\d{6})$/.exec(digits);
  return bd ? `+880 ${bd[1]}-${bd[2]}` : `+${digits}`;
}

// How a customer is labelled in the list and chat header. Facebook and
// Instagram IDs mean nothing to people, so they are never shown.
function customerLabel(c) {
  if (c.platform === 'whatsapp') {
    return { title: formatPhone(c.contact_external_id), subtitle: c.contact_name || '' };
  }
  return { title: c.contact_name || `${PLATFORM_LABEL[c.platform]} customer`, subtitle: '' };
}

function timeLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString();
}

// ---- Auth ---------------------------------------------------------------

let signupMode = false;

function showAuth() {
  $('#app').hidden = true;
  $('#onboarding').hidden = true;
  $('#auth').hidden = false;
}

function setSignupMode(on) {
  signupMode = on;
  $('#signup-fields').hidden = !on;
  for (const input of $('#signup-fields').querySelectorAll('input')) input.required = on;
  $('#auth-submit').textContent = on ? 'Create account' : 'Sign in';
  $('#auth-toggle').textContent = on ? 'Already have an account? Sign in' : 'New business? Create an account';
}

$('#auth-toggle').addEventListener('click', () => setSignupMode(!signupMode));
// The landing page's "Start free" links to /app?signup=1.
if (new URLSearchParams(window.location.search).has('signup')) {
  setSignupMode(true);
  history.replaceState(null, '', window.location.pathname);
}

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  $('#auth-error').hidden = true;
  try {
    const { token } = await api(signupMode ? '/auth/signup' : '/auth/login', { method: 'POST', body });
    state.token = token;
    localStorage.setItem('omnitext_token', token);
    await start();
  } catch (err) {
    $('#auth-error').textContent = err.message;
    $('#auth-error').hidden = false;
  }
});

function signOut() {
  state.token = null;
  localStorage.removeItem('omnitext_token');
  state.socket?.disconnect();
  showAuth();
}

$('#logout').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  signOut();
});

// ---- Conversation list --------------------------------------------------

function visibleInList(c) {
  if (c.status !== state.status) return false;
  if (state.filter === 'mine') return c.assigned_user_id === state.me.user.id;
  if (state.filter === 'unassigned') return c.assigned_user_id === null;
  return true;
}

function renderList() {
  const items = [...state.conversations.values()]
    .filter(visibleInList)
    .sort((a, b) => (b.last_message_at || '').localeCompare(a.last_message_at || ''));
  const list = $('#conversation-list');
  list.replaceChildren(...items.map((c) => el('li', {
    class: c.id === state.activeId ? 'active' : '',
    onclick: () => openConversation(c.id),
  },
  el('div', { class: 'row' },
    el('span', { class: `badge ${c.platform}` }, PLATFORM_LABEL[c.platform]),
    el('span', { class: 'name' }, customerLabel(c).title,
      customerLabel(c).subtitle ? el('span', { class: 'muted name-extra' }, ` · ${customerLabel(c).subtitle}`) : null),
    c.unread_count ? el('span', { class: 'unread' }, String(c.unread_count)) : null,
    el('span', { class: 'muted small' }, timeLabel(c.last_message_at))),
  el('div', { class: 'preview' }, c.last_message_preview || ' '),
  state.filter !== 'mine'
    ? el('div', { class: 'muted small' }, c.assigned_user_name ? `Handled by ${c.assigned_user_name}` : 'Waiting for a moderator')
    : null)));
  if (!items.length) list.replaceChildren(el('li', { class: 'muted' }, 'No conversations here'));
}

// Open conversations nobody has picked up yet, shown as a count on the tab.
const waiting = new Set();

function renderWaitingCount() {
  const tab = $('#tabs button[data-filter=unassigned]');
  tab.replaceChildren('Unassigned', ...(waiting.size ? [el('span', { class: 'unread tab-count' }, String(waiting.size))] : []));
}

function trackWaiting(c) {
  if (c.status === 'open' && c.assigned_user_id === null) waiting.add(c.id);
  else waiting.delete(c.id);
  renderWaitingCount();
}

async function loadConversations() {
  const [rows, unassigned] = await Promise.all([
    api(`/conversations?filter=${state.filter}&status=${state.status}`),
    api('/conversations?filter=unassigned&status=open'),
  ]);
  state.conversations = new Map(rows.map((c) => [c.id, c]));
  waiting.clear();
  unassigned.forEach((c) => waiting.add(c.id));
  renderWaitingCount();
  renderList();
}

function selectTab(filter) {
  state.filter = filter;
  for (const b of $('#tabs').children) b.classList.toggle('active', b.dataset.filter === filter);
}

$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-filter]');
  if (!btn) return;
  selectTab(btn.dataset.filter);
  loadConversations();
});

$('#status-filter').addEventListener('change', (e) => {
  state.status = e.target.value;
  loadConversations();
});

// ---- Chat ---------------------------------------------------------------

function canReply(c) {
  return state.me.user.role === 'owner' || c.assigned_user_id === null || c.assigned_user_id === state.me.user.id;
}

function windowNotice(c) {
  if (!c.last_inbound_at) return 'The customer has not written yet, so Meta will not deliver a reply.';
  const hours = (Date.now() - new Date(c.last_inbound_at).getTime()) / 3_600_000;
  if (hours <= 24) return null;
  if (c.platform === 'whatsapp') return 'Over 24h since the customer wrote. WhatsApp only allows template messages now.';
  if (hours <= 24 * 7) return 'Over 24h since the customer wrote. Your reply is sent with the Human Agent tag (up to 7 days).';
  return 'Over 7 days since the customer wrote. Meta will not deliver a reply.';
}

function renderChatHeader() {
  const c = state.conversations.get(state.activeId);
  if (!c) return;
  const label = customerLabel(c);
  $('#chat-title').textContent = label.subtitle ? `${label.title} · ${label.subtitle}` : label.title;
  $('#chat-sub').textContent = `${PLATFORM_LABEL[c.platform]} · ${c.channel_name} · ${c.assigned_user_name ? `Handled by ${c.assigned_user_name}` : 'Unassigned'}`;
  $('#toggle-status').textContent = c.status === 'open' ? 'Mark done' : 'Reopen';

  const select = $('#assign-select');
  if (state.me.user.role === 'owner') {
    select.hidden = false;
    select.replaceChildren(
      el('option', { value: '' }, 'Unassigned'),
      ...state.team.filter((m) => m.isActive).map((m) => el('option', { value: String(m.id) }, `${m.name}${m.role === 'owner' ? ' (owner)' : ''}`)),
    );
    select.value = c.assigned_user_id ? String(c.assigned_user_id) : '';
  }

  const notices = [];
  if (!canReply(c)) notices.push(`${c.assigned_user_name} is handling this customer. Only they or the owner can reply.`);
  const w = windowNotice(c);
  if (w) notices.push(w);
  $('#chat-notice').textContent = notices.join(' ');
  $('#chat-notice').hidden = notices.length === 0;
  $('#composer').hidden = !canReply(c);
  $('#new-order').hidden = !canReply(c);
}

function bubble(m) {
  const sender = m.direction === 'out' && m.sender_user_id
    ? state.team.find((t) => t.id === m.sender_user_id)?.name
    : null;
  const statusText = m.direction === 'out' ? ` · ${m.status}${m.error ? `: ${m.error}` : ''}` : '';
  return el('div', { class: `bubble ${m.direction} ${m.status === 'failed' ? 'failed' : ''}` },
    m.text || null,
    ...m.attachments.map((a) => el('div', {}, a.url ? el('a', { href: a.url, target: '_blank', rel: 'noopener' }, `[${a.type}]`) : `[${a.type}]`)),
    el('div', { class: 'meta' }, `${sender ? `${sender} · ` : ''}${timeLabel(m.created_at)}${statusText}`));
}

function renderMessages() {
  const box = $('#messages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.replaceChildren(...state.messages.map(bubble));
  if (atBottom) box.scrollTop = box.scrollHeight;
}

async function openConversation(id) {
  state.activeId = id;
  $('#chat-empty').hidden = true;
  $('#chat-inner').hidden = false;
  renderList();
  renderChatHeader();
  state.messages = await api(`/conversations/${id}/messages`);
  renderMessages();
  $('#messages').scrollTop = $('#messages').scrollHeight;
  loadConversationOrders();
  const c = state.conversations.get(id);
  if (c?.unread_count && (c.assigned_user_id === state.me.user.id || state.me.user.role === 'owner')) {
    api(`/conversations/${id}/read`, { method: 'POST' }).catch(() => {});
  }
}

$('#composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#composer-text');
  const text = input.value.trim();
  if (!text || !state.activeId) return;
  input.value = '';
  try {
    await api(`/conversations/${state.activeId}/messages`, { method: 'POST', body: { text } });
  } catch (err) {
    input.value = text;
    alert(err.message);
  }
});

$('#composer-text').addEventListener('keydown', (e) => {
  if (pickerKeydown(e)) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});

$('#toggle-status').addEventListener('click', async () => {
  const c = state.conversations.get(state.activeId);
  try {
    await api(`/conversations/${c.id}/status`, { method: 'POST', body: { status: c.status === 'open' ? 'closed' : 'open' } });
  } catch (err) {
    alert(err.message);
  }
});

$('#assign-select').addEventListener('change', async (e) => {
  const userId = e.target.value ? Number(e.target.value) : null;
  try {
    await api(`/conversations/${state.activeId}/assign`, { method: 'POST', body: { userId } });
  } catch (err) {
    alert(err.message);
  }
});

// ---- Duty ---------------------------------------------------------------

$('#duty-toggle').addEventListener('change', async (e) => {
  try {
    const { assigned } = await api('/me/duty', { method: 'POST', body: { online: e.target.checked } });
    if (assigned) loadConversations();
    loadTeam();
  } catch (err) {
    e.target.checked = !e.target.checked;
    alert(err.message);
  }
});

// ---- Settings (owner) ---------------------------------------------------

async function loadTeam() {
  state.team = await api('/team');
  $('#team-table').replaceChildren(...state.team.map((m) => el('tr', {},
    el('td', {}, m.name),
    el('td', { class: 'muted' }, m.email),
    el('td', {}, m.role),
    el('td', {}, m.isActive ? (m.isOnline ? 'On duty' : 'Off duty') : 'Removed'),
    el('td', {}, `${m.openCount} open`),
    el('td', {}, m.role === 'moderator'
      ? el('button', {
        class: 'ghost',
        onclick: async () => {
          await api(`/team/${m.id}`, { method: 'PATCH', body: { isActive: !m.isActive } });
          await loadTeam();
          loadConversations();
        },
      }, m.isActive ? 'Remove' : 'Restore')
      : ''))));
}

async function loadChannels() {
  const channels = await api('/channels');
  $('#channel-table').replaceChildren(...channels.map((c) => el('tr', {},
    el('td', {}, el('span', { class: `badge ${c.platform}` }, PLATFORM_LABEL[c.platform])),
    el('td', {}, c.name),
    el('td', { class: 'muted' }, c.externalId),
    el('td', {}, c.needsReconnect
      ? el('span', { class: 'warn' }, 'Facebook access expired: connect again')
      : c.connected ? 'Live' : 'Test mode (no token)'),
    el('td', {}, el('button', {
      class: 'ghost',
      onclick: async () => {
        if (!confirm(`Disconnect ${c.name}? Its conversations will be deleted.`)) return;
        await api(`/channels/${c.id}`, { method: 'DELETE' });
        loadChannels();
        loadConversations();
      },
    }, 'Disconnect')))));
  $('#simulate-channel').replaceChildren(...channels.map((c) => el('option', { value: String(c.id) }, `${PLATFORM_LABEL[c.platform]} · ${c.name}`)));
}

function openSettings() {
  loadTeam();
  loadChannels();
  renderSavedReplies();
  const form = $('#delivery-form');
  form.deliveryInsideDhaka.value = state.me.workspace.deliveryInsideDhaka;
  form.deliveryOutsideDhaka.value = state.me.workspace.deliveryOutsideDhaka;
  const { facebook, whatsapp } = state.me.connect;
  $('#connect-facebook').hidden = !facebook;
  $('#connect-whatsapp').hidden = !whatsapp;
  $('#connect-unavailable').hidden = facebook && whatsapp;
  if (!$('#settings').open) $('#settings').showModal();
}

$('#open-settings').addEventListener('click', openSettings);

$('#add-member').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { user, password } = await api('/team', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    $('#member-result').textContent = `${user.name} can sign in with ${user.email} / ${password}`;
    e.target.reset();
    loadTeam();
  } catch (err) {
    alert(err.message);
  }
});

$('#add-channel').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/channels', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    e.target.reset();
    loadChannels();
  } catch (err) {
    alert(err.message);
  }
});

$('#simulate').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/dev/simulate', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
  } catch (err) {
    alert(err.message);
  }
});

// ---- Orders -------------------------------------------------------------

const STATUS_LABEL = { confirmed: 'Confirmed', shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled', returned: 'Returned' };
const taka = (n) => `৳${Number(n).toLocaleString('en-IN')}`;

async function loadConversationOrders() {
  const id = state.activeId;
  const { orders } = await api(`/conversations/${id}/orders`);
  if (id !== state.activeId) return;
  state.conversationOrders = orders;
  const strip = $('#order-strip');
  strip.hidden = orders.length === 0;
  strip.replaceChildren(el('span', { class: 'muted' }, 'Orders:'), ...orders.map((o) => el('span', { class: 'order-chip' },
    `#${o.id} · ${taka(o.cod_amount)} COD · `, el('span', { class: `status-${o.status}` }, STATUS_LABEL[o.status]))));
}

function itemRow(item = { name: '', qty: 1, price: '' }) {
  const row = el('div', { class: 'item-row' },
    el('input', { name: 'itemName', placeholder: 'e.g. Red kurti (M)', required: '' }),
    el('input', { name: 'itemQty', type: 'number', min: '1', step: '1', required: '' }),
    el('input', { name: 'itemPrice', type: 'number', min: '0', step: '1', required: '' }),
    el('button', { type: 'button', class: 'ghost', title: 'Remove', onclick: () => { row.remove(); renderTotals(); } }, '×'));
  row.querySelector('[name=itemName]').value = item.name;
  row.querySelector('[name=itemQty]').value = item.qty;
  row.querySelector('[name=itemPrice]').value = item.price;
  return row;
}

function readOrderForm() {
  const form = $('#order-form');
  const items = [...$('#order-items').children].map((row) => ({
    name: row.querySelector('[name=itemName]').value,
    qty: Number(row.querySelector('[name=itemQty]').value || 0),
    price: Number(row.querySelector('[name=itemPrice]').value || 0),
  }));
  return {
    customerName: form.customerName.value,
    phone: form.phone.value,
    address: form.address.value,
    area: form.area.value,
    paymentMethod: form.paymentMethod.value,
    items,
    deliveryCharge: form.deliveryCharge.value === '' ? null : Number(form.deliveryCharge.value),
    discount: Number(form.discount.value || 0),
    advancePaid: Number(form.advancePaid.value || 0),
    note: form.note.value,
    sendSummary: form.sendSummary.checked,
  };
}

function renderTotals() {
  const o = readOrderForm();
  const subtotal = o.items.reduce((sum, i) => sum + i.qty * i.price, 0);
  const delivery = o.deliveryCharge ?? 0;
  const cod = subtotal + delivery - o.discount - o.advancePaid;
  const line = (label, value, cls = '') => el('div', { class: `row ${cls}` }, el('span', {}, label), el('span', {}, value));
  $('#order-totals').replaceChildren(...[
    line('Products', taka(subtotal)),
    line('Delivery', taka(delivery)),
    o.discount ? line('Discount', `−${taka(o.discount)}`) : null,
    o.advancePaid ? line('Advance paid', `−${taka(o.advancePaid)}`) : null,
    line('Cash on delivery', cod < 0 ? '—' : taka(cod), 'cod'),
  ].filter(Boolean));
}

function defaultDelivery(area) {
  return area === 'inside_dhaka' ? state.me.workspace.deliveryInsideDhaka : state.me.workspace.deliveryOutsideDhaka;
}

$('#new-order').addEventListener('click', async () => {
  const { draft } = await api(`/conversations/${state.activeId}/orders`);
  const form = $('#order-form');
  form.reset();
  form.customerName.value = draft.customerName;
  form.phone.value = draft.phone;
  form.address.value = draft.address;
  form.area.value = draft.area;
  form.deliveryCharge.value = defaultDelivery(draft.area);
  $('#order-items').replaceChildren(itemRow());
  $('#order-error').hidden = true;
  renderTotals();
  $('#order-dialog').showModal();
  form.querySelector('[name=itemName]').focus();
});

$('#add-item').addEventListener('click', () => {
  $('#order-items').append(itemRow());
  renderTotals();
});

$('#order-form').addEventListener('input', renderTotals);

$('#order-form').area.addEventListener('change', (e) => {
  $('#order-form').deliveryCharge.value = defaultDelivery(e.target.value);
  renderTotals();
});

$('#order-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#order-error').hidden = true;
  const submit = e.target.querySelector('button[type=submit]');
  if (submit.disabled) return;
  submit.disabled = true;
  try {
    const { summaryError } = await api(`/conversations/${state.activeId}/orders`, { method: 'POST', body: readOrderForm() });
    $('#order-dialog').close();
    if (summaryError) alert(`Order saved, but the summary was not sent: ${summaryError}`);
  } catch (err) {
    $('#order-error').textContent = err.message;
    $('#order-error').hidden = false;
  } finally {
    submit.disabled = false;
  }
});

function orderQuery() {
  const params = new URLSearchParams();
  if ($('#orders-status').value) params.set('status', $('#orders-status').value);
  if ($('#orders-search').value.trim()) params.set('q', $('#orders-search').value.trim());
  return params.toString();
}

async function loadOrders() {
  const orders = await api(`/orders?${orderQuery()}`);
  const open = orders.filter((o) => o.status === 'confirmed' || o.status === 'shipped');
  $('#orders-summary').textContent = `${orders.length} orders · ${taka(open.reduce((s, o) => s + o.cod_amount, 0))} COD still to collect`;
  const head = el('tr', {}, ...['#', 'Date', 'Customer', 'Phone', 'Address', 'Products', 'COD', 'Taken by', 'Status']
    .map((h) => el('th', {}, h)));
  $('#orders-table').replaceChildren(head, ...orders.map((o) => {
    const status = el('select', {
      onchange: async (e) => {
        try {
          await api(`/orders/${o.id}`, { method: 'PATCH', body: { status: e.target.value } });
        } catch (err) {
          alert(err.message);
          loadOrders();
        }
      },
    }, ...Object.entries(STATUS_LABEL).map(([value, label]) => el('option', { value }, label)));
    status.value = o.status;
    return el('tr', {},
      el('td', {}, `#${o.id}`),
      el('td', { class: 'muted' }, timeLabel(o.created_at)),
      el('td', {}, o.customer_name),
      el('td', {}, o.phone),
      el('td', {}, `${o.address}${o.area === 'outside_dhaka' ? ' (outside Dhaka)' : ''}`),
      el('td', {}, o.items.map((i) => `${i.qty} × ${i.name}`).join(', ')),
      el('td', { class: 'num' }, taka(o.cod_amount)),
      el('td', { class: 'muted' }, o.created_by_name ?? ''),
      el('td', {}, status));
  }));
  if (!orders.length) $('#orders-table').append(el('tr', {}, el('td', { class: 'muted', colspan: '9' }, 'No orders yet')));
}

$('#open-orders').addEventListener('click', () => {
  loadOrders();
  $('#orders-dialog').showModal();
});
$('#orders-status').addEventListener('change', loadOrders);
let searchTimer;
$('#orders-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadOrders, 250);
});

$('#orders-export').addEventListener('click', async () => {
  const res = await fetch(`/api/orders.csv?${orderQuery()}`, { headers: { authorization: `Bearer ${state.token}` } });
  if (!res.ok) return alert('Export failed');
  const url = URL.createObjectURL(await res.blob());
  const a = el('a', { href: url, download: `orders-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

// ---- Saved replies ------------------------------------------------------

const picker = { matches: [], index: 0 };

async function loadSavedReplies() {
  state.savedReplies = await api('/saved-replies');
}

function renderPicker() {
  const list = $('#saved-picker');
  list.hidden = picker.matches.length === 0;
  list.replaceChildren(...picker.matches.map((r, i) => el('li', {
    class: i === picker.index ? 'active' : '',
    onmousedown: (e) => { e.preventDefault(); useSavedReply(r); },
  }, el('strong', {}, `/${r.shortcut}`), `  ${r.text}`)));
}

function useSavedReply(reply) {
  const input = $('#composer-text');
  input.value = reply.text;
  picker.matches = [];
  renderPicker();
  input.focus();
}

$('#composer-text').addEventListener('input', (e) => {
  const m = /^\/(\S*)$/.exec(e.target.value);
  picker.matches = m ? state.savedReplies.filter((r) => r.shortcut.startsWith(m[1].toLowerCase())).slice(0, 8) : [];
  picker.index = 0;
  renderPicker();
});

// Returns true when the key was used by the saved-reply picker.
function pickerKeydown(e) {
  if (!picker.matches.length) return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    picker.index = (picker.index + (e.key === 'ArrowDown' ? 1 : -1) + picker.matches.length) % picker.matches.length;
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    useSavedReply(picker.matches[picker.index]);
  } else if (e.key === 'Escape') {
    picker.matches = [];
  } else {
    return false;
  }
  e.preventDefault();
  renderPicker();
  return true;
}

function renderSavedReplies() {
  $('#saved-table').replaceChildren(...state.savedReplies.map((r) => el('tr', {},
    el('td', {}, el('code', {}, `/${r.shortcut}`)),
    el('td', {}, r.text),
    el('td', {}, el('button', {
      class: 'ghost',
      onclick: async () => {
        await api(`/saved-replies/${r.id}`, { method: 'DELETE' });
        await loadSavedReplies();
        renderSavedReplies();
      },
    }, 'Delete')))));
}

$('#add-saved').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/saved-replies', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    e.target.reset();
    await loadSavedReplies();
    renderSavedReplies();
  } catch (err) {
    alert(err.message);
  }
});

$('#delivery-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries([...new FormData(e.target)].map(([k, v]) => [k, Number(v)]));
  try {
    state.me.workspace = await api('/workspace', { method: 'PATCH', body });
  } catch (err) {
    alert(err.message);
  }
});

// ---- One-click channel connection ----------------------------------------

function showConnectResult({ connected = [], problems = [], pin = null }) {
  const parts = [];
  if (connected.length) parts.push(`Connected: ${connected.join(', ')}.`);
  if (pin) parts.push(`WhatsApp two-step verification PIN: ${pin}. Write it down; Meta asks for it if the number is moved.`);
  parts.push(...problems);
  for (const node of document.querySelectorAll('.js-connect-result')) {
    node.textContent = parts.join(' ');
    node.hidden = parts.length === 0;
  }
  if (inOnboarding()) renderOnboardingChannels();
  else loadChannels();
}

// Settings and onboarding share these buttons (by class).
async function connectFacebook(button) {
  button.disabled = true;
  try {
    const { url } = await api('/connect/facebook/start');
    window.location.assign(url);
  } catch (err) {
    button.disabled = false;
    alert(err.message);
  }
}

document.addEventListener('click', (e) => {
  const facebook = e.target.closest('.js-connect-facebook');
  if (facebook) connectFacebook(facebook);
  const whatsapp = e.target.closest('.js-connect-whatsapp');
  if (whatsapp) connectWhatsApp(whatsapp);
});

// Facebook sends the owner back to /?connect=<id> (or ?connect_error=...) after login.
async function resumeFacebookConnect() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('connect');
  const error = params.get('connect_error');
  if (!id && !error) return;
  history.replaceState(null, '', window.location.pathname);
  if (state.me.user.role !== 'owner') return;
  // During onboarding the picker opens over the wizard instead of Settings.
  if (!inOnboarding()) openSettings();
  if (error) {
    showConnectResult({ problems: [error] });
    return;
  }
  try {
    const pages = await api(`/connect/facebook/${encodeURIComponent(id)}`);
    $('#connect-form').dataset.id = id;
    $('#connect-error').hidden = true;
    $('#connect-pages').replaceChildren(...pages.map((p) => el('div', { class: 'connect-page' },
      el('strong', {}, p.name),
      el('label', {},
        el('input', { type: 'checkbox', name: 'messenger', value: p.id, ...(p.messengerConnected ? {} : { checked: '' }) }),
        el('span', { class: 'badge messenger' }, 'Messenger'), p.messengerConnected ? 'Already connected (reconnect)' : 'Page messages'),
      p.instagram
        ? el('label', {},
          el('input', { type: 'checkbox', name: 'instagram', value: p.instagram.id, ...(p.instagram.connected ? {} : { checked: '' }) }),
          el('span', { class: 'badge instagram' }, 'Instagram'),
          `${p.instagram.username ? `@${p.instagram.username}` : 'Linked account'}${p.instagram.connected ? ' · already connected (reconnect)' : ''}`)
        : el('span', { class: 'muted small' }, 'No Instagram account is linked to this Page.'))));
    $('#connect-dialog').showModal();
  } catch (err) {
    showConnectResult({ problems: [err.message] });
  }
}

$('#connect-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const picked = (name) => [...form.querySelectorAll(`input[name=${name}]:checked`)].map((i) => i.value);
  const submit = form.querySelector('button[type=submit]');
  submit.disabled = true;
  try {
    const result = await api(`/connect/facebook/${encodeURIComponent(form.dataset.id)}`, {
      method: 'POST', body: { messenger: picked('messenger'), instagram: picked('instagram') },
    });
    $('#connect-dialog').close();
    showConnectResult(result);
  } catch (err) {
    $('#connect-error').textContent = err.message;
    $('#connect-error').hidden = false;
  } finally {
    submit.disabled = false;
  }
});

// WhatsApp uses Meta's Embedded Signup popup from the Facebook JavaScript SDK.
function loadFacebookSdk() {
  if (window.FB) return Promise.resolve(window.FB);
  return new Promise((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB.init({ appId: state.me.connect.appId, autoLogAppEvents: true, xfbml: false, version: state.me.connect.graphVersion });
      resolve(window.FB);
    };
    const script = el('script', { src: 'https://connect.facebook.net/en_US/sdk.js', async: '', crossorigin: 'anonymous' });
    script.onerror = () => reject(new Error('Could not load Facebook. Check the internet connection or turn off ad blockers.'));
    document.body.append(script);
  });
}

let embeddedSignup = null;
window.addEventListener('message', (event) => {
  let host;
  try { host = new URL(event.origin).hostname; } catch { return; }
  if (host !== 'facebook.com' && !host.endsWith('.facebook.com')) return;
  let data;
  try { data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data; } catch { return; }
  if (data?.type !== 'WA_EMBEDDED_SIGNUP') return;
  embeddedSignup = { event: data.event, phoneNumberId: data.data?.phone_number_id, wabaId: data.data?.waba_id };
});

async function waitForSignupInfo() {
  for (let i = 0; i < 30 && !embeddedSignup; i += 1) await new Promise((r) => setTimeout(r, 100));
  return embeddedSignup;
}

async function finishWhatsApp(code) {
  const info = await waitForSignupInfo();
  if (!info || info.event !== 'FINISH' || !info.phoneNumberId) {
    showConnectResult({ problems: ['WhatsApp signup was not finished. Please choose or add a phone number and try again.'] });
    return;
  }
  try {
    showConnectResult(await api('/connect/whatsapp', {
      method: 'POST', body: { code, phoneNumberId: info.phoneNumberId, wabaId: info.wabaId },
    }));
  } catch (err) {
    showConnectResult({ problems: [err.message] });
  }
}

async function connectWhatsApp(button) {
  button.disabled = true;
  embeddedSignup = null;
  try {
    const FB = await loadFacebookSdk();
    FB.login((response) => {
      const code = response.authResponse?.code;
      const done = code ? finishWhatsApp(code) : Promise.resolve(showConnectResult({ problems: ['WhatsApp signup was cancelled.'] }));
      done.finally(() => { button.disabled = false; });
    }, {
      config_id: state.me.connect.whatsappConfigId,
      response_type: 'code',
      override_default_response_type: true,
      extras: { setup: {}, featureType: '', sessionInfoVersion: '3' },
    });
  } catch (err) {
    button.disabled = false;
    alert(err.message);
  }
}

// ---- Realtime -----------------------------------------------------------

function connectSocket() {
  state.socket?.disconnect();
  // eslint-disable-next-line no-undef
  state.socket = io({ auth: { token: state.token } });
  state.socket.on('conversation', (c) => {
    if (state.me.user.role !== 'owner' && c.assigned_user_id !== null && c.assigned_user_id !== state.me.user.id) {
      state.conversations.delete(c.id);
    } else {
      state.conversations.set(c.id, c);
    }
    trackWaiting(c);
    renderList();
    if (c.id === state.activeId) renderChatHeader();
  });
  state.socket.on('message', ({ conversationId, message }) => {
    if (conversationId !== state.activeId) return;
    const i = state.messages.findIndex((m) => m.id === message.id);
    if (i >= 0) state.messages[i] = message;
    else state.messages.push(message);
    renderMessages();
    const c = state.conversations.get(conversationId);
    if (message.direction === 'in' && !document.hidden && (c?.assigned_user_id === state.me.user.id || state.me.user.role === 'owner')) {
      api(`/conversations/${conversationId}/read`, { method: 'POST' }).catch(() => {});
    }
  });
  state.socket.on('channels', () => {
    if ($('#settings').open) loadChannels();
  });
  state.socket.on('order', (order) => {
    if (order.conversation_id === state.activeId) loadConversationOrders();
    if ($('#orders-dialog').open) loadOrders();
  });
  state.socket.on('connect', () => {
    if (state.me) loadConversations();
  });
}

// ---- Onboarding -----------------------------------------------------------

const ONB_STEPS = ['business', 'channels', 'team', 'done'];
const newPasswords = new Map(); // moderator id -> password shown once during onboarding

function inOnboarding() {
  return !$('#onboarding').hidden;
}

function showOnboarding(step) {
  $('#auth').hidden = true;
  $('#app').hidden = true;
  $('#onboarding').hidden = false;
  goToStep(ONB_STEPS.includes(step) ? step : 'business');
}

function goToStep(step) {
  const index = ONB_STEPS.indexOf(step);
  for (const li of $('#onb-steps').children) {
    const i = ONB_STEPS.indexOf(li.dataset.step);
    li.classList.toggle('current', i === index);
    li.classList.toggle('complete', i < index);
  }
  for (const panel of document.querySelectorAll('#onboarding [data-panel]')) panel.hidden = panel.dataset.panel !== step;
  if (step === 'business') fillBusinessForm();
  if (step === 'channels') {
    const { facebook, whatsapp } = state.me.connect;
    for (const b of document.querySelectorAll('#onboarding .js-connect-facebook')) b.hidden = !facebook;
    for (const b of document.querySelectorAll('#onboarding .js-connect-whatsapp')) b.hidden = !whatsapp;
    $('#onboarding .js-facebook-unavailable').hidden = facebook;
    $('#onboarding .js-whatsapp-unavailable').hidden = whatsapp;
    renderOnboardingChannels();
  }
  if (step === 'team') renderOnboardingTeam();
  if (step === 'done') renderOnboardingSummary();
  window.scrollTo(0, 0);
}

// Saves the step (and any fields) so a refresh or the Facebook redirect resumes here.
async function saveStep(step, fields = {}) {
  state.me.workspace = await api('/workspace', { method: 'PATCH', body: { ...fields, onboardingStep: step } });
  goToStep(step);
}

function fillBusinessForm() {
  const form = $('#onb-business');
  const ws = state.me.workspace;
  form.name.value = ws.name;
  form.phone.value = ws.phone;
  form.category.value = ws.category;
  form.deliveryInsideDhaka.value = ws.deliveryInsideDhaka;
  form.deliveryOutsideDhaka.value = ws.deliveryOutsideDhaka;
}

$('#onb-business').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const error = form.querySelector('.error');
  error.hidden = true;
  try {
    await saveStep('channels', {
      name: form.name.value,
      phone: form.phone.value,
      category: form.category.value,
      deliveryInsideDhaka: Number(form.deliveryInsideDhaka.value),
      deliveryOutsideDhaka: Number(form.deliveryOutsideDhaka.value),
    });
    $('#workspace-name').textContent = state.me.workspace.name;
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  }
});

async function renderOnboardingChannels() {
  const channels = await api('/channels');
  $('#onb-channel-list').replaceChildren(...channels.map((c) => el('li', {},
    el('span', { class: `badge ${c.platform}` }, PLATFORM_LABEL[c.platform]), ` ${c.name}`)));
  if (!channels.length) $('#onb-channel-list').append(el('li', { class: 'muted' }, 'Nothing connected yet.'));
  $('#onb-channels-next').hidden = channels.length === 0;
  $('#onb-channels-skip').hidden = channels.length > 0;
}

$('#onb-wa-manual').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { ...Object.fromEntries(new FormData(e.target)), platform: 'whatsapp' };
  try {
    const channel = await api('/channels', { method: 'POST', body });
    e.target.reset();
    showConnectResult({ connected: [channel.name] });
  } catch (err) {
    showConnectResult({ problems: [err.message] });
  }
});

async function renderOnboardingTeam() {
  const team = (await api('/team')).filter((m) => m.role === 'moderator' && m.isActive);
  $('#onb-team-list').replaceChildren(...team.map((m) => el('li', {},
    el('strong', {}, m.name), ` · ${m.email}`,
    newPasswords.has(m.id) ? el('span', { class: 'muted' }, ` · password: ${newPasswords.get(m.id)}`) : null)));
  if (!team.length) $('#onb-team-list').append(el('li', { class: 'muted' }, 'No moderators yet.'));
  $('#onb-team-next').textContent = team.length ? 'Continue' : 'Skip for now';
}

$('#onb-team-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#onb-team-error').hidden = true;
  try {
    const { user, password } = await api('/team', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    newPasswords.set(user.id, password);
    e.target.reset();
    renderOnboardingTeam();
  } catch (err) {
    $('#onb-team-error').textContent = err.message;
    $('#onb-team-error').hidden = false;
  }
});

async function renderOnboardingSummary() {
  const [channels, team] = await Promise.all([api('/channels'), api('/team')]);
  const moderators = team.filter((m) => m.role === 'moderator' && m.isActive);
  const item = (ok, text) => el('li', { class: ok ? 'ok' : 'todo' }, `${ok ? '✓' : '○'} ${text}`);
  $('#onb-summary').replaceChildren(
    item(true, `${state.me.workspace.name}: delivery ৳${state.me.workspace.deliveryInsideDhaka} inside Dhaka, ৳${state.me.workspace.deliveryOutsideDhaka} outside`),
    item(channels.length > 0, channels.length
      ? `Connected: ${channels.map((c) => `${PLATFORM_LABEL[c.platform]} (${c.name})`).join(', ')}`
      : 'No channels connected yet: connect them in Settings → Connected channels'),
    item(moderators.length > 0, moderators.length
      ? `${moderators.length} moderator${moderators.length > 1 ? 's' : ''}: ${moderators.map((m) => m.name).join(', ')}`
      : 'No moderators: you will answer every customer yourself'),
  );
}

// Back/Continue/Skip buttons carry the step they lead to.
$('#onboarding').addEventListener('click', (e) => {
  const button = e.target.closest('[data-goto]');
  if (button) saveStep(button.dataset.goto).catch((err) => alert(err.message));
});

$('#onb-finish').addEventListener('click', async () => {
  try {
    state.me.workspace = await api('/workspace', { method: 'PATCH', body: { onboardingStep: 'done' } });
    await enterApp();
  } catch (err) {
    alert(err.message);
  }
});

$('#onb-logout').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  signOut();
});

// ---- Boot ---------------------------------------------------------------

async function start() {
  state.me = await api('/me');
  if (state.me.user.role === 'owner' && state.me.workspace.onboardingStep !== 'done') {
    showOnboarding(state.me.workspace.onboardingStep);
    resumeFacebookConnect();
    return;
  }
  await enterApp();
}

async function enterApp() {
  const isOwner = state.me.user.role === 'owner';
  $('#auth').hidden = true;
  $('#onboarding').hidden = true;
  $('#app').hidden = false;
  $('#workspace-name').textContent = state.me.workspace.name;
  $('#me-name').textContent = `${state.me.user.name} (${state.me.user.role})`;
  $('#duty-toggle').checked = state.me.user.isOnline;
  $('#open-settings').hidden = !isOwner;
  $('#simulator').hidden = !(isOwner && state.me.devTools);
  document.querySelectorAll('[data-owner-only]').forEach((n) => { n.hidden = !isOwner; });
  // Owners oversee everything, and a shop without moderators has nothing under "Mine".
  selectTab(isOwner ? 'all' : 'mine');
  await loadTeam();
  await loadConversations();
  await loadSavedReplies();
  connectSocket();
  resumeFacebookConnect();
}

if (state.token) start().catch(showAuth);
else showAuth();
