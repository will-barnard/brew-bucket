<script setup>
import { ref, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useSession } from '../stores/session';

const session = useSession();
const route = useRoute();
const router = useRouter();

const email = ref('');
const username = ref('');
const password = ref('');
const busy = ref(false);
const error = ref('');

const invite = computed(() => route.query.invite || '');
const isBootstrap = computed(() => session.needsSetup && !invite.value);

async function submit() {
  error.value = '';
  busy.value = true;
  try {
    await session.register({
      email: email.value, username: username.value,
      password: password.value, invite: invite.value || undefined,
    });
    router.push('/');
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="auth-shell">
    <div class="card auth-card">
      <div class="brand" style="padding-left:0">brew<span>·</span>bucket</div>

      <template v-if="isBootstrap">
        <h1>Create the admin account</h1>
        <p class="sub">This instance has no users yet. The first account created becomes the
          administrator, and registration closes behind it — everyone after joins by invite.</p>
      </template>
      <template v-else>
        <h1>Accept your invite</h1>
        <p class="sub">Choose a username and password for this brew-bucket instance.</p>
      </template>

      <div v-if="error" class="alert err">{{ error }}</div>

      <form @submit.prevent="submit">
        <div class="field"><label>Email</label><input v-model="email" type="email" required autocomplete="email" /></div>
        <div class="field"><label>Username</label><input v-model="username" required autocomplete="username" /></div>
        <div class="field">
          <label>Password (10 characters minimum)</label>
          <input v-model="password" type="password" minlength="10" required autocomplete="new-password" />
        </div>
        <button class="primary" style="width:100%" :disabled="busy">
          {{ busy ? 'Creating…' : (isBootstrap ? 'Create admin account' : 'Create account') }}
        </button>
      </form>

      <p v-if="!isBootstrap" class="muted" style="margin-top:14px;font-size:13px">
        Already have an account? <router-link to="/login">Sign in</router-link>
      </p>
    </div>
  </div>
</template>
