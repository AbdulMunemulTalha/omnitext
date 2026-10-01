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
  $('#auth').hidden = false;
}

$('#auth-toggle').addEventListener('click', () => {
  signupMode = !signupMode;
  $('#signup-fields').hidden = !signupMode;
  $('#auth-submit').textContent = signupMode ? 'Create account' : 'Sign in';
  $('#auth-toggle').textContent = signupMode ? 'Already have an account? Sign in' : 'New business? Create an account';
});

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
    el('span', { class: 'name' }, c.contact_name || c.contact_external_id),
    c.unread_count ? el('span', { class: 'unread' }, String(c.unread_count)) : null,
    el('span', { class: 'muted small' }, timeLabel(c.last_message_at))),
  el('div', { class: 'preview' }, c.last_message_preview || ' '),
  state.filter !== 'mine'
    ? el('div', { class: 'muted small' }, c.assigned_user_name ? `Handled by ${c.assigned_user_name}` : 'Waiting for a moderator')
    : null)));
  if (!items.length) list.replaceChildren(el('li', { class: 'muted' }, 'No conversations here'));
}

async function loadConversations() {
  const rows = await api(`/conversations?filter=${state.filter}&status=${state.status}`);
  state.conversations = new Map(rows.map((c) => [c.id, c]));
  renderList();
}

$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-filter]');
  if (!btn) return;
  state.filter = btn.dataset.filter;
  for (const b of $('#tabs').children) b.classList.toggle('active', b === btn);
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
  $('#chat-title').textContent = c.contact_name || c.contact_external_id;
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
    el('td', {}, c.connected ? 'Live' : 'Test mode (no token)'),
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

$('#open-settings').addEventListener('click', () => {
  loadTeam();
  loadChannels();
  $('#settings').showModal();
});

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
  state.socket.on('connect', () => {
    if (state.me) loadConversations();
  });
}

// ---- Boot ---------------------------------------------------------------

async function start() {
  state.me = await api('/me');
  const isOwner = state.me.user.role === 'owner';
  $('#auth').hidden = true;
  $('#app').hidden = false;
  $('#workspace-name').textContent = state.me.workspace.name;
  $('#me-name').textContent = `${state.me.user.name} (${state.me.user.role})`;
  $('#duty-toggle').checked = state.me.user.isOnline;
  $('#open-settings').hidden = !isOwner;
  $('#simulator').hidden = !(isOwner && state.me.devTools);
  document.querySelectorAll('[data-owner-only]').forEach((n) => { n.hidden = !isOwner; });
  await loadTeam();
  await loadConversations();
  connectSocket();
}

if (state.token) start().catch(showAuth);
else showAuth();
