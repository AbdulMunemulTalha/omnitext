import { parseKey } from './secrets.js';

export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT || 3000),
    dbPath: env.DATABASE_PATH || 'data/omnitext.db',
    isProduction: env.NODE_ENV === 'production',
    // When true, replies are stored but never sent to Meta. Useful for local demos.
    dryRun: env.DRY_RUN === '1' || env.DRY_RUN === 'true',
    // Public https address of this server, used for the Facebook login redirect.
    // Falls back to the address the request came in on.
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    tokenKey: parseKey(env.TOKEN_ENCRYPTION_KEY),
    meta: {
      appId: env.META_APP_ID || '',
      appSecret: env.META_APP_SECRET || '',
      verifyToken: env.META_VERIFY_TOKEN || '',
      graphVersion: env.META_GRAPH_VERSION || 'v23.0',
      // Facebook Login for Business configuration (Messenger + Instagram permissions).
      loginConfigId: env.META_LOGIN_CONFIG_ID || '',
      // WhatsApp Embedded Signup configuration.
      whatsappConfigId: env.META_WHATSAPP_CONFIG_ID || '',
    },
  };
}
