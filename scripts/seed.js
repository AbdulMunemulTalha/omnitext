// Creates a demo business with an owner, two moderators and three test channels.
import { loadConfig } from '../src/config.js';
import { openDb, transaction } from '../src/db.js';
import { hashPassword } from '../src/auth.js';

const config = loadConfig();
const db = openDb(config.dbPath);

if (db.prepare('SELECT 1 FROM users WHERE email = ?').get('owner@demo.test')) {
  console.log('Demo data already exists.');
  process.exit(0);
}

const PASSWORD = 'password123';

transaction(db, () => {
  const ws = Number(db.prepare('INSERT INTO workspaces (name) VALUES (?)').run('Demo Fashion House').lastInsertRowid);
  const addUser = db.prepare('INSERT INTO users (workspace_id, name, email, password_hash, role, is_online) VALUES (?, ?, ?, ?, ?, ?)');
  addUser.run(ws, 'Owner', 'owner@demo.test', hashPassword(PASSWORD), 'owner', 1);
  addUser.run(ws, 'Nadia', 'nadia@demo.test', hashPassword(PASSWORD), 'moderator', 1);
  addUser.run(ws, 'Karim', 'karim@demo.test', hashPassword(PASSWORD), 'moderator', 1);
  const addChannel = db.prepare('INSERT INTO channels (workspace_id, platform, external_id, name) VALUES (?, ?, ?, ?)');
  addChannel.run(ws, 'messenger', 'demo-page', 'Demo Fashion House Page');
  addChannel.run(ws, 'instagram', 'demo-ig', '@demofashionhouse');
  addChannel.run(ws, 'whatsapp', 'demo-wa', '+880 1700-000000');
});

console.log(`Demo data created. Sign in as owner@demo.test, nadia@demo.test or karim@demo.test with "${PASSWORD}".`);
