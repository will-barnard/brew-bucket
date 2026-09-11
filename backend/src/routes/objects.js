const express = require('express');
const db = require('../db/pool');
const config = require('../config');
const auth = require('../middleware/auth');
const { rateLimit } = require('../middleware/ratelimit');
const nodes = require('../services/nodes');
const storage = require('../services/storage');
const signing = require('../services/signing');
const audit = require('../services/audit');
const webhooks = require('../services/webhooks');

const router = express.Router({ mergeParams: true });

// This router is mounted without a body parser on purpose: a global one would
// consume the upload stream that PUT pipes straight to the NAS. The two routes
// that genuinely take JSON opt in individually.
const json = express.json({ limit: '64kb' });

// Resolves :bucket once for every route below and hangs it on req.bucket, which
// is what requireScope() reads to enforce per-bucket key restrictions.
router.param('bucket', async (req, _res, next, slug) => {
  try {
    const { rows } = await db.query('SELECT * FROM buckets WHERE slug = $1', [slug]);
    if (!rows[0]) throw Object.assign(new Error(`bucket "${slug}" not found`), { status: 404 });
    req.bucket = rows[0];
    next();
  } catch (err) { next(err); }
});

function keyFrom(req) {
  // Express has already decoded this. Decoding again would mangle any key
  // containing a literal percent sign.
  const key = String(req.params[0] || '').replace(/^\/+/, '');
  if (!key) throw Object.assign(new Error('object key is required'), { status: 422 });
  if (key.includes('..')) throw Object.assign(new Error('invalid key'), { status: 422 });
  if (key.length > 1024) throw Object.assign(new Error('key too long'), { status: 422 });
  return key;
}

async function nodeFor(bucket) {
  return bucket.node_id ? await nodes.get(bucket.node_id) : await nodes.pickWritable();
}

// ---------------------------------------------------------------- list

