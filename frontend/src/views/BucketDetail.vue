<script setup>
import { ref, onMounted, computed } from 'vue';
import { api, bytes, ago } from '../lib/api';
import { useSession } from '../stores/session';
import Sparkline from '../components/Sparkline.vue';

const props = defineProps({ slug: String });
const session = useSession();
const data = ref(null);
const nodes = ref([]);
const error = ref('');
const saved = ref(false);
const edit = ref({});

async function load() {
  const [d, n] = await Promise.all([api.get(`/buckets/${props.slug}`), api.get('/nodes')]);
  data.value = d;
  nodes.value = n.nodes;
  edit.value = {
    description: d.bucket.description,
    node_id: d.bucket.node_id,
    quota_gb: d.bucket.quota_bytes ? Math.round(Number(d.bucket.quota_bytes) / 1024 ** 3) : null,
    allow_direct: d.bucket.allow_direct,
    versioning: d.bucket.versioning,
    public_read: d.bucket.public_read,
    max_versions: d.bucket.max_versions,
    max_age_days: d.bucket.max_age_days,
  };
}
onMounted(() => load().catch((e) => { error.value = e.message; }));

const usedPct = computed(() => {
  if (!data.value || !data.value.bucket.quota_bytes) return null;
  return Math.min(100, Math.round((data.value.usage.bytes / Number(data.value.bucket.quota_bytes)) * 100));
});

async function save() {
  error.value = ''; saved.value = false;
  try {
    const { quota_gb, ...rest } = edit.value;
    await api.patch(`/buckets/${props.slug}`, {
      ...rest,
      quota_bytes: quota_gb ? Number(quota_gb) * 1024 ** 3 : null,
      max_versions: edit.value.max_versions || null,
      max_age_days: edit.value.max_age_days || null,
    });
    saved.value = true;
    await load();
  } catch (err) { error.value = err.message; }
}
</script>

<template>
  <div v-if="error" class="alert err">{{ error }}</div>
  <template v-if="data">
    <div class="between">
      <div>
        <h1>{{ data.bucket.slug }}</h1>
        <p class="sub">{{ data.bucket.description || 'No description.' }}</p>
      </div>
      <router-link to="/buckets" class="btn">All buckets</router-link>
    </div>

    <div class="grid cols-4">
      <div class="card stat">
        <div class="label">Used</div>
        <div class="value">{{ bytes(data.usage.bytes) }}</div>
        <div v-if="usedPct !== null">
          <div class="bar"><i :class="usedPct > 90 ? 'bad' : usedPct > 75 ? 'warn' : ''" :style="{ width: usedPct + '%' }" /></div>
          <div class="note">{{ usedPct }}% of {{ bytes(data.bucket.quota_bytes) }}</div>
        </div>
        <div v-else class="note">No quota set</div>
      </div>
      <div class="card stat">
        <div class="label">Objects</div>
        <div class="value">{{ data.usage.objects.toLocaleString() }}</div>
        <div class="note">{{ data.bucket.versioning ? 'versioning on' : 'current versions only' }}</div>
      </div>
      <div class="card stat">
        <div class="label">Uploaded, 30d</div>
        <div class="value">{{ bytes(data.series.reduce((a, s) => a + Number(s.bytes_in), 0)) }}</div>
        <Sparkline :points="data.series.map(s => Number(s.bytes_in))" :height="26" />
      </div>
      <div class="card stat">
        <div class="label">Served, 30d</div>
        <div class="value">{{ bytes(data.series.reduce((a, s) => a + Number(s.bytes_out), 0)) }}</div>
        <Sparkline :points="data.series.map(s => Number(s.bytes_out))" :height="26" />
      </div>
    </div>

    <h2>Recent writes</h2>
    <div class="card table-wrap">
      <div v-if="!data.recent.length" class="empty">Nothing written to this bucket yet.</div>
      <table v-else>
        <thead><tr><th>Key</th><th class="right">Size</th><th>Type</th><th class="right">Version</th><th>When</th></tr></thead>
        <tbody>
          <tr v-for="o in data.recent" :key="o.key">
            <td class="mono" style="font-size:12.5px">{{ o.key }}</td>
            <td class="right nowrap">{{ bytes(o.size) }}</td>
            <td class="muted">{{ o.content_type }}</td>
            <td class="right muted">{{ o.version }}</td>
            <td class="muted nowrap">{{ ago(o.created_at) }}</td>
          </tr>
        </tbody>
      </table>
      <p class="muted" style="font-size:12px;margin:12px 10px 0">
        Showing the 20 most recent writes. A full object browser is not built yet — list
        programmatically with <code>GET /api/v1/b/{{ data.bucket.slug }}/o?prefix=</code>.
      </p>
    </div>

    <template v-if="session.isAdmin">
      <h2>Settings</h2>
      <div v-if="saved" class="alert ok">Saved.</div>
      <div class="card">
        <div class="row">
          <div><label>Description</label><input v-model="edit.description" /></div>
          <div><label>Storage node</label>
            <select v-model="edit.node_id">
              <option :value="null">Auto (most free space)</option>
              <option v-for="n in nodes" :key="n.id" :value="n.id">{{ n.name }}</option>
            </select>
          </div>
          <div><label>Quota (GB)</label><input v-model="edit.quota_gb" type="number" min="1" placeholder="unlimited" /></div>
        </div>
        <div class="row" style="margin-top:12px">
          <div><label>Delete objects older than (days)</label><input v-model="edit.max_age_days" type="number" min="1" placeholder="never" /></div>
          <div><label>Keep at most N versions</label><input v-model="edit.max_versions" type="number" min="1" placeholder="all" /></div>
        </div>
        <div class="row" style="margin-top:14px">
          <div class="check shrink"><input id="e-ad" type="checkbox" v-model="edit.allow_direct" /><label for="e-ad">Allow direct LAN transfers</label></div>
          <div class="check shrink"><input id="e-vs" type="checkbox" v-model="edit.versioning" /><label for="e-vs">Keep previous versions</label></div>
          <div class="check shrink"><input id="e-pr" type="checkbox" v-model="edit.public_read" /><label for="e-pr">Public read</label></div>
          <div class="spacer"></div>
          <button class="primary shrink" @click="save">Save settings</button>
        </div>
        <p class="muted" style="font-size:12px;margin:14px 0 0">
          Direct transfers hand LAN clients a short-lived signed URL straight to the storage node,
          so bytes skip the mini entirely. Clients off the LAN still go through the proxy.
        </p>
      </div>
    </template>
  </template>
</template>
