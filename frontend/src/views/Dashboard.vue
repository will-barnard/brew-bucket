<script setup>
import { ref, onMounted, computed } from 'vue';
import { api, bytes, ago } from '../lib/api';
import Sparkline from '../components/Sparkline.vue';

const overview = ref(null);
const buckets = ref([]);
const error = ref('');

onMounted(async () => {
  try {
    const [o, b] = await Promise.all([api.get('/activity/overview'), api.get('/buckets')]);
    overview.value = o;
    buckets.value = b.buckets;
  } catch (err) { error.value = err.message; }
});

// Logical is what users stored; physical is what the NAS actually holds after
// content-addressed dedup. The gap is worth surfacing rather than hiding.
const savings = computed(() => {
  if (!overview.value) return 0;
  const l = overview.value.totals.logical_bytes;
  const p = overview.value.physical.bytes;
  return l > 0 ? Math.max(0, Math.round((1 - p / l) * 100)) : 0;
});

function pct(used, quota) {
  if (!quota) return null;
  return Math.min(100, Math.round((Number(used) / Number(quota)) * 100));
}
function diskPct(n) {
  if (!n.disk_total) return null;
  return Math.round(((n.disk_total - n.disk_free) / n.disk_total) * 100);
}
</script>

<template>
  <h1>Dashboard</h1>
  <p class="sub">Everything stored, and where it lives.</p>
  <div v-if="error" class="alert err">{{ error }}</div>

  <template v-if="overview">
    <div class="grid cols-4">
      <div class="card stat">
        <div class="label">Stored</div>
        <div class="value">{{ bytes(overview.totals.logical_bytes) }}</div>
        <div class="note">{{ overview.totals.objects.toLocaleString() }} objects</div>
      </div>
      <div class="card stat">
        <div class="label">On disk</div>
        <div class="value">{{ bytes(overview.physical.bytes) }}</div>
        <div class="note">{{ overview.physical.blobs.toLocaleString() }} blobs<span v-if="savings > 0">, {{ savings }}% saved by dedup</span></div>
      </div>
      <div class="card stat">
        <div class="label">Buckets</div>
        <div class="value">{{ overview.counts.buckets }}</div>
        <div class="note">{{ overview.counts.active_keys }} active API keys</div>
      </div>
      <div class="card stat">
        <div class="label">Nodes online</div>
        <div class="value">{{ overview.nodes.filter(n => n.online).length }} / {{ overview.nodes.length }}</div>
        <div class="note">{{ overview.counts.users }} users</div>
      </div>
    </div>

    <h2>Transfer, last 30 days</h2>
    <div class="grid cols-3">
      <div class="card">
        <h3>Bytes in</h3>
        <Sparkline :points="overview.series.map(s => Number(s.bytes_in))" />
        <p class="muted" style="font-size:12px;margin:6px 0 0">
          {{ bytes(overview.series.reduce((a, s) => a + Number(s.bytes_in), 0)) }} uploaded
        </p>
      </div>
      <div class="card">
        <h3>Bytes out</h3>
        <Sparkline :points="overview.series.map(s => Number(s.bytes_out))" />
        <p class="muted" style="font-size:12px;margin:6px 0 0">
          {{ bytes(overview.series.reduce((a, s) => a + Number(s.bytes_out), 0)) }} served
        </p>
      </div>
      <div class="card">
        <h3>Requests</h3>
        <Sparkline :points="overview.series.map(s => s.puts + s.gets)" />
        <p class="muted" style="font-size:12px;margin:6px 0 0">
          {{ overview.series.reduce((a, s) => a + s.puts, 0) }} puts,
          {{ overview.series.reduce((a, s) => a + s.gets, 0) }} gets
        </p>
      </div>
    </div>

    <h2>Storage nodes</h2>
    <div v-if="!overview.nodes.length" class="card empty">
      No storage node registered yet. Deploy one on the NAS with
      <code>./scripts/nas-deploy.sh</code>, then add it under
      <router-link to="/nodes">Storage nodes</router-link>.
    </div>
    <div v-else class="grid cols-3">
      <div class="card" v-for="n in overview.nodes" :key="n.name">
        <div class="between">
          <h3 style="margin:0">{{ n.name }}</h3>
          <span class="pill" :class="n.online ? 'good' : 'bad'">{{ n.online ? 'online' : 'offline' }}</span>
        </div>
        <p class="muted" style="font-size:12px;margin:6px 0 0">Last seen {{ ago(n.last_seen_at) }}</p>
        <template v-if="n.disk_total">
          <div class="bar"><i :class="diskPct(n) > 90 ? 'bad' : diskPct(n) > 75 ? 'warn' : ''" :style="{ width: diskPct(n) + '%' }" /></div>
          <p class="muted" style="font-size:12px;margin:6px 0 0">
            {{ bytes(n.disk_free) }} free of {{ bytes(n.disk_total) }}
          </p>
        </template>
      </div>
    </div>

    <h2>Buckets</h2>
    <div class="grid cols-3">
      <router-link v-for="b in buckets" :key="b.id" :to="`/buckets/${b.slug}`" class="card" style="color:inherit">
        <div class="between">
          <h3 style="margin:0">{{ b.slug }}</h3>
          <span class="pill" v-if="b.kind === 'git'">git</span>
        </div>
        <p class="muted" style="font-size:12px;margin:4px 0 10px">{{ b.description || '—' }}</p>
        <div style="font-size:19px;font-weight:600">{{ bytes(b.used_bytes) }}</div>
        <div class="muted" style="font-size:12px">{{ b.object_count.toLocaleString() }} objects · last write {{ ago(b.last_write) }}</div>
        <template v-if="b.quota_bytes">
          <div class="bar"><i :class="pct(b.used_bytes, b.quota_bytes) > 90 ? 'bad' : pct(b.used_bytes, b.quota_bytes) > 75 ? 'warn' : ''"
                              :style="{ width: pct(b.used_bytes, b.quota_bytes) + '%' }" /></div>
          <div class="muted" style="font-size:12px;margin-top:5px">{{ pct(b.used_bytes, b.quota_bytes) }}% of {{ bytes(b.quota_bytes) }} quota</div>
        </template>
      </router-link>
    </div>
  </template>
</template>
