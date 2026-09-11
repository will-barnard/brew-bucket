const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/pool');
const auth = require('../middleware/auth');
const { rateLimit } = require('../middleware/ratelimit');
const audit = require('../services/audit');

const router = express.Router();

async function userCount() {
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM users');
  return rows[0].n;
}

// Bootstrap: while no user exists, registration is open and the first account
// created becomes admin. The moment that account exists the endpoint closes and
// further accounts need an invite. This is the whole of the setup flow.
router.get('/bootstrap', async (_req, res, next) => {
  try { res.json({ needs_setup: (await userCount()) === 0 }); }
  catch (err) { next(err); }
});

router.post('/register', rateLimit({ max: 10 }), async (req, res, next) => {
  try {
    const { email, username, password, invite } = req.body || {};
    if (!email || !username || !password) throw Object.assign(new Error('email, username and password are required'), { status: 422 });
    if (String(password).length < 10) throw Object.assign(new Error('password must be at least 10 characters'), { status: 422 });

    const existing = await userCount();
    let role = 'user';
    let inviteRow = null;

    if (existing === 0) {
      role = 'admin';
    } else {
      if (!invite) throw Object.assign(new Error('registration is invite-only'), { status: 403 });
      const { rows } = await db.query(
        'SELECT * FROM invites WHERE token = $1 AND used_at IS NULL AND expires_at > now()', [invite]
      );
      inviteRow = rows[0];
      if (!inviteRow) throw Object.assign(new Error('invite is invalid or expired'), { status: 403 });
      role = inviteRow.role;
    }

    const hash = await bcrypt.hash(password, 12);
    const { rows } = await db.query(
      `INSERT INTO users (email, username, password_hash, role) VALUES ($1,$2,$3,$4)
       RETURNING id, email, username, role`,
      [String(email).toLowerCase(), username, hash, role]
    );
    if (inviteRow) await db.query('UPDATE invites SET used_at = now() WHERE token = $1', [inviteRow.token]);

    auth.issueSession(res, rows[0]);
    audit.log({ action: 'user.register', actor: { userId: rows[0].id }, ip: req.ip, detail: role });
    res.status(201).json({ user: rows[0], bootstrapped: existing === 0 });
  } catch (err) {
    if (err.code === '23505') err = Object.assign(new Error('email or username already taken'), { status: 409 });
    next(err);
  }
});

router.post('/login', rateLimit({ max: 20 }), async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    const { rows } = await db.query(
      'SELECT * FROM users WHERE lower(email) = lower($1) OR username = $1', [username || '']
    );
    const user = rows[0];
    const ok = user && !user.disabled && await bcrypt.compare(String(password || ''), user.password_hash);
    if (!ok) {
      audit.log({ action: 'user.login', ip: req.ip, ok: false, detail: username });
      throw Object.assign(new Error('invalid credentials'), { status: 401 });
    }
    await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    auth.issueSession(res, user);
    audit.log({ action: 'user.login', actor: { userId: user.id }, ip: req.ip });
    res.json({ user: { id: user.id, email: user.email, username: user.username, role: user.role } });
  } catch (err) { next(err); }
});

router.post('/logout', (req, res) => {
  auth.clearSession(res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.actor.userId || req.actor.role === 'key') return res.status(401).json({ error: 'not signed in' });
  res.json({ user: req.actor.user, scopes: req.actor.scopes });
});

router.post('/password', auth.requireUser, async (req, res, next) => {
  try {
    const { current, next: nextPassword } = req.body || {};
    if (!nextPassword || String(nextPassword).length < 10) throw Object.assign(new Error('password must be at least 10 characters'), { status: 422 });
    const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.actor.userId]);
    if (!await bcrypt.compare(String(current || ''), rows[0].password_hash)) {
      throw Object.assign(new Error('current password is incorrect'), { status: 403 });
    }
    await db.query('UPDATE users SET password_hash = $2 WHERE id = $1',
      [req.actor.userId, await bcrypt.hash(nextPassword, 12)]);
    audit.log({ action: 'user.password', actor: req.actor, ip: req.ip });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.userCount = userCount;
