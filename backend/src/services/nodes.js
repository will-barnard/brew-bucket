const http = require('http');
const https = require('https');
const { URL } = require('url');
const db = require('../db/pool');
const config = require('../config');

// Client for the storage-node agent running on the NAS. Everything here speaks
// raw streams: the control plane must never buffer an object in memory, or a
// 40 GB backup takes the mini down with it.

function request(node, { method, path, headers = {}, body = null, stream = false }) {
  const url = new URL(path, node.internal_url);
  const mod = url.protocol === 'https:' ? https : http;
  const opts = {
    method,
    headers: { ...headers, 'x-node-secret': config.nodeSecret },
    timeout: config.nodeTimeoutMs,
  };

  return new Promise((resolve, reject) => {
    const req = mod.request(url, opts, (res) => {
      if (stream) {
        // An error response is small and JSON: read it and reject, rather than
        // handing back a stream the caller would pipe out as object content.
        if (res.statusCode >= 400) {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { body += c; });
          res.on('end', () => {
            let parsed = null;
            try { parsed = JSON.parse(body); } catch { /* not JSON */ }
            const err = new Error((parsed && parsed.error) || `node ${res.statusCode}`);
            err.status = res.statusCode;
            reject(err);
          });
          return;
        }
        return resolve(res);
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch { parsed = { raw: data }; }
        if (res.statusCode >= 400) {
          const err = new Error((parsed && parsed.error) || `node ${res.statusCode}`);
          err.status = res.statusCode;
          return reject(err);
        }
        resolve(parsed);
      });
    });
    req.on('timeout', () => req.destroy(new Error('node timeout')));
    req.on('error', reject);
    if (body && typeof body.pipe === 'function') {
      body.on('error', (e) => req.destroy(e));
      body.pipe(req);
    } else if (body) {
      req.end(typeof body === 'string' ? body : JSON.stringify(body));
    } else {
      req.end();
    }
  });
}

// Streams a request body straight through to the node, which hashes as it
// writes and returns {hash, size, deduped}.
async function putBlob(node, readable, { contentLength, declaredHash } = {}) {
  const headers = { 'content-type': 'application/octet-stream' };
  if (contentLength != null) headers['content-length'] = String(contentLength);
  if (declaredHash) headers['x-expected-sha256'] = declaredHash;
  return request(node, { method: 'POST', path: '/blobs', headers, body: readable });
}

async function getBlobStream(node, hash, range) {
  const headers = {};
  if (range) headers.range = range;
  return request(node, { method: 'GET', path: `/blobs/${hash}`, headers, stream: true });
}

async function deleteBlob(node, hash) {
  return request(node, { method: 'DELETE', path: `/blobs/${hash}` });
}

async function stat(node) {
  return request(node, { method: 'GET', path: '/stat' });
}

async function verifyBlob(node, hash) {
  return request(node, { method: 'POST', path: `/blobs/${hash}/verify` });
}

async function get(id) {
  const { rows } = await db.query('SELECT * FROM nodes WHERE id = $1', [id]);
  return rows[0] || null;
}

async function pickWritable() {
  const { rows } = await db.query(
    `SELECT * FROM nodes WHERE enabled AND writable ORDER BY disk_free DESC NULLS LAST, id LIMIT 1`
  );
  if (!rows[0]) {
    const err = new Error('no writable storage node is registered');
    err.status = 503;
    throw err;
  }
  return rows[0];
}

// Heartbeat: the only thing that turns a node green in the UI. There is no
// separate reaper, so a node that stops answering goes stale here and the
// dashboard shows the age of last_seen_at rather than a bare "online".
async function heartbeatAll() {
  const { rows } = await db.query('SELECT * FROM nodes WHERE enabled');
  await Promise.all(rows.map(async (node) => {
    try {
      const s = await stat(node);
      await db.query(
        `UPDATE nodes SET last_seen_at = now(), agent_version = $2, disk_total = $3,
           disk_free = $4, last_error = NULL WHERE id = $1`,
        [node.id, s.version || null, s.disk_total || null, s.disk_free || null]
      );
    } catch (err) {
      await db.query('UPDATE nodes SET last_error = $2 WHERE id = $1', [node.id, err.message]);
    }
  }));
}

module.exports = {
  request, putBlob, getBlobStream, deleteBlob, stat, verifyBlob,
  get, pickWritable, heartbeatAll,
};
