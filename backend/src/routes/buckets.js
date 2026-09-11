const express = require('express');
const db = require('../db/pool');
const auth = require('../middleware/auth');
const storage = require('../services/storage');
const audit = require('../services/audit');

const router = express.Router();

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

// Bucket list doubles as the dashboard's storage view: usage, object count and
// last write per bucket in one query, so the UI never fans out.
router.get('/', auth.requireUser, async (_req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT b.*, n.name AS node_name, n.last_seen_at AS node_last_seen,
             COALESCE(u.bytes, 0)::bigint AS used_bytes,
             COALESCE(u.objects, 0)::int  AS object_count,
             u.last_write
        FROM buckets b
        LEFT JOIN nodes n ON n.id = b.node_id
        LEFT JOIN LATERAL (
          SELECT SUM(size) AS bytes, COUNT(*) AS objects, MAX(created_at) AS last_write
            FROM objects WHERE bucket_id = b.id AND is_current
        ) u ON TRUE
       ORDER BY b.slug`);
    res.json({ buckets: rows });
  } catch (err) { next(err); }
});

router.post('/', auth.requireUser, auth.requireAdmin, async (req, res, next) => {
  try {
    const { slug, description, kind = 'blob', node_id, quota_bytes, public_read, allow_direct,
            versioning, max_versions, max_age_days, max_object_bytes } = req.body || {};
    if (!SLUG.test(String(slug || ''))) {
      throw Object.assign(new Error('slug must be lowercase letters, digits and dashes'), { status: 422 });
    }
    const { rows } = await db.query(
      `INSERT INTO buckets (slug, description, kind, node_id, quota_bytes, public_read, allow_direct,
                            versioning, max_versions, max_age_days, max_object_bytes, created_by)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,FALSE),COALESCE($7,FALSE),COALESCE($8,FALSE),$9,$10,$11,$12)
       RETURNING *`,
      [slug, description || null, kind, node_id || null, quota_bytes || null, public_read, allow_direct,
       versioning, max_versions || null, max_age_days || null, max_object_bytes || null, req.actor.userId]
    );
    audit.log({ action: 'bucket.create', bucketId: rows[0].id, actor: req.actor, ip: req.ip });
    res.status(201).json({ bucket: rows[0] });
  } catch (err) {
    if (err.code === '23505') err = Object.assign(new Error('a bucket with that slug already exists'), { status: 409 });
    next(err);
  }
});

router.get('/:slug', auth.requireUser, async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM buckets WHERE slug = $1', [req.params.slug]);
    if (!rows[0]) throw Object.assign(new Error('bucket not found'), { status: 404 });
    const usage = await storage.bucketUsage(rows[0].id);
    const recent = await db.query(
      `SELECT key, size, content_type, version, created_at FROM objects
        WHERE bucket_id = $1 AND is_current ORDER BY created_at DESC LIMIT 20`,
      [rows[0].id]
    );
    const series = await db.query(
      `SELECT day, bytes_in, bytes_out, puts, gets FROM usage_daily
        WHERE bucket_id = $1 AND day > CURRENT_DATE - 30 ORDER BY day`,
      [rows[0].id]
    );
    res.json({ bucket: rows[0], usage, recent: recent.rows, series: series.rows });
  } catch (err) { next(err); }
});

router.patch('/:slug', auth.requireUser, auth.requireAdmin, async (req, res, next) => {
  try {
    const fields = ['description', 'node_id', 'quota_bytes', 'public_read', 'allow_direct',
                    'versioning', 'max_versions', 'max_age_days', 'max_object_bytes'];
    const sets = [];
    const vals = [req.params.slug];
    for (const f of fields) {
      if (req.body && f in req.body) { vals.push(req.body[f]); sets.push(`${f} = $${vals.length}`); }
    }
    if (!sets.length) throw Object.assign(new Error('nothing to update'), { status: 422 });
    const { rows } = await db.query(
      `UPDATE buckets SET ${sets.join(', ')} WHERE slug = $1 RETURNING *`, vals
    );
    if (!rows[0]) throw Object.assign(new Error('bucket not found'), { status: 404 });
    audit.log({ action: 'bucket.update', bucketId: rows[0].id, actor: req.actor, ip: req.ip });
    res.json({ bucket: rows[0] });
  } catch (err) { next(err); }
});

router.delete('/:slug', auth.requireUser, auth.requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM buckets WHERE slug = $1', [req.params.slug]);
    if (!rows[0]) throw Object.assign(new Error('bucket not found'), { status: 404 });
    const usage = await storage.bucketUsage(rows[0].id);
    if (usage.objects > 0 && req.query.force !== 'true') {
      throw Object.assign(new Error(`bucket holds ${usage.objects} objects; pass ?force=true`), { status: 409 });
    }
    // ON DELETE CASCADE drops the object rows; the blobs they referenced fall to
    // refcount 0 and the orphan sweeper reclaims them on the NAS.
    await db.query(
      `UPDATE blobs SET refcount = refcount - 1 WHERE hash IN (SELECT blob_hash FROM objects WHERE bucket_id = $1)`,
      [rows[0].id]
    );
    await db.query('DELETE FROM buckets WHERE id = $1', [rows[0].id]);
    audit.log({ action: 'bucket.delete', actor: req.actor, ip: req.ip, detail: req.params.slug });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
