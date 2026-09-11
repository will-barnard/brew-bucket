const express = require('express');
const crypto = require('crypto');
const db = require('../db/pool');
const auth = require('../middleware/auth');
const nodes = require('../services/nodes');
const audit = require('../services/audit');

const router = express.Router();

// Unauthenticated public fetch by opaque token. Mounted OUTSIDE the API-key
// surface on purpose: this is the "send someone a file" path and it must work
// in a plain browser with no credential at all.
router.get('/s/:token', async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT s.*, o.key, o.size, o.content_type, o.blob_hash, b.slug AS bucket, bl.node_id
        FROM share_links s
        JOIN objects o ON o.id = s.object_id
        JOIN buckets b ON b.id = o.bucket_id
        JOIN blobs bl ON bl.hash = o.blob_hash
       WHERE s.token = $1`, [req.params.token]);
    const link = rows[0];
    if (!link) throw Object.assign(new Error('link not found'), { status: 404 });
    if (link.expires_at && new Date(link.expires_at) < new Date()) throw Object.assign(new Error('link expired'), { status: 410 });
    if (link.max_hits && link.hits >= link.max_hits) throw Object.assign(new Error('link exhausted'), { status: 410 });

    await db.query('UPDATE share_links SET hits = hits + 1 WHERE token = $1', [req.params.token]);

    const node = await nodes.get(link.node_id);
    if (!node) throw Object.assign(new Error('storage node unavailable'), { status: 503 });
    const upstream = await nodes.getBlobStream(node, link.blob_hash, req.get('range'));

    res.status(upstream.statusCode === 206 ? 206 : 200);
    res.set('content-type', link.content_type);
    res.set('content-disposition', `attachment; filename="${link.key.split('/').pop().replace(/"/g, '')}"`);
    if (upstream.headers['content-length']) res.set('content-length', upstream.headers['content-length']);
    upstream.pipe(res);

    audit.log({ action: 'share.get', objectKey: link.key, ip: req.ip, bytes: Number(link.size) });
  } catch (err) { next(err); }
});

const api = express.Router();
api.use(auth.requireUser);

api.post('/', async (req, res, next) => {
  try {
    const { bucket, key, expires_hours = 168, max_hits = null } = req.body || {};
    const { rows } = await db.query(
      `SELECT o.id FROM objects o JOIN buckets b ON b.id = o.bucket_id
        WHERE b.slug = $1 AND o.key = $2 AND o.is_current`, [bucket, key]);
    if (!rows[0]) throw Object.assign(new Error('object not found'), { status: 404 });
    const token = crypto.randomBytes(18).toString('base64url');
    await db.query(
      `INSERT INTO share_links (token, object_id, expires_at, max_hits, created_by)
       VALUES ($1,$2, CASE WHEN $3::int IS NULL THEN NULL ELSE now() + ($3 || ' hours')::interval END, $4, $5)`,
      [token, rows[0].id, expires_hours, max_hits, req.actor.userId]);
    audit.log({ action: 'share.create', objectKey: key, actor: req.actor, ip: req.ip });
    res.status(201).json({ token, path: `/s/${token}` });
  } catch (err) { next(err); }
});

api.get('/', async (_req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT s.token, s.expires_at, s.max_hits, s.hits, s.created_at, o.key, b.slug AS bucket
        FROM share_links s JOIN objects o ON o.id = s.object_id JOIN buckets b ON b.id = o.bucket_id
       ORDER BY s.created_at DESC LIMIT 200`);
    res.json({ links: rows });
  } catch (err) { next(err); }
});

api.delete('/:token', async (req, res, next) => {
  try {
    await db.query('DELETE FROM share_links WHERE token = $1', [req.params.token]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = { public: router, api };
