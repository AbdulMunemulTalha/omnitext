import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const PREFIX = 'enc:v1:';

// TOKEN_ENCRYPTION_KEY is 32 random bytes, as 64 hex characters or base64.
// Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
export function parseKey(raw) {
  if (!raw) return null;
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes (64 hex characters or base64)');
  return key;
}

// Encrypts access tokens before they go into the database. Without a key the
// value is stored as is, which is only acceptable for local development.
export function encryptSecret(plain, key) {
  if (!plain || !key) return plain ?? '';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return PREFIX + [iv, cipher.getAuthTag(), encrypted].map((b) => b.toString('base64url')).join('.');
}

// Values saved before encryption was turned on are returned unchanged.
export function decryptSecret(value, key) {
  if (!value || !value.startsWith(PREFIX)) return value ?? '';
  if (!key) throw new Error('TOKEN_ENCRYPTION_KEY is needed to read stored access tokens');
  const [iv, tag, encrypted] = value.slice(PREFIX.length).split('.').map((part) => Buffer.from(part, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
