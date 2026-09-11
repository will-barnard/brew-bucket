const express = require('express');
const crypto = require('crypto');
const db = require('../db/pool');
const auth = require('../middleware/auth');
const audit = require('../services/audit');

const router = express.Router();
router.use(auth.requireUser);

router.get('/', async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, email, username, role, disabled, created_at, last_login_at
         FROM users ORDER BY id`
    );
    res.json({ users: rows });
  } catch (err) { next(err); }
});

router.post('/invite', auth.requireAdmin, async (req, res, next) => {
  try {
    const { email, role = 'user', days = 7 } = req.body || {};
    if (!email) throw Object.assign(new Error('email is required'), { status: 422 });
    const token = crypto.randomBytes(24).toString('base64url');
    await db.query(
      `INSERT INTO invites (token, email, role, created_by, expires_at)
       VALUES ($1,$2,$3,$4, now() + ($5 || ' days')::interval)`,
      [token, String(email).toLowerCase(), role, req.actor.userId, days]
    );
    audit.log({ action: 'user.invite', actor: req.actor, ip: req.ip, detail: email });
    // There is no mailer here on purpose: the link is handed back for the admin
    // to deliver however they like.
    res.status(201).json({ token, invite_path: `/register?invite=${token}` });
  } catch (err) { next(err); }
});

router.get('/invites', auth.requireAdmin, async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT token, email, role, expires_at, used_at, created_at FROM invites ORDER BY created_at DESC LIMIT 100'
    );
    res.json({ invites: rows });
  } catch (err) { next(err); }
});

router.patch('/:id', auth.requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { role, disabled } = req.body || {};
    if (id === req.actor.userId && (disabled === true || (role && role !== 'admin'))) {
      throw Object.assign(new Error('refusing to lock yourself out'), { status: 400 });
    }
    const { rows } = await db.query(
      `UPDATE users SET role = COALESCE($2, role), disabled = COALESCE($3, disabled)
        WHERE id = $1 RETURNING id, email, username, role, disabled`,
      [id, role || null, disabled === undefined ? null : disabled]
    );
    if (!rows[0]) throw Object.assign(new Error('user not found'), { status: 404 });
    audit.log({ action: 'user.update', actor: req.actor, ip: req.ip, detail: `#${id}` });
    res.json({ user: rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
