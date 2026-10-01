import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { nowIso } from './db.js';

const SESSION_DAYS = 30;

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

export function createSession(db, userId) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expiresAt);
  return token;
}

export function deleteSession(db, token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function userForToken(db, token) {
  if (!token) return null;
  return db.prepare(`
    SELECT u.id, u.workspace_id, u.name, u.email, u.role, u.is_online
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ? AND u.is_active = 1
  `).get(token, nowIso()) ?? null;
}

export function bearerToken(req) {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

export function requireAuth(db) {
  return (req, res, next) => {
    const user = userForToken(db, bearerToken(req));
    if (!user) return res.status(401).json({ error: 'Not signed in' });
    req.user = user;
    next();
  };
}

export function requireOwner(req, res, next) {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only the business owner can do this' });
  next();
}
