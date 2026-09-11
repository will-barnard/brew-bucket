-- Git bucket scaffolding. Inert until BREW_BUCKET_GIT=1.
CREATE TABLE IF NOT EXISTS git_repos (
  id          SERIAL PRIMARY KEY,
  bucket_id   INTEGER NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  description TEXT,
  size_bytes  BIGINT NOT NULL DEFAULT 0,
  last_push_at TIMESTAMPTZ,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS git_repos_bucket_name_idx ON git_repos (bucket_id, name);
