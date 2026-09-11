// brew-bucket client for Node 18+. No dependencies — drop this file into any
// project and wire BREW_BUCKET_URL and BREW_BUCKET_KEY as env vars.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

export class BrewBucket {
  constructor({ baseUrl, apiKey, timeoutMs = 0 }) {
    if (!baseUrl) throw new Error('baseUrl is required');
    if (!apiKey) throw new Error('apiKey is required');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }

  get headers() { return { 'x-api-key': this.apiKey }; }

  async #json(method, path, body) {
    const res = await fetch(`${this.baseUrl}/api/v1${path}`, {
      method,
      headers: { ...this.headers, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error((data && data.error) || `HTTP ${res.status}`), { status: res.status });
    return data;
  }

  list(bucket, { prefix = '', cursor = '', limit = 200 } = {}) {
    const q = new URLSearchParams({ prefix, cursor, limit: String(limit) });
    return this.#json('GET', `/b/${bucket}/o?${q}`);
  }

  head(bucket, key) {
    return fetch(`${this.baseUrl}/api/v1/b/${bucket}/o/${encode(key)}`, { method: 'HEAD', headers: this.headers })
      .then((r) => (r.ok
        ? { size: Number(r.headers.get('content-length')), contentType: r.headers.get('content-type'), hash: (r.headers.get('etag') || '').replace(/"/g, '') }
        : null));
  }

  // Streams the request body. A multi-GB file never lands in memory.
  async put(bucket, key, body, { contentType = 'application/octet-stream', contentLength, metadata = {} } = {}) {
    const headers = { ...this.headers, 'content-type': contentType };
    if (contentLength != null) headers['content-length'] = String(contentLength);
    for (const [k, v] of Object.entries(metadata)) headers[`x-meta-${k}`] = String(v);

    const res = await fetch(`${this.baseUrl}/api/v1/b/${bucket}/o/${encode(key)}`, {
      method: 'PUT',
      headers,
      body: body instanceof Readable ? Readable.toWeb(body) : body,
      duplex: 'half',
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error((data && data.error) || `HTTP ${res.status}`), { status: res.status });
    return data;
  }

  async putFile(bucket, key, filePath, opts = {}) {
    const { size } = await fs.promises.stat(filePath);
    return this.put(bucket, key, fs.createReadStream(filePath), { contentLength: size, ...opts });
  }

  async get(bucket, key, { version, direct = false } = {}) {
    const q = new URLSearchParams();
    if (version) q.set('version', String(version));
    if (direct) q.set('direct', '1');
    const res = await fetch(`${this.baseUrl}/api/v1/b/${bucket}/o/${encode(key)}?${q}`, {
      headers: this.headers,
      redirect: 'follow',
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw Object.assign(new Error((data && data.error) || `HTTP ${res.status}`), { status: res.status });
    }
    return res;
  }

  async getFile(bucket, key, destPath, opts = {}) {
    const res = await this.get(bucket, key, opts);
    await fs.promises.writeFile(destPath, Readable.fromWeb(res.body));
    return destPath;
  }

  delete(bucket, key, { allVersions = false } = {}) {
    return this.#json('DELETE', `/b/${bucket}/o/${encode(key)}${allVersions ? '?all=true' : ''}`);
  }

  // Direct LAN upload: three steps, and worth it only for large files on the
  // same network. Falls back to the proxied path automatically when the bucket
  // or the node has direct transfers switched off.
  async putFileDirect(bucket, key, filePath, opts = {}) {
    const hash = await sha256File(filePath);
    let grant;
    try {
      grant = await this.#json('POST', `/b/${bucket}/presign`, { op: 'put', key, hash });
    } catch (err) {
      if (err.status === 403 || err.status === 409) return this.putFile(bucket, key, filePath, opts);
      throw err;
    }
    const { size } = await fs.promises.stat(filePath);
    const res = await fetch(grant.url, {
      method: 'PUT',
      headers: { 'content-length': String(size) },
      body: Readable.toWeb(fs.createReadStream(filePath)),
      duplex: 'half',
    });
    if (!res.ok) throw new Error(`direct upload failed: HTTP ${res.status}`);
    return this.#json('POST', `/b/${bucket}/commit`, { key, hash, content_type: opts.contentType });
  }

  share(bucket, key, { expiresHours = 168, maxHits = null } = {}) {
    return this.#json('POST', '/shares', { bucket, key, expires_hours: expiresHours, max_hits: maxHits });
  }
}

function encode(key) {
  return key.split('/').map(encodeURIComponent).join('/');
}

export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    fs.createReadStream(filePath).on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}
