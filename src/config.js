export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT || 3000),
    dbPath: env.DATABASE_PATH || 'data/omnitext.db',
    isProduction: env.NODE_ENV === 'production',
    // When true, replies are stored but never sent to Meta. Useful for local demos.
    dryRun: env.DRY_RUN === '1' || env.DRY_RUN === 'true',
    meta: {
      appId: env.META_APP_ID || '',
      appSecret: env.META_APP_SECRET || '',
      verifyToken: env.META_VERIFY_TOKEN || '',
      graphVersion: env.META_GRAPH_VERSION || 'v23.0',
    },
  };
}
