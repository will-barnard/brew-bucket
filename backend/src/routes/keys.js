const express = require('express');
const db = require('../db/pool');
const auth = require('../middleware/auth');
const keys = require('../services/keys');
const audit = require('../services/audit');

const router = express.Router();
router.use(auth.requireUser);

const SCOPES = ['read', 'write', 'delete', 'admin'];

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT k.id, k.name, k.prefix, k.scopes, k.bucket_ids, k.expires_at, k.revoked_at,
              k.last_used_at, k.last_used_ip, k.created_at, u.username AS owner
         FROM api_keys k LEFT JOIN users u ON u.id = k.owner_id
        ORDER BY k.revoked_at NULLS FIRST, k.created_at DESC`
    );
    res.json({ keys: rows });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, scopes = ['read'], bucket_ids = null, expires_days = null } = req.body || {};
    if (!name) throw Object.assign(new Error('name is required'), { status: 422 });
    const bad = scopes.filter((s) => !SCOPES.includes(s));
    if (bad.length) throw Object.assign(new Error(`unknown scope: ${bad.join(', ')}`), { status: 422 });
    if (scopes.includes('admin') && req.actor.role !== 'admin') {
      throw Object.assign(new Error('only admins can mint admin-scoped keys'), { status: 403 });
    }

    const generated = keys.generate();
    const { rows } = await db.query(
      `INSERT INTO api_keys (name, prefix, secret_hash, scopes, bucket_ids, owner_id, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $7::int IS NULL THEN NULL ELSE now() + ($7 || ' days')::interval END)
       RETURNING id, name, prefix, scopes, bucket_ids, expires_at, created_at`,
      [name, generated.prefix, generated.hash, scopes,
       bucket_ids && bucket_ids.length ? bucket_ids : null, req.actor.userId, expires_days]
    );
    audit.log({ action: 'key.create', actor: req.actor, ip: req.ip, detail: name });
    // The plaintext is returned here and nowhere else, ever.
    res.status(201).json({ key: rows[0], secret: generated.plaintext });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL
        RETURNING id, name`, [Number(req.params.id)]
    );
    if (!rows[0]) throw Object.assign(new Error('key not found or already revoked'), { status: 404 });
    audit.log({ action: 'key.revoke', actor: req.actor, ip: req.ip, detail: rows[0].name });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
