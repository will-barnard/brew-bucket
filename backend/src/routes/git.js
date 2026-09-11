const express = require('express');
const db = require('../db/pool');
const config = require('../config');
const auth = require('../middleware/auth');
const nodes = require('../services/nodes');

// ---------------------------------------------------------------------------
// Git bucket scaffolding.
//
// The shape is settled; the transport is not wired up yet. A bucket with
// kind='git' holds bare repositories on the storage node instead of blobs, and
// the node agent runs `git http-backend` against them. This control plane stays
// the only thing that authenticates: it terminates Basic auth (username +
// API key as password), checks the key's scopes against the bucket, and proxies
// the smart-HTTP request through to the node, exactly as object GET proxies
// bytes today.
//
// What is already true:
//   - git_repos table exists (migration 002)
//   - repo CRUD below works and is used by the UI
//   - clone/fetch/push return 501 until BREW_BUCKET_GIT=1 and the node agent
//     ships its /git handler
//
// Why it is staged: smart-HTTP needs chunked request/response proxying with no
// buffering and correct handling of `git-upload-pack` vs `git-receive-pack`
// content types. That is a self-contained piece of work, and getting object
// storage right first means the auth and node-proxy machinery it needs already
// exists and is proven.
// ---------------------------------------------------------------------------

const router = express.Router();

async function gitBucket(slug) {
  const { rows } = await db.query(`SELECT * FROM buckets WHERE slug = $1 AND kind = 'git'`, [slug]);
  if (!rows[0]) throw Object.assign(new Error(`no git bucket "${slug}"`), { status: 404 });
  return rows[0];
}

router.get('/repos', auth.requireUser, async (_req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT r.*, b.slug AS bucket FROM git_repos r JOIN buckets b ON b.id = r.bucket_id
       ORDER BY b.slug, r.name`);
    res.json({ repos: rows, enabled: config.gitEnabled });
  } catch (err) { next(err); }
});

router.post('/repos', auth.requireUser, async (req, res, next) => {
  try {
    const { bucket, name, description, default_branch = 'main' } = req.body || {};
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(String(name || ''))) {
      throw Object.assign(new Error('repo name may contain letters, digits, dot, dash and underscore'), { status: 422 });
    }
    const b = await gitBucket(bucket);
    const node = await nodes.get(b.node_id) || await nodes.pickWritable();

    if (config.gitEnabled) {
      await nodes.request(node, { method: 'POST', path: '/git/repos', body: { bucket: b.slug, name, default_branch } });
    }

    const { rows } = await db.query(
      `INSERT INTO git_repos (bucket_id, name, description, default_branch, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [b.id, name, description || null, default_branch, req.actor.userId]);

    const base = config.publicUrl || '';
    res.status(201).json({
      repo: rows[0],
      clone_url: `${base}/git/${b.slug}/${name}.git`,
      enabled: config.gitEnabled,
      note: config.gitEnabled ? undefined
        : 'Repo registered. Smart-HTTP transport is not enabled on this instance yet.',
    });
  } catch (err) {
    if (err.code === '23505') err = Object.assign(new Error('a repo with that name already exists in this bucket'), { status: 409 });
    next(err);
  }
});

router.delete('/repos/:bucket/:name', auth.requireUser, async (req, res, next) => {
  try {
    const b = await gitBucket(req.params.bucket);
    await db.query('DELETE FROM git_repos WHERE bucket_id = $1 AND name = $2', [b.id, req.params.name]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// --- smart HTTP transport (staged) -----------------------------------------

// git sends credentials as Basic auth. Username is ignored; the password is a
// brew-bucket API key, which is what a CI job or dry-dock's Engineer would hold.
function basicAuthAsApiKey(req, _res, next) {
  const header = req.get('authorization') || '';
  const m = /^Basic\s+(.+)$/i.exec(header);
  if (m) {
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const password = decoded.slice(decoded.indexOf(':') + 1);
    if (password) req.headers['x-api-key'] = password;
  }
  next();
}

function notYet(_req, res) {
  res.status(501).set('content-type', 'text/plain').send(
    'brew-bucket: git smart-HTTP transport is not enabled on this instance.\n' +
    'Set BREW_BUCKET_GIT=1 and deploy a storage node with git support.\n'
  );
}

// Express path params do not portably capture a literal '.git' suffix, so the
// repo segment is matched whole and the suffix stripped here.
function stripGitSuffix(req, _res, next) {
  if (req.params.repo) req.params.repo = req.params.repo.replace(/\.git$/, '');
  next();
}

router.use('/:bucket/:repo', stripGitSuffix, basicAuthAsApiKey);
router.get('/:bucket/:repo/info/refs', notYet);
router.post('/:bucket/:repo/git-upload-pack', notYet);
router.post('/:bucket/:repo/git-receive-pack', notYet);

module.exports = router;
