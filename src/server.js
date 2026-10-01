import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';

const config = loadConfig();
const db = openDb(config.dbPath);
const { server } = createApp(db, config);

if (config.isProduction && !config.meta.appSecret) {
  console.warn('Warning: META_APP_SECRET is not set, webhooks will be rejected.');
}

server.listen(config.port, () => {
  console.log(`OmniText running on http://localhost:${config.port}${config.dryRun ? ' (dry run: replies are not sent to Meta)' : ''}`);
});
