# Deploying brew-bucket

Two halves, deployed separately. Do them in this order — the control plane can
come up without a storage node (uploads just 503 until one is registered), but
the node needs a secret that you generate in step 1.

- [0. Before you start](#0-before-you-start)
- [1. Generate the secrets](#1-generate-the-secrets)
- [2. Push the repo](#2-push-the-repo)
- [3. Deploy the control plane on Beachhead](#3-deploy-the-control-plane-on-beachhead)
- [4. Create the admin account](#4-create-the-admin-account)
- [5. Deploy the storage node on the NAS](#5-deploy-the-storage-node-on-the-nas)
- [6. Register the node](#6-register-the-node)
- [7. Verify end to end](#7-verify-end-to-end)
- [Updating later](#updating-later)
- [When something fails](#when-something-fails)

---

## 0. Before you start

On the machine you'll run the NAS scripts from (your Mac is fine):

- **Docker running.** The scripts build the node image locally and stream it to
  the NAS. On Apple Silicon, building an amd64 image runs `npm install` under
  emulation — it works, it's just slow the first time.
- **Key-based ssh to the NAS.** The scripts use `BatchMode=yes` and will not
  answer a password prompt:
  ```bash
  ssh-copy-id -p 32 wbarnard1@192.168.1.123
  ssh -p 32 wbarnard1@192.168.1.123 'docker version'   # must succeed with no prompt
  ```
  On Synology, ssh is off by default (Control Panel → Terminal & SNMP → Enable
  SSH).

  **DSM's docker socket is root-owned**, so `docker` over a non-interactive ssh
  usually needs `sudo`, and `sudo` without a tty needs a NOPASSWD rule. The
  scripts detect this and fall back automatically, but if neither works you'll
  need, on the NAS:

  ```bash
  echo 'wbarnard1 ALL=(ALL) NOPASSWD: /usr/local/bin/docker' | sudo tee /etc/sudoers.d/brew-bucket-docker
  sudo chmod 440 /etc/sudoers.d/brew-bucket-docker
  ```

  The user must be in DSM's **administrators** group for that to apply.
- **A shared folder for the blobs.** On DSM, `/volume1` is the volume root —
  only shared folders created through DSM's UI can live there, and no ssh user
  can `mkdir` into it. Create one before deploying:

  **Control Panel → Shared Folder → Create**, name `brew-bucket`, location
  `/volume1`, and grant your ssh user read/write on it.

  That gives you `/volume1/brew-bucket` with its own entry in Storage Manager,
  so you can put a quota on it and control snapshots separately from everything
  else. Storing blobs inside the existing `docker` shared folder works too, but
  mixes bulk data in with container config and grows it unboundedly.

  The scripts refuse to deploy if they can't write there, because Docker would
  otherwise silently create an empty directory and store your objects somewhere
  you didn't mean.

On the Beachhead side: a DNS record for the domain you're going to use, pointing
at the mini, resolving before you deploy — Let's Encrypt validation happens
during the deploy and fails if DNS isn't live yet.

---

## 1. Generate the secrets

Generate all four now; you'll paste two of them into the Beachhead dashboard and
two into `scripts/nas.env`, and two of those must match exactly.

```bash
echo "DB_PASSWORD=$(openssl rand -hex 32)"
echo "SESSION_SECRET=$(openssl rand -hex 32)"
echo "NODE_SHARED_SECRET=$(openssl rand -hex 32)"
echo "DIRECT_URL_SECRET=$(openssl rand -hex 32)"
```

| Secret | Goes in | Notes |
|---|---|---|
| `DB_PASSWORD` | Beachhead only | postgres |
| `SESSION_SECRET` | Beachhead only | signs web sessions; rotating it logs everyone out |
| `NODE_SHARED_SECRET` | **both** | the mini presents this to the NAS on every internal call |
| `DIRECT_URL_SECRET` | **both** | signs presigned direct-transfer URLs |

`NODE_SHARED_SECRET` and `DIRECT_URL_SECRET` must be **identical** on both sides.
A mismatch on the first gives you 401s from the node on every upload; on the
second, direct transfers fail while proxied ones keep working — which is a
confusing failure, so set both properly now.

You can leave `DIRECT_URL_SECRET` blank in both places and it reuses
`NODE_SHARED_SECRET`. Fine to start with; separate them if you ever want to
rotate direct-URL signing without redeploying the node.

---

## 2. Push the repo

Beachhead clones from GitHub, so nothing deploys until the code is pushed.

```bash
cd ~/workspace/brew-bucket
git add .
git commit -m "brew-bucket: initial control plane, storage node and deploy scripts"
git push -u origin main
```

`scripts/nas.env` is gitignored and never pushed — it holds the ssh target and
the shared secrets.

---

## 3. Deploy the control plane on Beachhead

In the Beachhead dashboard:

**Create the app**

| Field | Value |
|---|---|
| Repository | `https://github.com/will-barnard/brew-bucket` |
| Branch | `main` |
| Domain | e.g. `bucket.brew.rip` |

**Add the env vars.** All of these must be **global** — no Target Service. The
ones referenced as `${VAR}` in `docker-compose.yml` only resolve from `.env`,
and a targeted-only `DB_PASSWORD` silently becomes an empty string in the
postgres service.

| Var | Value |
|---|---|
| `DB_PASSWORD` | from step 1 |
| `SESSION_SECRET` | from step 1 |
| `NODE_SHARED_SECRET` | from step 1 |
| `DIRECT_URL_SECRET` | from step 1, or blank |
| `PUBLIC_URL` | `https://bucket.brew.rip` |
| `MAX_OBJECT_BYTES` | `5368709120` (5 GB), or higher |
| `CORS_ORIGINS` | blank, or a comma-separated list of your other apps' origins |
| `BREW_BUCKET_GIT` | `0` |

`CORS_ORIGINS` only matters if a **browser** on another one of your domains will
upload directly. Server-to-server calls never hit CORS — leave it blank unless
you need it.

**Deploy.** Push-to-deploy via the webhook, or trigger manually. Watch the
deployment log; it should walk `CLONING → ENV_INJECTION → BUILDING →
STARTING_CONTAINERS → PROXY_SETUP → VERIFY_HEALTH → SUCCESS`.

The backend refuses to boot without `SESSION_SECRET` and exits, so a missing one
shows up as a failure at `VERIFY_HEALTH` with the backend crash-looping — check
the container logs, not the nginx config, if that happens.

---

## 4. Create the admin account

Visit `https://bucket.brew.rip`. With no users in the database it redirects to
the setup page.

**The first account created becomes admin, and registration closes behind it.**
Everyone after joins by invite (Users → Invite, which hands you a link to
deliver yourself — there's no mail server).

Do this before anything else is reachable. The window where registration is open
is the window where anyone who finds the URL can claim the instance.

---

## 5. Deploy the storage node on the NAS

`scripts/nas.env` is already filled in with the connection details
(`192.168.1.123`, user `wbarnard1`, port `32`). Two things still need deciding:
the shared secrets, and the storage path.

**Probe first.** This is the only step that tells you what the NAS actually is
rather than what the defaults assume — architecture, whether docker is reachable
over a non-interactive ssh, and which volumes exist with how much space:

```bash
./scripts/nas-probe.sh
```

Set `NAS_STORAGE_PATH` to a path under whichever volume it reports, and paste
the two secrets from step 1 in. Then:

```bash
./scripts/nas-deploy.sh
```

It checks ssh and docker, asks the NAS what architecture it is and builds for
that, creates the directories, writes compose and a `chmod 600` `.env` over
stdin (so the secrets never land in a local temp file), streams the image with
`docker save | ssh docker load` — no registry, and the NAS needs no outbound
internet — starts the container and polls for health.

On success it prints the exact values to paste in step 6.

**Do not port-forward 8477 at the router.** The mini is the only public entry
point; the node trusts anything holding the shared secret.

---

## 6. Register the node

In the console, **Storage nodes → Add node**:

| Field | Value | Meaning |
|---|---|---|
| Name | `nas` | |
| Internal URL | `http://192.168.1.123:8477` | how the mini reaches it |
| Direct base URL | `http://192.168.1.123:8477` | what LAN clients are handed; **blank disables direct transfers** |

**Give the NAS a static address before you do this.** The internal URL is stored
in the database, not resolved fresh each time. If the NAS is on DHCP and takes a
new lease, every upload starts failing with a connection error and nothing in
the UI points at the cause. Either reserve `192.168.1.123` for its MAC in your
router, or give it a hostname that resolves on the LAN and use that here
instead — the latter is the more durable choice, and you can change it later
under Storage nodes without touching the node itself.

Hit **Test**. You should get disk capacity back within a second. Until a node is
registered and enabled, every upload returns 503.

Direct transfers are then opt-in *per bucket* — turn on "Allow direct LAN
transfers" on a bucket only if its clients are on the LAN. Leave it off for
anything served to browsers over the internet; those clients can't route to
`192.168.1.123` and the presigned URL is useless to them.

---

## 7. Verify end to end

Mint a key (API keys → New key, scopes `read` + `write` + `delete`, no bucket
restriction, for this test only), then:

```bash
export BREW_BUCKET_URL=https://bucket.brew.rip
export BREW_BUCKET_KEY=bb_xxxx_yyyy

echo "hello from $(date)" > /tmp/hello.txt

# upload
curl -fsS -X PUT "$BREW_BUCKET_URL/api/v1/b/uploads/o/test/hello.txt" \
  -H "X-API-Key: $BREW_BUCKET_KEY" -H "Content-Type: text/plain" \
  --data-binary @/tmp/hello.txt
# → {"key":"test/hello.txt","size":...,"hash":"...","version":1,"deduped":false,...}

# read it back
curl -fsS "$BREW_BUCKET_URL/api/v1/b/uploads/o/test/hello.txt" \
  -H "X-API-Key: $BREW_BUCKET_KEY"

# upload the identical bytes again — should come back deduped:true, version:2
curl -fsS -X PUT "$BREW_BUCKET_URL/api/v1/b/uploads/o/test/hello-again.txt" \
  -H "X-API-Key: $BREW_BUCKET_KEY" --data-binary @/tmp/hello.txt

# list
curl -fsS "$BREW_BUCKET_URL/api/v1/b/uploads/o?prefix=test/" \
  -H "X-API-Key: $BREW_BUCKET_KEY"

# clean up
curl -fsS -X DELETE "$BREW_BUCKET_URL/api/v1/b/uploads/o/test/hello.txt" \
  -H "X-API-Key: $BREW_BUCKET_KEY"
curl -fsS -X DELETE "$BREW_BUCKET_URL/api/v1/b/uploads/o/test/hello-again.txt" \
  -H "X-API-Key: $BREW_BUCKET_KEY"
```

`deduped: true` on the second upload is the real end-to-end proof: the mini
hashed the stream, the NAS recognised the content it already had, and only a
metadata row was written.

Then confirm on the NAS side:

```bash
./scripts/nas-status.sh
```

Revoke the test key when you're done and mint narrower ones per job — a backup
script wants `write` only, restricted to `backups`.

---

## Updating later

**Control plane:** push to `main`. The webhook does the rest. Postgres is
declared stateful in `beachhead.json`, so it survives the blue/green swap and
your data and sessions persist. Schema changes ride the boot path — add a
numbered file to `backend/src/db/migrations/` and it applies on next start.

**Storage node:**

```bash
./scripts/nas-update.sh
```

Rebuilds, ships, recreates the container and prunes old images. Blob data is a
bind mount, so recreating never touches it.

They version independently and that's fine — the node's API surface is small and
stable. Update the node when you change anything under `node/`.

---

## When something fails

| Symptom | Cause | Fix |
|---|---|---|
| Deploy fails at `VERIFY_HEALTH`, backend restarting | `SESSION_SECRET` not set, or set as a targeted var | set it **global** in the dashboard |
| `${DB_PASSWORD}` empty in postgres logs | var is targeted, so never written to `.env` | make it global |
| Every upload returns 503 | no node registered, or the node is disabled/unreachable | Storage nodes → Test; check `./scripts/nas-status.sh` |
| Uploads return 401 from the node | `NODE_SHARED_SECRET` differs between Beachhead and the NAS | re-check both; they must match byte for byte |
| Proxied uploads work, direct ones 401 | `DIRECT_URL_SECRET` differs, or is set on one side only | set both, or blank on both |
| `exec format error` in the NAS container log | image built for the wrong architecture | `nas-deploy.sh` now detects this; if you overrode `BUILD_PLATFORM`, remove it |
| `nas-deploy.sh` can't ssh | key auth not set up, or ssh disabled on the NAS | `ssh-copy-id -p 32 wbarnard1@192.168.1.123`, and enable SSH in the NAS control panel |
| Uploads worked, then started failing with connection errors | the NAS took a new DHCP lease and the stored internal URL is stale | reserve its IP, or switch the node to a hostname under Storage nodes |
| `docker is not usable as <user>` | DSM's root-owned socket, no NOPASSWD sudo | add the sudoers rule in step 0, or set `NAS_DOCKER="sudo -n /usr/local/bin/docker"` |
| `mkdir: cannot create directory '/volume1/…': Permission denied` | DSM only allows shared folders at the volume root | create it as a shared folder in Control Panel, or point `NAS_STORAGE_PATH` inside a folder you already have |
| Screens of `post-quantum key exchange` warnings | OpenSSH 10 on macOS vs the NAS's older sshd | cosmetic; the scripts now pass `LogLevel=ERROR` |
| `subsystem request failed on channel 0` / `scp: Connection closed` | OpenSSH 9+ scp uses SFTP, which DSM doesn't enable | fixed — the scripts pipe over plain ssh instead of scp |
| Node healthy on the NAS, `Host is unreachable` from the backend container | Docker handed the app a `192.168.x` subnet overlapping the LAN, because its default `172.17.0.0/12` pool was exhausted | set `default-address-pools` to `{base: 172.16.0.0/12, size: 24}` in the Docker daemon config, restart Docker, remove the app's network, redeploy |
| `network <id> not found` starting a stateful container | its network was removed while the container merely existed, leaving a stale network ID in its config | `docker rm -f` the container and redeploy — named volumes are external and survive |
| Node healthy on the NAS but Test fails from the console | DSM firewall blocking 8477 | Control Panel → Security → Firewall, allow 8477 from the LAN |
| 413 on a large upload | something in front of nginx capping the body | the app's nginx sets `client_max_body_size 0`; check the Beachhead proxy |
| Objects "disappear" after a redeploy | volume lost its fixed name | shouldn't happen — `brew-bucket-postgres` is pinned in compose; check you didn't edit it |
| Setup page shows after you already made an admin | you're looking at a fresh database | the postgres volume was recreated; check `stateful_services` in `beachhead.json` |

For anything else, the deployment log in the Beachhead dashboard and
`./scripts/nas-logs.sh -f` cover both halves.
