<script setup>
import { ref, onMounted, watch } from 'vue';
import { api, bytes, ago } from '../lib/api';
import { useSession } from '../stores/session';

const session = useSession();
const rows = ref([]);
const filter = ref('');
const error = ref('');
const sweeping = ref(false);
const sweepResult = ref('');

async function load() {
  const q = filter.value ? `?action=${encodeURIComponent(filter.value)}` : '';
  rows.value = (await api.get(`/activity${q}`)).activity;
}
onMounted(() => load().catch((e) => { error.value = e.message; }));
watch(filter, () => load().catch((e) => { error.value = e.message; }));

async function sweep() {
  sweeping.value = true; sweepResult.value = '';
  try {
    const r = await api.post('/activity/maintenance/sweep');
    sweepResult.value = `Trimmed ${r.trimmed} objects and reclaimed ${r.freed} orphaned blobs.`;
  } catch (err) { error.value = err.message; }
  finally { sweeping.value = false; }
}
</script>

<template>
  <div class="between">
    <div>
      <h1>Activity</h1>
      <p class="sub">Every write, read and credential change, with the key that did it.</p>
    </div>
    <button v-if="session.isAdmin" @click="sweep" :disabled="sweeping">
      {{ sweeping ? 'Sweeping…' : 'Run retention sweep' }}
    </button>
  </div>

  <div v-if="error" class="alert err">{{ error }}</div>
  <div v-if="sweepResult" class="alert ok">{{ sweepResult }}</div>

  <div class="row" style="margin-bottom:14px">
    <div class="shrink" style="min-width:220px">
      <label>Filter by action</label>
      <select v-model="filter">
        <option value="">Everything</option>
        <option value="object">Object operations</option>
        <option value="object.put">Uploads</option>
        <option value="object.get">Downloads</option>
        <option value="object.delete">Deletes</option>
        <option value="key">API keys</option>
        <option value="bucket">Buckets</option>
        <option value="user">Users and sign-ins</option>
        <option value="share">Share links</option>
      </select>
    </div>
  </div>

  <div class="card table-wrap">
    <table>
      <thead><tr><th>When</th><th>Action</th><th>Bucket</th><th>Key</th><th>Actor</th><th class="right">Bytes</th><th>IP</th></tr></thead>
      <tbody>
        <tr v-for="r in rows" :key="r.id">
          <td class="muted nowrap">{{ ago(r.at) }}</td>
          <td><span class="pill" :class="r.ok ? '' : 'bad'">{{ r.action }}</span></td>
          <td class="muted">{{ r.bucket || '—' }}</td>
          <td class="mono" style="font-size:12px">{{ r.object_key || '—' }}</td>
          <td class="muted">{{ r.username || r.key_name || 'anonymous' }}</td>
          <td class="right nowrap muted">{{ r.bytes ? bytes(r.bytes) : '—' }}</td>
          <td class="muted mono" style="font-size:12px">{{ r.ip || '—' }}</td>
        </tr>
      </tbody>
    </table>
    <div v-if="!rows.length" class="empty">Nothing logged yet.</div>
  </div>
</template>
