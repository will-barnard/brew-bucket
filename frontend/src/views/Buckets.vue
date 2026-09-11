<script setup>
import { ref, onMounted } from 'vue';
import { api, bytes, ago } from '../lib/api';
import { useSession } from '../stores/session';

const session = useSession();
const buckets = ref([]);
const nodes = ref([]);
const error = ref('');
const creating = ref(false);
const form = ref({ slug: '', description: '', kind: 'blob', node_id: null, quota_gb: null, allow_direct: false, versioning: false, max_age_days: null });

async function load() {
  const [b, n] = await Promise.all([api.get('/buckets'), api.get('/nodes')]);
  buckets.value = b.buckets;
  nodes.value = n.nodes;
}
onMounted(() => load().catch((e) => { error.value = e.message; }));

async function create() {
  error.value = '';
  try {
    await api.post('/buckets', {
      ...form.value,
      quota_bytes: form.value.quota_gb ? Number(form.value.quota_gb) * 1024 ** 3 : null,
      node_id: form.value.node_id || null,
      max_age_days: form.value.max_age_days || null,
    });
    creating.value = false;
    form.value = { slug: '', description: '', kind: 'blob', node_id: null, quota_gb: null, allow_direct: false, versioning: false, max_age_days: null };
    await load();
  } catch (err) { error.value = err.message; }
}
</script>

<template>
  <div class="between">
    <div>
      <h1>Buckets</h1>
      <p class="sub">Named containers with their own quota, retention and access rules.</p>
    </div>
    <button v-if="session.isAdmin" class="primary" @click="creating = !creating">
      {{ creating ? 'Cancel' : 'New bucket' }}
    </button>
  </div>

  <div v-if="error" class="alert err">{{ error }}</div>

  <div v-if="creating" class="card" style="margin-bottom:18px">
    <h3>New bucket</h3>
    <div class="row">
      <div><label>Slug</label><input v-model="form.slug" placeholder="reports" /></div>
      <div><label>Description</label><input v-model="form.description" /></div>
      <div class="shrink" style="min-width:120px"><label>Kind</label>
        <select v-model="form.kind"><option value="blob">blob</option><option value="git">git</option></select>
      </div>
    </div>
    <div class="row" style="margin-top:12px">
      <div><label>Storage node</label>
        <select v-model="form.node_id">
          <option :value="null">Auto (most free space)</option>
          <option v-for="n in nodes" :key="n.id" :value="n.id">{{ n.name }}</option>
        </select>
      </div>
      <div><label>Quota (GB, blank = unlimited)</label><input v-model="form.quota_gb" type="number" min="1" /></div>
      <div><label>Delete after (days, blank = keep)</label><input v-model="form.max_age_days" type="number" min="1" /></div>
    </div>
    <div class="row" style="margin-top:12px">
      <div class="check shrink"><input id="ad" type="checkbox" v-model="form.allow_direct" /><label for="ad">Allow direct LAN transfers</label></div>
      <div class="check shrink"><input id="vs" type="checkbox" v-model="form.versioning" /><label for="vs">Keep previous versions</label></div>
      <div class="spacer"></div>
      <button class="primary shrink" @click="create">Create bucket</button>
    </div>
  </div>

  <div class="card table-wrap">
    <table>
      <thead><tr>
        <th>Bucket</th><th>Node</th><th class="right">Objects</th><th class="right">Used</th>
        <th>Quota</th><th>Retention</th><th>Flags</th><th>Last write</th>
      </tr></thead>
      <tbody>
        <tr v-for="b in buckets" :key="b.id">
          <td><router-link :to="`/buckets/${b.slug}`"><strong>{{ b.slug }}</strong></router-link>
              <div class="muted" style="font-size:12px">{{ b.description }}</div></td>
          <td class="muted">{{ b.node_name || 'auto' }}</td>
          <td class="right">{{ b.object_count.toLocaleString() }}</td>
          <td class="right nowrap">{{ bytes(b.used_bytes) }}</td>
          <td class="muted nowrap">{{ b.quota_bytes ? bytes(b.quota_bytes) : '—' }}</td>
          <td class="muted nowrap">
            <span v-if="b.max_age_days">{{ b.max_age_days }}d</span>
            <span v-if="b.max_versions">{{ b.max_age_days ? ', ' : '' }}{{ b.max_versions }} versions</span>
            <span v-if="!b.max_age_days && !b.max_versions">—</span>
          </td>
          <td>
            <span v-if="b.kind === 'git'" class="pill">git</span>
            <span v-if="b.allow_direct" class="pill">direct</span>
            <span v-if="b.versioning" class="pill">versioned</span>
            <span v-if="b.public_read" class="pill warn">public</span>
          </td>
          <td class="muted nowrap">{{ ago(b.last_write) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
