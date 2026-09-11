const express = require('express');
const cookieParser = require('cookie-parser');
const config = require('./config');
const db = require('./db/pool');
const { migrate } = require('./db/migrate');
const authMw = require('./middleware/auth');
const errors = require('./middleware/error');
const nodes = require('./services/nodes');
const retention = require('./services/retention');

const app = express();
if (config.trustProxy) app.set('trust proxy', true);
app.disable('x-powered-by');

// Health first and cheap: Beachhead polls it over HTTPS after every deploy and
// a health check that touches the database turns a slow query into a failed
// deploy. It reports process liveness, nothing more.
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'brew-bucket', version: require('../package.json').version }));

// Readiness is the one that talks to postgres, and it is not what gates deploys.
app.get('/readyz', async (_req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

if (config.corsOrigins.length) {
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin && (config.corsOrigins.includes('*') || config.corsOrigins.includes(origin))) {
      res.set('access-control-allow-origin', origin);
      res.set('vary', 'Origin');
      res.set('access-control-allow-credentials', 'true');
      res.set('access-control-allow-headers', 'content-type,x-api-key,authorization,x-content-sha256');
      res.set('access-control-allow-methods', 'GET,PUT,POST,DELETE,HEAD,OPTIONS');
      res.set('access-control-expose-headers', 'etag,x-object-version,content-range');
      if (req.method === 'OPTIONS') return res.status(204).end();
    }
    next();
  });
}

app.use(cookieParser());
// JSON parsing is mounted per-route, never globally: a global body parser would
// swallow the upload stream that /o/* pipes straight to the NAS.
const json = express.json({ limit: '1mb' });

app.use(authMw.identify);

app.use('/api/v1/auth', json, require('./routes/auth'));
app.use('/api/v1/users', json, require('./routes/users'));
app.use('/api/v1/buckets', json, require('./routes/buckets'));
app.use('/api/v1/keys', json, require('./routes/keys'));
app.use('/api/v1/nodes', json, require('./routes/nodes'));
app.use('/api/v1/activity', json, require('./routes/activity'));

const share = require('./routes/share');
app.use('/api/v1/shares', json, share.api);
app.use('/', share.public);

app.use('/git', json, require('./routes/git'));

// Object routes last and without the JSON parser. /b/:bucket/o/* is the hot path.
app.use('/api/v1/b', require('./routes/objects'));

app.use(errors.notFound);
app.use(errors.handler);

// --- first boot -------------------------------------------------------------

async function seed() {
  for (const slug of config.seedBuckets) {
    const description = {
      uploads: 'User-uploaded files',
      backups: 'Application and database backups',
      artifacts: 'Generated files and build artifacts',
    }[slug] || null;
    // Sensible defaults per bucket: backups get aggressive retention because
    // nothing else ever deletes them.
    const retentionDays = slug === 'backups' ? 90 : null;
    await db.query(
      `INSERT INTO buckets (slug, description, max_age_days) VALUES ($1,$2,$3)
       ON CONFLICT (slug) DO NOTHING`,
      [slug, description, retentionDays]
    );
  }
}

async function start() {
  if (!config.sessionSecret) throw new Error('SESSION_SECRET is required');
  if (!config.nodeSecret) console.warn('[boot] NODE_SHARED_SECRET is empty — storage nodes will reject every request');

  await migrate();
  await seed();

  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM users');
  if (rows[0].n === 0) {
    console.log('[boot] no users yet — the first account created becomes admin');
  }

  setInterval(() => nodes.heartbeatAll().catch((e) => console.error('[heartbeat]', e.message)),
    config.heartbeatIntervalMs).unref();
  setInterval(() => retention.runOnce().catch((e) => console.error('[retention]', e.message)),
    config.retentionIntervalMs).unref();
  nodes.heartbeatAll().catch(() => {});

  const server = app.listen(config.port, () => console.log(`[boot] brew-bucket backend on :${config.port}`));
  // Large uploads legitimately take a long time; the default 2 minute socket
  // timeout would cut a NAS-bound backup in half.
  server.requestTimeout = 0;
  server.headersTimeout = 65000;
  server.keepAliveTimeout = 61000;
}

start().catch((err) => {
  console.error('[boot] failed:', err.message);
  process.exit(1);
});
