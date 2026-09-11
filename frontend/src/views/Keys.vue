<script setup>
import { ref, onMounted } from 'vue';
import { api, ago } from '../lib/api';

const keys = ref([]);
const buckets = ref([]);
const error = ref('');
const creating = ref(false);
const newSecret = ref('');
const copied = ref(false);
const form = ref({ name: '', scopes: ['read'], bucket_ids: [], expires_days: null });

async function load() {
  const [k, b] = await Promise.all([api.get('/keys'), api.get('/buckets')]);
  keys.value = k.keys;
  buckets.value = b.buckets;
}
onMounted(() => load().catch((e) => { error.value = e.message; }));

async function create() {
  error.value = '';
  try {
    const res = await api.post('/keys', {
      ...form.value,
      bucket_ids: form.value.bucket_ids.length ? form.value.bucket_ids.map(Number) : null,
      expires_days: form.value.expires_days ? Number(form.value.expires_days) : null,
    });
    newSecret.value = res.secret;
    creating.value = false;
    form.value = { name: '', scopes: ['read'], bucket_ids: [], expires_days: null };
    await load();
  } catch (err) { error.value = err.message; }
}

async function revoke(key) {
  if (!confirm(`Revoke "${key.name}"? Anything using it stops working immediately.`)) return;
  try { await api.del(`/keys/${key.id}`); await load(); }
  catch (err) { error.value = err.message; }
}

async function copy() {
  try { await navigator.clipboard.writeText(newSecret.value); copied.value = true; }
  catch { /* clipboard blocked; the value is on screen anyway */ }
}
</script>

<template>
  <div class="between">
    <div>
      <h1>API keys</h1>
      <p class="sub">How your apps authenticate. Scoped per operation and, optionally, per bucket.</p>
    </div>
    <button class="primary" @click="creating = !creating">{{ creating ? 'Cancel' : 'New key' }}</button>
  </div>

  <div v-if="error" class="alert err">{{ error }}</div>

  <div v-if="newSecret" class="alert info">
    <strong>Copy this now — it is not stored and will never be shown again.</strong>
    <pre class="snippet" style="margin:10px 0 8px">{{ newSecret }}</pre>
    <button class="sm" @click="copy">{{ copied ? 'Copied' : 'Copy' }}</button>
    <button class="sm" @click="newSecret = ''; copied = false">Dismiss</button>
  </div>

  <div v-if="creating" class="card" style="margin-bottom:18px">
    <h3>New key</h3>
    <div class="row">
      <div><label>Name</label><input v-model="form.name" placeholder="nightly-db-backup" /></div>
      <div><label>Expires in (days, blank = never)</label><input v-model="form.expires_days" type="number" min="1" /></div>
    </div>
    <div class="row" style="margin-top:12px">
      <div>
        <label>Scopes</label>
        <div class="flex" style="flex-wrap:wrap">
          <label v-for="s in ['read','write','delete','admin']" :key="s" class="check" style="margin:0">
            <input type="checkbox" :value="s" v-model="form.scopes" /> {{ s }}
          </label>
        </div>
      </div>
      <div>
        <label>Restrict to buckets (none selected = all)</label>
        <select multiple v-model="form.bucket_ids" size="4">
          <option v-for="b in buckets" :key="b.id" :value="b.id">{{ b.slug }}</option>
        </select>
      </div>
    </div>
    <div class="row" style="margin-top:12px">
      <div class="spacer"></div>
      <button class="primary shrink" @click="create" :disabled="!form.name || !form.scopes.length">Create key</button>
    </div>
  </div>

  <div class="card table-wrap">
    <table>
      <thead><tr><th>Name</th><th>Prefix</th><th>Scopes</th><th>Buckets</th><th>Last used</th><th>Expires</th><th></th></tr></thead>
      <tbody>
        <tr v-for="k in keys" :key="k.id" :style="k.revoked_at ? 'opacity:.45' : ''">
          <td><strong>{{ k.name }}</strong><div class="muted" style="font-size:12px">by {{ k.owner || '—' }}</div></td>
          <td class="mono muted">bb_{{ k.prefix }}…</td>
          <td><span v-for="s in k.scopes" :key="s" class="pill" style="margin-right:3px">{{ s }}</span></td>
          <td class="muted">
            {{ k.bucket_ids ? buckets.filter(b => k.bucket_ids.includes(b.id)).map(b => b.slug).join(', ') : 'all' }}
          </td>
          <td class="muted nowrap">{{ ago(k.last_used_at) }}<div v-if="k.last_used_ip" style="font-size:11px">{{ k.last_used_ip }}</div></td>
          <td class="muted nowrap">{{ k.expires_at ? new Date(k.expires_at).toLocaleDateString() : 'never' }}</td>
          <td class="right">
            <span v-if="k.revoked_at" class="pill bad">revoked</span>
            <button v-else class="sm danger" @click="revoke(k)">Revoke</button>
          </td>
        </tr>
      </tbody>
    </table>
    <div v-if="!keys.length" class="empty">No API keys yet.</div>
  </div>
</template>
