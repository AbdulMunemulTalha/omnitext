import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';

const config = loadConfig();
const db = openDb(config.dbPath);
const { server, inbox } = createApp(db, config);

if (config.isProduction && !config.meta.appSecret) {
  console.warn('Warning: META_APP_SECRET is not set, webhooks will be rejected.');
}
if (config.isProduction && !config.tokenKey) {
  console.error('TOKEN_ENCRYPTION_KEY must be set in production so access tokens are stored encrypted.');
  process.exit(1);
}

server.listen(config.port, () => {
  inbox.fillMissingNames().catch((err) => console.warn('name backfill failed:', err.message));
  console.log(`Quicky running on http://localhost:${config.port}${config.dryRun ? ' (dry run: replies are not sent to Meta)' : ''}`);
});
