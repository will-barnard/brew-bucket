const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

module.exports = {
  port: num(process.env.PORT, 3001),
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),

  db: {
    host: process.env.DB_HOST || 'postgres',
    port: num(process.env.DB_PORT, 5432),
    database: process.env.DB_NAME || 'brewbucket',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
  },

  // Session cookies for the web UI. Rotating this logs everyone out.
  sessionSecret: process.env.SESSION_SECRET || '',
  sessionTtlHours: num(process.env.SESSION_TTL_HOURS, 24 * 14),
  cookieName: process.env.COOKIE_NAME || 'brew_bucket_session',
  cookieDomain: process.env.COOKIE_DOMAIN || undefined,
  // Off only for local http development; Beachhead always terminates TLS.
  cookieSecure: bool(process.env.COOKIE_SECURE, true),

  // Shared with every storage node. The node rejects anything else.
  nodeSecret: process.env.NODE_SHARED_SECRET || '',
  // Signs presigned direct-to-NAS URLs. Nodes verify with the same value.
  directSecret: process.env.DIRECT_URL_SECRET || process.env.NODE_SHARED_SECRET || '',
  directTtlSeconds: num(process.env.DIRECT_URL_TTL_SECONDS, 300),

  maxObjectBytes: num(process.env.MAX_OBJECT_BYTES, 5 * 1024 * 1024 * 1024),
  nodeTimeoutMs: num(process.env.NODE_TIMEOUT_MS, 30000),
  heartbeatIntervalMs: num(process.env.HEARTBEAT_INTERVAL_MS, 60000),
  retentionIntervalMs: num(process.env.RETENTION_INTERVAL_MS, 60 * 60 * 1000),

  // Buckets created automatically on first boot.
  seedBuckets: (process.env.SEED_BUCKETS || 'uploads,backups,artifacts')
    .split(',').map((s) => s.trim()).filter(Boolean),

  gitEnabled: bool(process.env.BREW_BUCKET_GIT, false),
  corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  trustProxy: bool(process.env.TRUST_PROXY, true),
};
