const express = require('express');
const db = require('../db/pool');
const auth = require('../middleware/auth');
const storage = require('../services/storage');
const retention = require('../services/retention');

const router = express.Router();
router.use(auth.requireUser);

router.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const { rows } = await db.query(`
      SELECT a.id, a.at, a.action, a.object_key, a.ip, a.bytes, a.ok, a.detail,
             b.slug AS bucket, u.username, k.name AS key_name
        FROM activity_log a
        LEFT JOIN buckets b ON b.id = a.bucket_id
        LEFT JOIN users u ON u.id = a.user_id
        LEFT JOIN api_keys k ON k.id = a.key_id
       WHERE ($1::text IS NULL OR a.action LIKE $1 || '%')
       ORDER BY a.at DESC LIMIT $2`,
      [req.query.action || null, limit]);
    res.json({ activity: rows });
  } catch (err) { next(err); }
});

// Everything the dashboard needs in one round trip.
router.get('/overview', async (_req, res, next) => {
  try {
    const totals = await db.query(`
      SELECT COALESCE(SUM(o.size),0)::bigint AS bytes, COUNT(*)::int AS objects
        FROM objects o WHERE o.is_current`);
    const blobs = await db.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(size),0)::bigint AS bytes FROM blobs`);
    const nodeRows = await db.query(`
      SELECT name, disk_total, disk_free, last_seen_at,
             (last_seen_at IS NOT NULL AND last_seen_at > now() - interval '3 minutes') AS online
        FROM nodes WHERE enabled ORDER BY id`);
    const series = await db.query(`
      SELECT day, SUM(bytes_in)::bigint AS bytes_in, SUM(bytes_out)::bigint AS bytes_out,
             SUM(puts)::int AS puts, SUM(gets)::int AS gets
        FROM usage_daily WHERE day > CURRENT_DATE - 30 GROUP BY day ORDER BY day`);
    const counts = await db.query(`
      SELECT (SELECT COUNT(*)::int FROM buckets) AS buckets,
             (SELECT COUNT(*)::int FROM api_keys WHERE revoked_at IS NULL) AS active_keys,
             (SELECT COUNT(*)::int FROM users WHERE NOT disabled) AS users`);

    res.json({
      totals: { logical_bytes: Number(totals.rows[0].bytes), objects: totals.rows[0].objects },
      // logical vs physical is the dedup saving, and it is worth showing.
      physical: { blobs: blobs.rows[0].n, bytes: Number(blobs.rows[0].bytes) },
      nodes: nodeRows.rows,
      series: series.rows,
      counts: counts.rows[0],
    });
  } catch (err) { next(err); }
});

router.post('/maintenance/sweep', auth.requireAdmin, async (_req, res, next) => {
  try { res.json(await retention.runOnce()); } catch (err) { next(err); }
});

module.exports = router;
