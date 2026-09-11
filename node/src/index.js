const express = require('express');
const config = require('./config');
const store = require('./store');
const auth = require('./auth');

const app = express();
app.disable('x-powered-by');

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'brew-bucket-node', version: config.version }));

// ----------------------------------------------------------- internal API
// Everything here is called by the control plane over the LAN.

const internal = express.Router();
internal.use(auth.requireSecret);

internal.get('/stat', async (_req, res, next) => {
  try {
    res.json({ version: config.version, direct: config.directEnabled && !!config.directSecret, ...(await store.diskUsage()) });
  } catch (err) { next(err); }
});

internal.post('/blobs', async (req, res, next) => {
  try {
    const expectedHash = req.get('x-expected-sha256') || null;
    if (expectedHash && !store.validHash(expectedHash)) throw Object.assign(new Error('bad x-expected-sha256'), { status: 422 });
    const result = await store.write(req, { expectedHash });
    res.status(201).json(result);
  } catch (err) { next(err); }
});

internal.get('/blobs/:hash', async (req, res, next) => {
  try {
    if (!store.validHash(req.params.hash)) throw Object.assign(new Error('bad hash'), { status: 422 });
    const info = await store.stat(req.params.hash);
    if (!info.exists) throw Object.assign(new Error('blob not found'), { status: 404 });
    sendBlob(req, res, req.params.hash, info);
  } catch (err) { next(err); }
});

internal.get('/blobs/:hash/stat', async (req, res, next) => {
  try { res.json(await store.stat(req.params.hash)); } catch (err) { next(err); }
});

internal.post('/blobs/:hash/verify', async (req, res, next) => {
  try { res.json(await store.verify(req.params.hash)); } catch (err) { next(err); }
});

internal.delete('/blobs/:hash', async (req, res, next) => {
  try {
    if (!store.validHash(req.params.hash)) throw Object.assign(new Error('bad hash'), { status: 422 });
    res.json(await store.remove(req.params.hash));
  } catch (err) { next(err); }
});

// ----------------------------------------------------------- direct API
// Called by LAN clients holding a presigned token. No node secret required,
// which is exactly why each grant is scoped to one blob and one operation.

const direct = express.Router();

direct.put('/blobs/:hash', auth.requireGrant('put'), async (req, res, next) => {
  try {
    if (!store.validHash(req.params.hash)) throw Object.assign(new Error('bad hash'), { status: 422 });
    // The grant pins the hash, and store.write rejects on mismatch, so a client
    // cannot upload content other than what it asked permission to upload.
    const result = await store.write(req, { expectedHash: req.params.hash });
    res.status(201).json(result);
  } catch (err) { next(err); }
});

direct.get('/blobs/:hash', auth.requireGrant('get'), async (req, res, next) => {
  try {
    const info = await store.stat(req.params.hash);
    if (!info.exists) throw Object.assign(new Error('blob not found'), { status: 404 });
    sendBlob(req, res, req.params.hash, info);
  } catch (err) { next(err); }
});

// Mounted BEFORE the internal router: internal is mounted at '/', so its
// requireSecret middleware would otherwise run for /direct/* too and reject
// every presigned transfer with 401.
app.use('/direct', direct);
app.use('/', internal);

// ----------------------------------------------------------- helpers

function sendBlob(req, res, hash, info) {
  const range = parseRange(req.get('range'), info.size);
  res.set('content-type', 'application/octet-stream');
  res.set('accept-ranges', 'bytes');
  res.set('etag', `"${hash}"`);

  if (range) {
    res.status(206);
    res.set('content-range', `bytes ${range.start}-${range.end}/${info.size}`);
    res.set('content-length', String(range.end - range.start + 1));
    store.readStream(hash, { start: range.start, end: range.end }).pipe(res);
  } else {
    res.set('content-length', String(info.size));
    store.readStream(hash).pipe(res);
  }
}

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!m) return null;
  let start = m[1] === '' ? null : Number(m[1]);
  let end = m[2] === '' ? null : Number(m[2]);
  if (start === null && end === null) return null;
  if (start === null) { start = Math.max(0, size - end); end = size - 1; }
  if (end === null || end >= size) end = size - 1;
  if (start > end || start >= size) return null;
  return { start, end };
}

app.use((_req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[node]', req.method, req.url, err.message);
  if (res.headersSent) return res.destroy();
  res.status(status).json({ error: err.message });
});

store.init().then(() => {
  const server = app.listen(config.port, () => console.log(`[node] brew-bucket storage node on :${config.port} data=${config.dataDir}`));
  server.requestTimeout = 0;
  server.headersTimeout = 65000;
}).catch((err) => {
  console.error('[node] failed to initialise store:', err.message);
  process.exit(1);
});
