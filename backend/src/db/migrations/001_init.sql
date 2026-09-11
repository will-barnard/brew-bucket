-- brew-bucket core schema

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',      -- admin | user | readonly
  disabled      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS invites (
  token      TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'user',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Storage nodes (the NAS agents). The control plane never stores bytes itself.
CREATE TABLE IF NOT EXISTS nodes (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  internal_url    TEXT NOT NULL,            -- how the mini reaches it, e.g. http://nas.lan:8477
  direct_base_url TEXT,                     -- LAN URL handed to clients for direct transfers; NULL disables direct
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  writable        BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen_at    TIMESTAMPTZ,
  agent_version   TEXT,
  disk_total      BIGINT,
  disk_free       BIGINT,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS buckets (
  id            SERIAL PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  description   TEXT,
  kind          TEXT NOT NULL DEFAULT 'blob',       -- blob | git
  node_id       INTEGER REFERENCES nodes(id) ON DELETE RESTRICT,
  quota_bytes   BIGINT,                             -- NULL = unlimited
  public_read   BOOLEAN NOT NULL DEFAULT FALSE,
  allow_direct  BOOLEAN NOT NULL DEFAULT FALSE,     -- opt in to presigned direct-to-NAS transfers
  versioning    BOOLEAN NOT NULL DEFAULT FALSE,
  max_versions  INTEGER,                            -- retention: keep N newest versions
  max_age_days  INTEGER,                            -- retention: delete objects older than N days
  max_object_bytes BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- Content-addressed blobs. Many objects may point at one blob (dedup).
CREATE TABLE IF NOT EXISTS blobs (
  hash        TEXT PRIMARY KEY,                     -- sha256 hex
  node_id     INTEGER NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  size        BIGINT NOT NULL,
  refcount    INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at TIMESTAMPTZ,
  corrupt     BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS blobs_orphan_idx ON blobs (refcount) WHERE refcount <= 0;

CREATE TABLE IF NOT EXISTS objects (
  id            BIGSERIAL PRIMARY KEY,
  bucket_id     INTEGER NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  blob_hash     TEXT NOT NULL REFERENCES blobs(hash) ON DELETE RESTRICT,
  size          BIGINT NOT NULL,
  content_type  TEXT NOT NULL DEFAULT 'application/octet-stream',
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_current    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_key_id  INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS objects_bucket_key_version_idx ON objects (bucket_id, key, version);
CREATE UNIQUE INDEX IF NOT EXISTS objects_current_idx ON objects (bucket_id, key) WHERE is_current;
CREATE INDEX IF NOT EXISTS objects_prefix_idx ON objects (bucket_id, key text_pattern_ops) WHERE is_current;
CREATE INDEX IF NOT EXISTS objects_created_idx ON objects (bucket_id, created_at DESC);

CREATE TABLE IF NOT EXISTS api_keys (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  prefix       TEXT NOT NULL UNIQUE,               -- shown in the UI, e.g. bb_7f3a91
  secret_hash  TEXT NOT NULL,                      -- sha256 of the full key
  scopes       TEXT[] NOT NULL DEFAULT '{read}',   -- read | write | delete | admin
  bucket_ids   INTEGER[],                          -- NULL = all buckets
  owner_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  expires_at   TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  last_used_ip TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS share_links (
  token      TEXT PRIMARY KEY,
  object_id  BIGINT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ,
  max_hits   INTEGER,
  hits       INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS activity_log (
  id         BIGSERIAL PRIMARY KEY,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  action     TEXT NOT NULL,                        -- object.put, object.get, key.create, ...
  bucket_id  INTEGER REFERENCES buckets(id) ON DELETE SET NULL,
  object_key TEXT,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  key_id     INTEGER REFERENCES api_keys(id) ON DELETE SET NULL,
  ip         TEXT,
  bytes      BIGINT,
  ok         BOOLEAN NOT NULL DEFAULT TRUE,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS activity_at_idx ON activity_log (at DESC);

-- Daily rollup so the dashboard chart never scans activity_log.
CREATE TABLE IF NOT EXISTS usage_daily (
  day         DATE NOT NULL,
  bucket_id   INTEGER NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
  bytes_in    BIGINT NOT NULL DEFAULT 0,
  bytes_out   BIGINT NOT NULL DEFAULT 0,
  puts        INTEGER NOT NULL DEFAULT 0,
  gets        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, bucket_id)
);

CREATE TABLE IF NOT EXISTS webhooks (
  id         SERIAL PRIMARY KEY,
  bucket_id  INTEGER REFERENCES buckets(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  secret     TEXT,
  events     TEXT[] NOT NULL DEFAULT '{object.put}',
  enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);
