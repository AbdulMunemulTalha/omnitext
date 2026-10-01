import { openDb } from '../src/db.js';
import { hashPassword } from '../src/auth.js';
import { loadConfig } from '../src/config.js';

export function setup({ moderators = ['Nadia', 'Karim'], online = true, env = {} } = {}) {
  const db = openDb(':memory:');
  const config = loadConfig({ DATABASE_PATH: ':memory:', ...env });
  const ws = Number(db.prepare("INSERT INTO workspaces (name) VALUES ('Shop')").run().lastInsertRowid);
  const hash = hashPassword('password123');
  const addUser = db.prepare('INSERT INTO users (workspace_id, name, email, password_hash, role, is_online) VALUES (?, ?, ?, ?, ?, ?)');
  const owner = Number(addUser.run(ws, 'Owner', 'owner@shop.test', hash, 'owner', 1).lastInsertRowid);
  const mods = moderators.map((name) =>
    Number(addUser.run(ws, name, `${name.toLowerCase()}@shop.test`, hash, 'moderator', online ? 1 : 0).lastInsertRowid));
  const addChannel = db.prepare("INSERT INTO channels (workspace_id, platform, external_id, name, access_token) VALUES (?, ?, ?, ?, 'tok')");
  addChannel.run(ws, 'messenger', 'PAGE1', 'Page');
  addChannel.run(ws, 'instagram', 'IG1', 'Insta');
  addChannel.run(ws, 'whatsapp', 'WA1', 'WhatsApp');
  const user = (id) => db.prepare('SELECT id, workspace_id, name, email, role FROM users WHERE id = ?').get(id);
  return { db, config, ws, owner, mods, user };
}

let n = 0;
export function inbound(overrides = {}) {
  n += 1;
  return {
    platform: 'messenger',
    channelExternalId: 'PAGE1',
    contactExternalId: 'cust-1',
    contactName: null,
    direction: 'in',
    messageId: `m_${n}`,
    text: 'hello',
    attachments: [],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}
