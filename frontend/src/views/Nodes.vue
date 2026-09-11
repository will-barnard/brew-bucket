<script setup>
import { ref, onMounted } from 'vue';
import { api, bytes, ago } from '../lib/api';
import { useSession } from '../stores/session';

const session = useSession();
const nodes = ref([]);
const error = ref('');
const adding = ref(false);
const checking = ref(null);
const form = ref({ name: '', internal_url: '', direct_base_url: '' });

async function load() { nodes.value = (await api.get('/nodes')).nodes; }
onMounted(() => load().catch((e) => { error.value = e.message; }));

async function add() {
  error.value = '';
  try {
    await api.post('/nodes', { ...form.value, direct_base_url: form.value.direct_base_url || null });
    adding.value = false;
    form.value = { name: '', internal_url: '', direct_base_url: '' };
    await load();
  } catch (err) { error.value = err.message; }
}

async function check(n) {
  checking.value = n.id;
  error.value = '';
  try {
    const res = await api.post(`/nodes/${n.id}/check`);
    if (!res.ok) error.value = `${n.name}: ${res.error}`;
    await load();
  } catch (err) { error.value = `${n.name}: ${err.message}`; }
  finally { checking.value = null; }
}

async function toggle(n, field) {
  try { await api.patch(`/nodes/${n.id}`, { [field]: !n[field] }); await load(); }
  catch (err) { error.value = err.message; }
}

function diskPct(n) { return n.disk_total ? Math.round(((n.disk_total - n.disk_free) / n.disk_total) * 100) : null; }
</script>

<template>
  <div class="between">
    <div>
      <h1>Storage nodes</h1>
      <p class="sub">The machines that actually hold bytes. This app holds only metadata.</p>
    </div>
    <button v-if="session.isAdmin" class="primary" @click="adding = !adding">{{ adding ? 'Cancel' : 'Add node' }}</button>
  </div>

  <div v-if="error" class="alert err">{{ error }}</div>

  <div v-if="adding" class="card" style="margin-bottom:18px">
    <h3>Add a storage node</h3>
    <div class="row">
      <div><label>Name</label><input v-model="form.name" placeholder="nas" /></div>
      <div><label>Internal URL (how this server reaches it)</label><input v-model="form.internal_url" placeholder="http://nas.lan:8477" /></div>
      <div><label>Direct base URL (handed to LAN clients; blank disables)</label><input v-model="form.direct_base_url" placeholder="http://nas.lan:8477" /></div>
    </div>
    <div class="row" style="margin-top:12px">
      <div class="spacer"></div>
      <button class="primary shrink" @click="add" :disabled="!form.name || !form.internal_url">Add node</button>
    </div>
    <p class="muted" style="font-size:12px;margin:14px 0 0">
      The node must already be running on the NAS and share this instance's
      <code>NODE_SHARED_SECRET</code>. Deploy it with <code>./scripts/nas-deploy.sh</code>.
    </p>
  </div>

  <div v-if="!nodes.length" class="card empty">
    No storage nodes registered. Until one is, every upload fails with 503.
  </div>

  <div class="grid cols-3">
    <div class="card" v-for="n in nodes" :key="n.id">
      <div class="between">
        <h3 style="margin:0">{{ n.name }}</h3>
        <span class="pill" :class="n.online ? 'good' : 'bad'">{{ n.online ? 'online' : 'offline' }}</span>
      </div>
      <p class="mono muted" style="font-size:12px;margin:6px 0 2px">{{ n.internal_url }}</p>
      <p class="mono muted" style="font-size:12px;margin:0">
        direct: {{ n.direct_base_url || 'disabled' }}
      </p>

      <template v-if="n.disk_total">
        <div class="bar"><i :class="diskPct(n) > 90 ? 'bad' : diskPct(n) > 75 ? 'warn' : ''" :style="{ width: diskPct(n) + '%' }" /></div>
        <p class="muted" style="font-size:12px;margin:6px 0 0">{{ bytes(n.disk_free) }} free of {{ bytes(n.disk_total) }}</p>
      </template>

      <p class="muted" style="font-size:12px;margin:8px 0 0">
        {{ n.blob_count.toLocaleString() }} blobs · {{ bytes(n.blob_bytes) }}<br />
        agent {{ n.agent_version || '?' }} · seen {{ ago(n.last_seen_at) }}
      </p>
      <p v-if="n.last_error" class="alert err" style="font-size:12px;margin:10px 0 0;padding:7px 10px">{{ n.last_error }}</p>

      <div class="flex" style="margin-top:12px">
        <button class="sm" @click="check(n)" :disabled="checking === n.id">{{ checking === n.id ? 'Checking…' : 'Test' }}</button>
        <template v-if="session.isAdmin">
          <button class="sm" @click="toggle(n, 'writable')">{{ n.writable ? 'Stop new writes' : 'Allow writes' }}</button>
          <button class="sm" @click="toggle(n, 'enabled')">{{ n.enabled ? 'Disable' : 'Enable' }}</button>
        </template>
      </div>
    </div>
  </div>
</template>
