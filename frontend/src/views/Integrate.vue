<script setup>
import { ref, onMounted, computed } from 'vue';
import { api } from '../lib/api';

const buckets = ref([]);
const bucket = ref('uploads');
const tab = ref('curl');
const origin = computed(() => location.origin);

onMounted(async () => {
  try {
    buckets.value = (await api.get('/buckets')).buckets;
    if (buckets.value.length && !buckets.value.find((b) => b.slug === bucket.value)) {
      bucket.value = buckets.value[0].slug;
    }
  } catch { /* the snippets are still useful without the list */ }
});

const curl = computed(() => `export BREW_BUCKET_URL=${origin.value}
export BREW_BUCKET_KEY=bb_xxxx_yyyy

# upload
curl -X PUT "$BREW_BUCKET_URL/api/v1/b/${bucket.value}/o/reports/2026-q1.pdf" \\
  -H "X-API-Key: $BREW_BUCKET_KEY" \\
  -H "Content-Type: application/pdf" \\
  --data-binary @report.pdf

# download
curl -O -J "$BREW_BUCKET_URL/api/v1/b/${bucket.value}/o/reports/2026-q1.pdf?download=1" \\
  -H "X-API-Key: $BREW_BUCKET_KEY"

# list a prefix
curl -s "$BREW_BUCKET_URL/api/v1/b/${bucket.value}/o?prefix=reports/" \\
  -H "X-API-Key: $BREW_BUCKET_KEY" | jq

# delete
curl -X DELETE "$BREW_BUCKET_URL/api/v1/b/${bucket.value}/o/reports/2026-q1.pdf" \\
  -H "X-API-Key: $BREW_BUCKET_KEY"`);

const node = computed(() => `// npm i --save nothing: this uses built-in fetch on Node 18+
import { BrewBucket } from './brew-bucket.js';

const bb = new BrewBucket({
  baseUrl: process.env.BREW_BUCKET_URL,
  apiKey: process.env.BREW_BUCKET_KEY,
});

// Streams from disk; nothing is buffered in memory.
await bb.putFile('${bucket.value}', 'builds/app-1.2.3.tar.gz', './dist/app.tar.gz');

const { objects } = await bb.list('${bucket.value}', { prefix: 'builds/' });
await bb.getFile('${bucket.value}', objects[0].key, './restored.tar.gz');`);

const python = computed(() => `from brew_bucket import BrewBucket

bb = BrewBucket(base_url=os.environ["BREW_BUCKET_URL"],
                api_key=os.environ["BREW_BUCKET_KEY"])

bb.put_file("${bucket.value}", "db/nightly.sql.gz", "/tmp/nightly.sql.gz")

for obj in bb.list("${bucket.value}", prefix="db/")["objects"]:
    print(obj["key"], obj["size"])`);

const backup = computed(() => `#!/usr/bin/env bash
# Nightly postgres backup straight into brew-bucket.
# Retention is the bucket's job: set "delete after N days" on \`backups\` and
# nothing here ever has to clean up.
set -euo pipefail

STAMP=$(date +%Y-%m-%d)
pg_dump "$DATABASE_URL" | gzip > "/tmp/db-$STAMP.sql.gz"

curl -fsS -X PUT \\
  "$BREW_BUCKET_URL/api/v1/b/backups/o/myapp/db-$STAMP.sql.gz" \\
  -H "X-API-Key: $BREW_BUCKET_KEY" \\
  -H "Content-Type: application/gzip" \\
  --data-binary "@/tmp/db-$STAMP.sql.gz"

rm -f "/tmp/db-$STAMP.sql.gz"`);

const direct = computed(() => `# Direct LAN transfer: bytes go straight to the NAS and skip this server.
# Requires the bucket to have "allow direct" on, and the client to be on the LAN.

HASH=$(sha256sum big.iso | cut -d' ' -f1)

# 1. ask for a grant
GRANT=$(curl -s -X POST "$BREW_BUCKET_URL/api/v1/b/${bucket.value}/presign" \\
  -H "X-API-Key: $BREW_BUCKET_KEY" -H "Content-Type: application/json" \\
  -d "{\\"op\\":\\"put\\",\\"key\\":\\"isos/big.iso\\",\\"hash\\":\\"$HASH\\"}")

# 2. PUT the bytes at the NAS yourself
curl -X PUT "$(echo "$GRANT" | jq -r .url)" --data-binary @big.iso

# 3. register the object
curl -s -X POST "$BREW_BUCKET_URL/api/v1/b/${bucket.value}/commit" \\
  -H "X-API-Key: $BREW_BUCKET_KEY" -H "Content-Type: application/json" \\
  -d "{\\"key\\":\\"isos/big.iso\\",\\"hash\\":\\"$HASH\\"}"`);

const snippets = computed(() => ({ curl: curl.value, node: node.value, python: python.value, backup: backup.value, direct: direct.value }));
const labels = { curl: 'curl', node: 'Node.js', python: 'Python', backup: 'Backup cron', direct: 'Direct LAN upload' };
</script>

<template>
  <h1>Integrate</h1>
  <p class="sub">Ready-to-paste clients for the bucket you pick.</p>

  <div class="row" style="margin-bottom:16px">
    <div class="shrink" style="min-width:200px">
      <label>Bucket</label>
      <select v-model="bucket"><option v-for="b in buckets" :key="b.id" :value="b.slug">{{ b.slug }}</option></select>
    </div>
  </div>

  <div class="flex" style="flex-wrap:wrap;margin-bottom:14px">
    <button v-for="(label, k) in labels" :key="k" class="sm" :class="tab === k ? 'primary' : ''" @click="tab = k">{{ label }}</button>
  </div>

  <div class="card">
    <pre class="snippet" style="margin:0">{{ snippets[tab] }}</pre>
  </div>

  <h2>Where the credentials come from</h2>
  <div class="card">
    <p style="margin-top:0">Mint a key under <router-link to="/keys">API keys</router-link> with the narrowest
      scopes the job needs — a backup script wants <code>write</code> and nothing else, and should be
      restricted to the <code>backups</code> bucket so a leaked key cannot touch anything you serve to users.</p>
    <p style="margin-bottom:0" class="muted">
      Keys go in <code>X-API-Key</code> or <code>Authorization: Bearer</code>. The session cookie the web UI
      uses is never accepted in their place, and vice versa.
    </p>
  </div>
</template>