router.get('/:bucket/o', auth.requireScope('read'), async (req, res, next) => {
  try {
    const { prefix = '', cursor = '', limit = 200, versions } = req.query;
    const lim = Math.min(Number(limit) || 200, 1000);
    const { rows } = await db.query(
      `SELECT key, version, size, content_type, metadata, created_at, blob_hash
         FROM objects
        WHERE bucket_id = $1 AND ($4::bool OR is_current)
          AND key LIKE $2 || '%' AND key > $3
        ORDER BY key, version DESC LIMIT $5`,
      [req.bucket.id, prefix, cursor, versions === 'true', lim]
    );
    res.json({
      objects: rows,
      next_cursor: rows.length === lim ? rows[rows.length - 1].key : null,
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------- upload

router.put('/:bucket/o/*', auth.requireScope('write'), rateLimit({ max: 600 }), async (req, res, next) => {
  try {
    const key = keyFrom(req);
    const declared = Number(req.get('content-length') || 0);
    const cap = Number(req.bucket.max_object_bytes || config.maxObjectBytes);
    if (declared && declared > cap) {
      throw Object.assign(new Error(`object exceeds the ${cap} byte limit for this bucket`), { status: 413 });
    }
    if (declared) await storage.assertQuota(req.bucket, declared);

    const node = await nodeFor(req.bucket);
    // The request body is piped straight through; nothing is buffered here.
    const result = await nodes.putBlob(node, req, {
      contentLength: req.get('content-length'),
      declaredHash: req.get('x-content-sha256') || null,
    });

    if (!declared) {
      try {
        await storage.assertQuota(req.bucket, result.size);
      } catch (err) {
        // The bytes already landed. Nothing will reference them and no blobs
        // row exists, so the orphan sweeper would never see them — drop the
        // blob now rather than leak it, unless another object shares the hash.
        const { rowCount } = await db.query('SELECT 1 FROM blobs WHERE hash = $1', [result.hash]);
        if (!rowCount) await nodes.deleteBlob(node, result.hash).catch(() => {});
        throw err;
      }
    }

    const object = await storage.commitObject({
      bucket: req.bucket,
      key,
      hash: result.hash,
      size: result.size,
      nodeId: node.id,
      contentType: req.get('content-type'),
      metadata: parseMeta(req),
      actor: req.actor,
    });

    audit.log({ action: 'object.put', bucketId: req.bucket.id, objectKey: key, actor: req.actor, ip: req.ip, bytes: result.size });
    audit.rollup({ bucketId: req.bucket.id, bytesIn: result.size, puts: 1 });
    webhooks.emit('object.put', req.bucket, { key, size: result.size, hash: result.hash, version: object.version });

    res.status(201).json({
      key, size: result.size, hash: result.hash, version: object.version,
      deduped: !!result.deduped, bucket: req.bucket.slug,
    });
  } catch (err) { next(err); }
});

// x-meta-* headers become the object's metadata jsonb.
function parseMeta(req) {
  const meta = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.startsWith('x-meta-')) meta[k.slice(7)] = v;
  }
  return meta;
}

// ---------------------------------------------------------------- download

router.get('/:bucket/o/*', auth.requireScope('read'), async (req, res, next) => {
  try {
    const key = keyFrom(req);
    const object = req.query.version
      ? await storage.getVersion(req.bucket.id, key, Number(req.query.version))
      : await storage.getCurrent(req.bucket.id, key);
    if (!object) throw Object.assign(new Error('object not found'), { status: 404 });

    // Hybrid path: a client that asks for it, on a bucket that allows it, with a
    // node that advertises a LAN address, gets a signed redirect and the bytes
    // never touch the mini. Everyone else is proxied.
    if (req.query.direct === '1' && req.bucket.allow_direct) {
      const node = await nodes.get(object.node_id);
      if (node && node.direct_base_url) {
        const token = signing.grant({ op: 'get', hash: object.blob_hash });
        audit.log({ action: 'object.direct', bucketId: req.bucket.id, objectKey: key, actor: req.actor, ip: req.ip });
        return res.status(307).set(
          'location',
          `${node.direct_base_url.replace(/\/$/, '')}/direct/blobs/${object.blob_hash}?token=${token}`
        ).json({ direct: true });
      }
    }

    const node = await nodes.get(object.node_id);
    if (!node) throw Object.assign(new Error('storage node for this object is not registered'), { status: 503 });

    const upstream = await nodes.getBlobStream(node, object.blob_hash, req.get('range'));
    res.status(upstream.statusCode === 206 ? 206 : 200);
    res.set('content-type', object.content_type);
    res.set('etag', `"${object.blob_hash}"`);
    res.set('x-object-version', String(object.version));
    if (upstream.headers['content-length']) res.set('content-length', upstream.headers['content-length']);
    if (upstream.headers['content-range']) res.set('content-range', upstream.headers['content-range']);
    res.set('accept-ranges', 'bytes');
    if (req.query.download === '1') {
      res.set('content-disposition', `attachment; filename="${key.split('/').pop().replace(/"/g, '')}"`);
    }

    upstream.pipe(res);
    upstream.on('error', (e) => { console.error('[get]', e.message); res.destroy(); });
    res.on('finish', () => {
      audit.log({ action: 'object.get', bucketId: req.bucket.id, objectKey: key, actor: req.actor, ip: req.ip, bytes: Number(object.size) });
      audit.rollup({ bucketId: req.bucket.id, bytesOut: Number(object.size), gets: 1 });
    });
  } catch (err) { next(err); }
});

router.head('/:bucket/o/*', auth.requireScope('read'), async (req, res, next) => {
  try {
    const object = await storage.getCurrent(req.bucket.id, keyFrom(req));
    if (!object) return res.status(404).end();
    res.set({
      'content-type': object.content_type,
      'content-length': String(object.size),
      etag: `"${object.blob_hash}"`,
      'x-object-version': String(object.version),
      'last-modified': new Date(object.created_at).toUTCString(),
    }).end();
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------- delete

router.delete('/:bucket/o/*', auth.requireScope('delete'), async (req, res, next) => {
  try {
    const key = keyFrom(req);
    const removed = await storage.deleteObject(req.bucket.id, key, { allVersions: req.query.all === 'true' });
    if (!removed.length) throw Object.assign(new Error('object not found'), { status: 404 });
    audit.log({ action: 'object.delete', bucketId: req.bucket.id, objectKey: key, actor: req.actor, ip: req.ip });
    webhooks.emit('object.delete', req.bucket, { key });
    res.json({ ok: true, versions_removed: removed.length });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------- direct transfers

// Two-phase direct upload: get a grant, PUT the bytes at the NAS yourself, then
// commit the metadata here. Commit re-checks the blob really landed, so a client
// cannot register an object for content that was never written.
router.post('/:bucket/presign', json, auth.requireScope('write'), async (req, res, next) => {
  try {
    const { op = 'put', key, hash, size } = req.body || {};
    if (!req.bucket.allow_direct) throw Object.assign(new Error('direct transfers are disabled for this bucket'), { status: 403 });
    const node = await nodeFor(req.bucket);
    if (!node.direct_base_url) throw Object.assign(new Error('storage node has no direct address configured'), { status: 409 });
    const base = node.direct_base_url.replace(/\/$/, '');

    if (op === 'get') {
      const object = await storage.getCurrent(req.bucket.id, key);
      if (!object) throw Object.assign(new Error('object not found'), { status: 404 });
      const token = signing.grant({ op: 'get', hash: object.blob_hash });
      return res.json({ op: 'get', url: `${base}/direct/blobs/${object.blob_hash}?token=${token}`, expires_in: config.directTtlSeconds });
    }

    if (!hash) throw Object.assign(new Error('a sha256 hash of the content is required to presign an upload'), { status: 422 });
    const token = signing.grant({ op: 'put', hash, size: size || null });
    res.json({
      op: 'put',
      url: `${base}/direct/blobs/${hash}?token=${token}`,
      method: 'PUT',
      expires_in: config.directTtlSeconds,
      commit: { method: 'POST', path: `/api/v1/b/${req.bucket.slug}/commit` },
    });
  } catch (err) { next(err); }
});

router.post('/:bucket/commit', json, auth.requireScope('write'), async (req, res, next) => {
  try {
    const { key, hash, content_type, metadata } = req.body || {};
    if (!key || !hash) throw Object.assign(new Error('key and hash are required'), { status: 422 });
    const node = await nodeFor(req.bucket);

    // Trust nothing the client claims about size: ask the node.
    const info = await nodes.request(node, { method: 'GET', path: `/blobs/${hash}/stat` });
    if (!info || !info.exists) throw Object.assign(new Error('no blob with that hash landed on the storage node'), { status: 409 });
    await storage.assertQuota(req.bucket, info.size);

    const object = await storage.commitObject({
      bucket: req.bucket, key, hash, size: info.size, nodeId: node.id,
      contentType: content_type, metadata: metadata || {}, actor: req.actor,
    });
    audit.log({ action: 'object.commit', bucketId: req.bucket.id, objectKey: key, actor: req.actor, ip: req.ip, bytes: info.size });
    audit.rollup({ bucketId: req.bucket.id, bytesIn: info.size, puts: 1 });
    webhooks.emit('object.put', req.bucket, { key, size: info.size, hash, version: object.version, direct: true });
    res.status(201).json({ key, size: info.size, hash, version: object.version });
  } catch (err) { next(err); }
});

module.exports = router;
