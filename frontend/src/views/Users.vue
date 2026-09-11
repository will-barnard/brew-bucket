<script setup>
import { ref, onMounted } from 'vue';
import { api, ago } from '../lib/api';

const users = ref([]);
const invites = ref([]);
const error = ref('');
const inviteLink = ref('');
const form = ref({ email: '', role: 'user', days: 7 });

async function load() {
  users.value = (await api.get('/users')).users;
  try { invites.value = (await api.get('/users/invites')).invites; } catch { invites.value = []; }
}
onMounted(() => load().catch((e) => { error.value = e.message; }));

async function invite() {
  error.value = '';
  try {
    const res = await api.post('/users/invite', form.value);
    inviteLink.value = `${location.origin}${res.invite_path}`;
    form.value.email = '';
    await load();
  } catch (err) { error.value = err.message; }
}

async function update(u, patch) {
  try { await api.patch(`/users/${u.id}`, patch); await load(); }
  catch (err) { error.value = err.message; }
}
</script>

<template>
  <h1>Users</h1>
  <p class="sub">Registration is invite-only after the first admin account.</p>
  <div v-if="error" class="alert err">{{ error }}</div>

  <div v-if="inviteLink" class="alert info">
    <strong>Send this link to the person you invited.</strong>
    <pre class="snippet" style="margin:10px 0 0">{{ inviteLink }}</pre>
  </div>

  <div class="card" style="margin-bottom:18px">
    <h3>Invite someone</h3>
    <div class="row">
      <div><label>Email</label><input v-model="form.email" type="email" /></div>
      <div class="shrink" style="min-width:130px"><label>Role</label>
        <select v-model="form.role"><option>user</option><option>readonly</option><option>admin</option></select>
      </div>
      <div class="shrink" style="min-width:130px"><label>Valid for (days)</label><input v-model="form.days" type="number" min="1" /></div>
      <button class="primary shrink" @click="invite" :disabled="!form.email">Create invite</button>
    </div>
    <p class="muted" style="font-size:12px;margin:12px 0 0">
      There is no mail server here — the link is yours to deliver however you like.
    </p>
  </div>

  <div class="card table-wrap">
    <table>
      <thead><tr><th>User</th><th>Email</th><th>Role</th><th>Last login</th><th>Joined</th><th></th></tr></thead>
      <tbody>
        <tr v-for="u in users" :key="u.id" :style="u.disabled ? 'opacity:.5' : ''">
          <td><strong>{{ u.username }}</strong></td>
          <td class="muted">{{ u.email }}</td>
          <td>
            <select :value="u.role" @change="update(u, { role: $event.target.value })" style="width:auto">
              <option>user</option><option>readonly</option><option>admin</option>
            </select>
          </td>
          <td class="muted nowrap">{{ ago(u.last_login_at) }}</td>
          <td class="muted nowrap">{{ new Date(u.created_at).toLocaleDateString() }}</td>
          <td class="right">
            <button class="sm" :class="u.disabled ? '' : 'danger'" @click="update(u, { disabled: !u.disabled })">
              {{ u.disabled ? 'Enable' : 'Disable' }}
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <template v-if="invites.length">
    <h2>Outstanding invites</h2>
    <div class="card table-wrap">
      <table>
        <thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Expires</th></tr></thead>
        <tbody>
          <tr v-for="i in invites" :key="i.token">
            <td>{{ i.email }}</td>
            <td class="muted">{{ i.role }}</td>
            <td><span class="pill" :class="i.used_at ? 'good' : ''">{{ i.used_at ? 'accepted' : 'pending' }}</span></td>
            <td class="muted nowrap">{{ new Date(i.expires_at).toLocaleDateString() }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </template>
</template>
