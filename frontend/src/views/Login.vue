<script setup>
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useSession } from '../stores/session';

const session = useSession();
const route = useRoute();
const router = useRouter();
const username = ref('');
const password = ref('');
const busy = ref(false);
const error = ref('');

async function submit() {
  error.value = '';
  busy.value = true;
  try {
    await session.login(username.value, password.value);
    router.push(route.query.next || '/');
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
      <h1>Sign in</h1>
      <p class="sub">Storage for the things your apps generate.</p>
      <div v-if="error" class="alert err">{{ error }}</div>
      <form @submit.prevent="submit">
        <div class="field"><label>Username or email</label><input v-model="username" required autocomplete="username" /></div>
        <div class="field"><label>Password</label><input v-model="password" type="password" required autocomplete="current-password" /></div>
        <button class="primary" style="width:100%" :disabled="busy">{{ busy ? 'Signing in…' : 'Sign in' }}</button>
      </form>
    </div>
  </div>
</template>
