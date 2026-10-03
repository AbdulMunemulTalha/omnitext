import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'moderator')),
  is_active INTEGER NOT NULL DEFAULT 1,
  is_online INTEGER NOT NULL DEFAULT 0,
  last_assigned_at TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

-- A connected Facebook Page, Instagram professional account or WhatsApp number.
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('messenger', 'instagram', 'whatsapp')),
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  access_token TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT ${NOW},
  UNIQUE (platform, external_id)
);

-- A customer as seen by one channel (PSID, IGSID or WhatsApp wa_id).
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  name TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  UNIQUE (channel_id, external_id)
);

-- One long-lived thread per contact. The assignee sticks across sessions.
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL UNIQUE REFERENCES contacts(id) ON DELETE CASCADE,
  assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  unread_count INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT,
  last_message_preview TEXT NOT NULL DEFAULT '',
  last_inbound_at TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX IF NOT EXISTS conversations_by_workspace ON conversations(workspace_id, status, last_message_at);
CREATE INDEX IF NOT EXISTS conversations_by_assignee ON conversations(assigned_user_id, status);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  sender_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  text TEXT NOT NULL DEFAULT '',
  attachments TEXT NOT NULL DEFAULT '[]',
  external_id TEXT,
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('pending', 'sent', 'delivered', 'read', 'failed', 'received')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE UNIQUE INDEX IF NOT EXISTS messages_by_external_id ON messages(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages(conversation_id, id);

-- Amounts are whole taka. items is JSON: [{ "name", "qty", "price" }].
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  address TEXT NOT NULL,
  area TEXT NOT NULL CHECK (area IN ('inside_dhaka', 'outside_dhaka')),
  items TEXT NOT NULL,
  subtotal INTEGER NOT NULL,
  delivery_charge INTEGER NOT NULL,
  discount INTEGER NOT NULL DEFAULT 0,
  advance_paid INTEGER NOT NULL DEFAULT 0,
  cod_amount INTEGER NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'cod' CHECK (payment_method IN ('cod', 'bkash', 'nagad', 'rocket', 'bank')),
  status TEXT NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('confirmed', 'shipped', 'delivered', 'cancelled', 'returned')),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT ${NOW},
  updated_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX IF NOT EXISTS orders_by_workspace ON orders(workspace_id, status, id);
CREATE INDEX IF NOT EXISTS orders_by_conversation ON orders(conversation_id);

-- Ties a Facebook login redirect back to the owner who started it.
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Pages found after a Facebook login, waiting for the owner to pick which to
-- connect. payload holds page tokens, so it is encrypted like channel tokens.
CREATE TABLE IF NOT EXISTS pending_connections (
  id TEXT PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  payload TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS saved_replies (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  shortcut TEXT NOT NULL,
  text TEXT NOT NULL,
  UNIQUE (workspace_id, shortcut)
);
`;

// Columns added after the first release. CREATE TABLE IF NOT EXISTS does not
// touch existing tables, so older databases get them here.
const ADDED_COLUMNS = [
  ['workspaces', 'delivery_inside_dhaka', 'INTEGER NOT NULL DEFAULT 70'],
  ['workspaces', 'delivery_outside_dhaka', 'INTEGER NOT NULL DEFAULT 130'],
  // Set when Meta rejects the stored token, so the owner knows to reconnect.
  ['channels', 'needs_reconnect', 'INTEGER NOT NULL DEFAULT 0'],
  ['channels', 'waba_id', 'TEXT'],
  // Onboarding. Shops that existed before onboarding are treated as set up.
  ['workspaces', 'phone', "TEXT NOT NULL DEFAULT ''"],
  ['workspaces', 'category', "TEXT NOT NULL DEFAULT ''"],
  ['workspaces', 'onboarding_step', "TEXT NOT NULL DEFAULT 'done'"],
];

function addMissingColumns(db) {
  for (const [table, column, definition] of ADDED_COLUMNS) {
    const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  addMissingColumns(db);
  return db;
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function nowIso() {
  return new Date().toISOString();
}
