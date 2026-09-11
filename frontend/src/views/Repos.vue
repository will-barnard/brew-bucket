<script setup>
import { ref, onMounted, computed } from 'vue';
import { bytes, ago } from '../lib/api';
import { git } from '../lib/git';
import { api } from '../lib/api';

const repos = ref([]);
const enabled = ref(false);
const buckets = ref([]);
const error = ref('');
const result = ref(null);
const form = ref({ bucket: '', name: '', description: '', default_branch: 'main' });

const gitBuckets = computed(() => buckets.value.filter((b) => b.kind === 'git'));

async function load() {
  const [r, b] = await Promise.all([git.get('/repos').catch(() => ({ repos: [], enabled: false })), api.get('/buckets')]);
  repos.value = r.repos || [];
  enabled.value = !!r.enabled;
  buckets.value = b.buckets;
  if (!form.value.bucket && gitBuckets.value.length) form.value.bucket = gitBuckets.value[0].slug;
}
onMounted(() => load().catch((e) => { error.value = e.message; }));

async function create() {
  error.value = ''; result.value = null;
  try {
    result.value = await git.post('/repos', form.value);
    form.value.name = ''; form.value.description = '';
    await load();
  } catch (err) { error.value = err.message; }
}
</script>

<template>
  <h1>Repositories</h1>
  <p class="sub">Bare git repositories stored on the same NAS as your objects.</p>

  <div class="alert" :class="enabled ? 'ok' : 'info'">
    <strong>{{ enabled ? 'Git transport is enabled.' : 'Git transport is scaffolded, not enabled.' }}</strong>
    <p style="margin:6px 0 0">
      <template v-if="enabled">Clone and push over HTTPS, authenticating with any brew-bucket API key as the password.</template>
      <template v-else>
        Repos can be registered and will appear here, but clone and push return 501 until
        <code>BREW_BUCKET_GIT=1</code> is set and a git-capable storage node is deployed.
        The database, routes and auth path are already in place.
      </template>
    </p>
  </div>

  <div v-if="error" class="alert err">{{ error }}</div>

  <div v-if="result" class="alert ok">
    Created <strong>{{ result.repo.name }}</strong>.
    <pre class="snippet" style="margin:10px 0 0">git clone {{ result.clone_url }}</pre>
  </div>

  <div v-if="!gitBuckets.length" class="card empty">
    No git buckets yet. Create a bucket with kind <code>git</code> under
    <router-link to="/buckets">Buckets</router-link> first.
  </div>

  <div v-else class="card" style="margin-bottom:18px">
    <h3>New repository</h3>
    <div class="row">
      <div class="shrink" style="min-width:160px"><label>Bucket</label>
        <select v-model="form.bucket"><option v-for="b in gitBuckets" :key="b.id" :value="b.slug">{{ b.slug }}</option></select>
      </div>
      <div><label>Name</label><input v-model="form.name" placeholder="my-project" /></div>
      <div><label>Description</label><input v-model="form.description" /></div>
      <div class="shrink" style="min-width:130px"><label>Default branch</label><input v-model="form.default_branch" /></div>
      <button class="primary shrink" @click="create" :disabled="!form.name">Create</button>
    </div>
  </div>

  <div v-if="repos.length" class="card table-wrap">
    <table>
      <thead><tr><th>Repository</th><th>Bucket</th><th>Branch</th><th class="right">Size</th><th>Last push</th></tr></thead>
      <tbody>
        <tr v-for="r in repos" :key="r.id">
          <td><strong>{{ r.name }}</strong><div class="muted" style="font-size:12px">{{ r.description }}</div></td>
          <td class="muted">{{ r.bucket }}</td>
          <td class="mono muted">{{ r.default_branch }}</td>
          <td class="right nowrap">{{ bytes(r.size_bytes) }}</td>
          <td class="muted nowrap">{{ ago(r.last_push_at) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
