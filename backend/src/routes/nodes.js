const express = require('express');
const db = require('../db/pool');
const auth = require('../middleware/auth');
const nodes = require('../services/nodes');
const audit = require('../services/audit');

const router = express.Router();
router.use(auth.requireUser);

router.get('/', async (_req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT n.*,
             COALESCE(b.blob_count, 0)::int AS blob_count,
             COALESCE(b.blob_bytes, 0)::bigint AS blob_bytes,
             (n.last_seen_at IS NOT NULL AND n.last_seen_at > now() - interval '3 minutes') AS online
        FROM nodes n
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS blob_count, SUM(size) AS blob_bytes FROM blobs WHERE node_id = n.id
        ) b ON TRUE
       ORDER BY n.id`);
    res.json({ nodes: rows });
  } catch (err) { next(err); }
});

router.post('/', auth.requireAdmin, async (req, res, next) => {
  try {
    const { name, internal_url, direct_base_url } = req.body || {};
    if (!name || !internal_url) throw Object.assign(new Error('name and internal_url are required'), { status: 422 });
    const { rows } = await db.query(
      `INSERT INTO nodes (name, internal_url, direct_base_url) VALUES ($1,$2,$3) RETURNING *`,
      [name, internal_url.replace(/\/$/, ''), direct_base_url ? direct_base_url.replace(/\/$/, '') : null]
    );
    audit.log({ action: 'node.create', actor: req.actor, ip: req.ip, detail: name });
    res.status(201).json({ node: rows[0] });
  } catch (err) {
    if (err.code === '23505') err = Object.assign(new Error('a node with that name already exists'), { status: 409 });
    next(err);
  }
});

router.patch('/:id', auth.requireAdmin, async (req, res, next) => {
  try {
    const fields = ['internal_url', 'direct_base_url', 'enabled', 'writable'];
    const sets = []; const vals = [Number(req.params.id)];
    for (const f of fields) if (req.body && f in req.body) { vals.push(req.body[f]); sets.push(`${f} = $${vals.length}`); }
    if (!sets.length) throw Object.assign(new Error('nothing to update'), { status: 422 });
    const { rows } = await db.query(`UPDATE nodes SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
    if (!rows[0]) throw Object.assign(new Error('node not found'), { status: 404 });
    res.json({ node: rows[0] });
  } catch (err) { next(err); }
});

// On-demand probe, so the UI's "test" button gives an answer now rather than
// waiting out the heartbeat interval.
router.post('/:id/check', async (req, res, next) => {
  try {
    const node = await nodes.get(Number(req.params.id));
    if (!node) throw Object.assign(new Error('node not found'), { status: 404 });
    // Short timeout: this is a person waiting on a button, not a transfer.
    const stat = await nodes.stat(node, { timeout: 8000 });
    await db.query(
      `UPDATE nodes SET last_seen_at = now(), agent_version = $2, disk_total = $3, disk_free = $4, last_error = NULL WHERE id = $1`,
      [node.id, stat.version || null, stat.disk_total || null, stat.disk_free || null]
    );
    res.json({ ok: true, stat });
  } catch (err) {
    // Record it too, so the reason survives on the node card rather than
    // living only in a toast the user is about to navigate away from.
    await db.query('UPDATE nodes SET last_error = $2 WHERE id = $1',
      [Number(req.params.id), err.message]).catch(() => {});
    res.status(502).json({ ok: false, error: err.message, code: err.code || null });
  }
});

router.delete('/:id', auth.requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM blobs WHERE node_id = $1', [Number(req.params.id)]);
    if (rows[0].n > 0) throw Object.assign(new Error(`node still holds ${rows[0].n} blobs`), { status: 409 });
    await db.query('DELETE FROM nodes WHERE id = $1', [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
