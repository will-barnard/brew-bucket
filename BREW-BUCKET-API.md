# brew-bucket API

Base: `https://<your-instance>/api/v1`

Two credentials reach this API and neither substitutes for the other:

- **API key** — `X-API-Key: bb_…` or `Authorization: Bearer bb_…`. For machines.
- **Session cookie** — set by `/auth/login`. For the web console only.

A malformed or revoked key is a hard 401; it never degrades to an anonymous
request.

## Scopes

| Scope | Allows |
|---|---|
| `read` | GET, HEAD, list |
| `write` | PUT, presign, commit |
| `delete` | DELETE |
| `admin` | everything, plus minting admin-scoped keys |

A key may also be restricted to specific buckets. A key with no bucket
restriction reaches every bucket, so scope a backup key to `backups`.

## Objects

### `PUT /b/:bucket/o/:key`

Uploads. The key is everything after `/o/`, slashes included — `reports/q1.pdf`
is one key, not a directory. The body streams straight through to the storage
node; nothing is buffered.

```
Content-Type: application/gzip      → stored and returned on GET
Content-Length: 1048576             → checked against the quota before any bytes move
X-Content-Sha256: <hex>             → optional; the node rejects a mismatch
X-Meta-<name>: value                → arbitrary metadata, returned on list
```

→ `201 {"key","size","hash","version","deduped","bucket"}`

`deduped: true` means the content was already on the node and only a metadata
row was written.

### `GET /b/:bucket/o/:key`

| Query | Effect |
|---|---|
| `version=N` | fetch a specific version (versioned buckets only) |
| `download=1` | sets `Content-Disposition: attachment` |
| `direct=1` | on a direct-enabled bucket, `307` to a signed NAS URL instead of proxying |

Supports `Range`. Returns `ETag` (the sha256) and `X-Object-Version`.

### `HEAD /b/:bucket/o/:key`

Size, type, ETag, version, last-modified. No body, no transfer.

### `DELETE /b/:bucket/o/:key`

`?all=true` removes every version. Otherwise the current version goes and the
previous one, if any, becomes current.

### `GET /b/:bucket/o`

| Query | Default |
|---|---|
| `prefix` | `''` |
| `cursor` | `''` — pass back `next_cursor` |
| `limit` | 200, max 1000 |
| `versions=true` | include non-current versions |

→ `{"objects":[{key,version,size,content_type,metadata,created_at,blob_hash}],"next_cursor"}`

## Direct LAN transfers

Bytes skip the control plane entirely. Requires `allow_direct` on the bucket, a
`direct_base_url` on the node, and a client that can reach the NAS.

### `POST /b/:bucket/presign`

```json
{"op": "put", "key": "isos/big.iso", "hash": "<sha256 hex>"}
```
→ `{"op","url","method","expires_in","commit"}`

The grant is scoped to one hash and one operation, so a token for blob A can
never be replayed against blob B. `op: "get"` takes `key` instead of `hash` and
returns a download URL.

### `POST /b/:bucket/commit`

```json
{"key": "isos/big.iso", "hash": "<sha256 hex>", "content_type": "application/x-iso9660-image"}
```
→ `201 {"key","size","hash","version"}`

Commit asks the node how big the blob actually is rather than trusting the
client, so an object cannot be registered for content that never landed.

A 403 or 409 from `presign` means direct transfers are off for this bucket or
node — fall back to a plain `PUT`. The bundled clients do this automatically.

## Buckets, keys, nodes

Session-authenticated console endpoints; an `admin`-scoped key also reaches them.

```
GET    /buckets                  list with usage, object count, last write
POST   /buckets                  admin
GET    /buckets/:slug            detail + 30-day series + 20 recent writes
PATCH  /buckets/:slug            admin
DELETE /buckets/:slug?force=true admin

GET    /keys                     never returns secrets
POST   /keys                     returns the plaintext once, and only once
DELETE /keys/:id                 revoke

GET    /nodes                    with online state and disk capacity
POST   /nodes                    admin
POST   /nodes/:id/check          probe now instead of waiting for the heartbeat

GET    /activity                 ?action=object.put&limit=100
GET    /activity/overview        everything the dashboard needs, one round trip
POST   /activity/maintenance/sweep   admin; runs retention + orphan reclaim now

POST   /shares                   {bucket,key,expires_hours,max_hits} → {token,path}
GET    /s/:token                 public, unauthenticated download
```

## Status codes

| Code | Means | Client should |
|---|---|---|
| 401 | missing, malformed, revoked or expired key | fail loudly — config error, never retry |
| 403 | key lacks the scope, or the bucket for this key | fail loudly — caller bug |
| 404 | no such bucket or object | |
| 409 | commit for a blob that never landed | re-upload |
| 413 | object exceeds the bucket's size cap | |
| 422 | bad key, bad hash, missing field | fail loudly |
| 429 | rate limited | back off |
| 503 | no writable storage node registered, or the NAS is unreachable | retry with backoff; this is the common one |
| 507 | bucket quota exceeded | stop; raise the quota or delete something |

503 is worth special handling. The NAS being asleep, rebooting or off the LAN
all look identical from here, and a backup job that treats it as fatal will page
you for something that resolves itself.

## Webhooks

Rows in the `webhooks` table fire on `object.put` and `object.delete`, signed
like GitHub's: `X-Brew-Signature: sha256=<hmac of the raw body>`. Useful for
picking up a build artifact the moment it lands rather than polling.

## Node.js

```js
import { BrewBucket } from './brew-bucket.js';

const bb = new BrewBucket({
  baseUrl: process.env.BREW_BUCKET_URL,
  apiKey: process.env.BREW_BUCKET_KEY,
});

await bb.putFile('artifacts', 'builds/app-1.2.3.tar.gz', './dist/app.tar.gz');
await bb.putFileDirect('backups', 'db/nightly.sql.gz', '/tmp/nightly.sql.gz'); // LAN fast path
const { objects } = await bb.list('artifacts', { prefix: 'builds/' });
await bb.getFile('artifacts', objects[0].key, './restored.tar.gz');
const { path } = await bb.share('uploads', 'photo.jpg', { expiresHours: 24 });
```

## Python

```python
from brew_bucket import BrewBucket

bb = BrewBucket(base_url=os.environ["BREW_BUCKET_URL"],
                api_key=os.environ["BREW_BUCKET_KEY"])

bb.put_file("backups", "db/nightly.sql.gz", "/tmp/nightly.sql.gz",
            content_type="application/gzip")

for obj in bb.list("backups", prefix="db/")["objects"]:
    print(obj["key"], obj["size"])
```

Both clients stream from disk rather than reading files into memory, which is
what makes a 40 GB backup work at all.
