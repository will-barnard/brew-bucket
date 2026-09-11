const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const config = require('./config');

// Content-addressed store. sha256 hex, fanned out two levels so no directory
// ever holds millions of entries: <data>/blobs/ab/cd/abcd...
const BLOBS = path.join(config.dataDir, 'blobs');
const TMP = path.join(config.dataDir, 'tmp');

function pathFor(hash) {
  return path.join(BLOBS, hash.slice(0, 2), hash.slice(2, 4), hash);
}

function validHash(hash) {
  return typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash);
}

async function init() {
  await fsp.mkdir(BLOBS, { recursive: true });
  await fsp.mkdir(TMP, { recursive: true });
  // Anything left in tmp is the debris of an interrupted upload.
  for (const f of await fsp.readdir(TMP)) await fsp.rm(path.join(TMP, f), { force: true });
}

// Writes to a temp file while hashing, then renames into place. The rename is
// atomic on the same filesystem, so a half-written blob can never be served —
// and if the content is already here, the upload is discarded and reported as
// deduped rather than rewritten.
async function write(readable, { expectedHash } = {}) {
  const tmp = path.join(TMP, crypto.randomBytes(16).toString('hex'));
  const hasher = crypto.createHash('sha256');
  let size = 0;

  const out = fs.createWriteStream(tmp);
  readable.on('data', (chunk) => { hasher.update(chunk); size += chunk.length; });

  try {
    await pipeline(readable, out);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }

  const hash = hasher.digest('hex');

  if (expectedHash && expectedHash !== hash) {
    await fsp.rm(tmp, { force: true });
    const e = new Error(`content hash mismatch: expected ${expectedHash}, got ${hash}`);
    e.status = 422;
    throw e;
  }

  const dest = pathFor(hash);
  if (await exists(hash)) {
    await fsp.rm(tmp, { force: true });
    return { hash, size, deduped: true };
  }

  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.rename(tmp, dest);
  return { hash, size, deduped: false };
}

async function exists(hash) {
  try { await fsp.access(pathFor(hash)); return true; } catch { return false; }
}

async function stat(hash) {
  try {
    const s = await fsp.stat(pathFor(hash));
    return { exists: true, size: s.size, mtime: s.mtimeMs };
  } catch { return { exists: false }; }
}

function readStream(hash, range) {
  return fs.createReadStream(pathFor(hash), range);
}

async function remove(hash) {
  await fsp.rm(pathFor(hash), { force: true });
  return { ok: true };
}

// Re-hashes a blob on disk. This is how bit rot gets caught: the control plane
// walks blobs oldest-verified-first and asks the node to confirm each one.
async function verify(hash) {
  const s = await stat(hash);
  if (!s.exists) return { exists: false, ok: false };
  const hasher = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(pathFor(hash)), async function* (src) {
    for await (const chunk of src) { hasher.update(chunk); yield chunk; }
  }, fs.createWriteStream('/dev/null'));
  const actual = hasher.digest('hex');
  return { exists: true, ok: actual === hash, actual, size: s.size };
}

async function diskUsage() {
  const s = await fsp.statfs(config.dataDir);
  return { disk_total: s.blocks * s.bsize, disk_free: s.bavail * s.bsize };
}

module.exports = { init, write, exists, stat, readStream, remove, verify, diskUsage, validHash, pathFor, BLOBS };
