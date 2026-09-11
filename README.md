# brew-bucket

A lightweight storage API with a web console. Two halves, deployed separately:

| Half | Runs on | What it is | Deployed by |
|---|---|---|---|
| **Control plane** | mac mini | Vue console + Express API + Postgres. Holds metadata, users, keys, and nothing else. | Beachhead |
| **Storage node** | NAS | A small Express agent over a content-addressed blob store on disk. | `scripts/nas-*.sh` over ssh |

Only the mini has 80/443. The NAS is never exposed to the internet; the control
plane reaches it over the LAN, and can hand LAN clients a short-lived signed URL
to talk to it directly when a bucket opts in.

```
            internet
                |
          :443  v
    ┌──────────────────────┐
    │  mac mini (Beachhead)│   metadata, auth, quotas, audit
    │  frontend · backend  │
    │  postgres            │
    └──────────┬───────────┘
               │ LAN, shared secret
               v
    ┌──────────────────────┐
    │  NAS storage node    │   the actual bytes
    │  /data/blobs/ab/cd/… │
    └──────────────────────┘
               ^
               └── presigned direct transfers (LAN clients, opt-in per bucket)
```

## Buckets

Three are created on first boot:

| Bucket | For | Default retention |
|---|---|---|
| `uploads` | user-uploaded files | keep |
| `backups` | application and database backups | delete after 90 days |
| `artifacts` | generated files and build artifacts | keep |

Retention on `backups` is on by default because nothing else ever deletes a
backup, and a full NAS makes every other bucket fail writes with no obvious
cause.

## Deploying the control plane

Beachhead clones the repo and reads `beachhead.json`. Set these as **global**
env vars in the Beachhead dashboard (no Target Service — `${VAR}` in
`docker-compose.yml` only resolves from `.env`):

| Var | Notes |
|---|---|
| `DB_PASSWORD` | postgres password |
| `SESSION_SECRET` | signs web sessions; rotating it logs everyone out |
| `NODE_SHARED_SECRET` | must match the NAS node's value |
| `DIRECT_URL_SECRET` | signs presigned direct URLs; blank reuses `NODE_SHARED_SECRET` |
| `PUBLIC_URL` | e.g. `https://bucket.brew.rip`, used in clone URLs |
| `MAX_OBJECT_BYTES` | default 5 GB |
| `CORS_ORIGINS` | comma-separated, for browser uploads from your other apps |
| `BREW_BUCKET_GIT` | `1` to enable git transport (not implemented yet) |

Generate the secrets with `openssl rand -hex 32`.

First visit lands on the setup page: **the first account created becomes admin**,
and registration closes behind it. Everyone after joins by invite.

## Deploying the storage node

```bash
cp scripts/nas.env.example scripts/nas.env
$EDITOR scripts/nas.env          # ssh target, storage path, shared secret
./scripts/nas-deploy.sh          # build, ship over ssh, start, health check
```

`nas-deploy.sh` builds for `linux/amd64` (a Mac building natively would produce
an arm64 image the NAS silently cannot run), streams it over ssh with
`docker save | ssh docker load` — no registry, and the NAS needs no outbound
internet — writes `.env` and compose on the NAS, and starts the container.

Then register the node in the console under **Storage nodes**:

- Internal URL: `http://nas.lan:8477` — how the mini reaches it
- Direct base URL: same, or blank to disable direct transfers

| Script | Does |
|---|---|
| `nas-deploy.sh` | first-time setup |
| `nas-update.sh` | rebuild, ship, recreate the container |
| `nas-status.sh` | health, capacity, blob count |
| `nas-logs.sh` | tail logs (`-f` to follow) |
| `nas-restart.sh` | restart the container |
| `nas-build.sh` / `nas-push-image.sh` | the two halves of an update, separately |

Blob data lives in a bind mount, so recreating the container never touches it.

## Using it

```bash
curl -X PUT "$BREW_BUCKET_URL/api/v1/b/backups/o/myapp/db-2026-09-11.sql.gz" \
  -H "X-API-Key: $BREW_BUCKET_KEY" \
  -H "Content-Type: application/gzip" \
  --data-binary @dump.sql.gz
```

Drop-in clients are in `clients/` — `brew-bucket.js` (Node 18+, no deps) and
`brew_bucket.py` (requests). The full contract is in
[BREW-BUCKET-API.md](BREW-BUCKET-API.md). The console's **Integrate** page
renders these snippets pre-filled for whichever bucket you pick.

## How it stores things

Objects are metadata rows pointing at content-addressed blobs. Two uploads of
identical content become one blob with a refcount of 2, so the dashboard shows
*stored* (logical) and *on disk* (physical) separately and the gap is real
savings.

Deleting an object drops the refcount. Blobs at zero are reclaimed by a sweeper
rather than deleted inline, so a delete never waits on the NAS and a crashed
sweep is simply retried.

Uploads stream end to end — request → backend → NAS — and are hashed on the way
past. The blob is written to a temp file and renamed into place only once
complete, so a half-written blob can never be served.

## Local development

```bash
# backend
cd backend && npm install && DB_HOST=localhost SESSION_SECRET=dev NODE_SHARED_SECRET=dev npm run dev

# storage node
cd node && npm install && DATA_DIR=/tmp/bb NODE_SHARED_SECRET=dev npm start

# frontend (proxies /api to :3001)
cd frontend && npm install && npm run dev
```

## What is not built yet

- **File browser.** The bucket page shows the 20 most recent writes; there is no
  tree view. List programmatically with `GET /api/v1/b/:bucket/o?prefix=`.
- **Git transport.** The schema, routes, repo CRUD and auth path exist; clone and
  push return 501 until `BREW_BUCKET_GIT=1` and a git-capable node ship. See the
  header comment in `backend/src/routes/git.js`.
- **Multipart/resumable uploads.** A dropped connection on a 40 GB backup starts
  over. Content addressing means the retry is cheap to detect but not cheap to
  repeat.
- **Integrity scrubbing.** The node can re-hash a blob on demand
  (`POST /blobs/:hash/verify`) and `blobs.verified_at` exists, but nothing walks
  the store on a schedule yet.
