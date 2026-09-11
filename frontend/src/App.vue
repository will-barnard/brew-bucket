<script setup>
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useSession } from './stores/session';

const session = useSession();
const route = useRoute();
const chromeless = computed(() => route.meta.public || !session.signedIn);
</script>

<template>
  <div v-if="!session.loaded" class="auth-shell"><p class="muted">Loading…</p></div>

  <router-view v-else-if="chromeless" />

  <div v-else class="layout">
    <aside class="sidebar">
      <div class="brand">brew<span>·</span>bucket</div>
      <nav class="nav">
        <router-link to="/">Dashboard</router-link>
        <router-link to="/buckets">Buckets</router-link>
        <router-link to="/keys">API keys</router-link>
        <router-link to="/nodes">Storage nodes</router-link>
        <router-link to="/repos">Repositories</router-link>
        <router-link to="/activity">Activity</router-link>
        <router-link to="/users" v-if="session.isAdmin">Users</router-link>
        <router-link to="/integrate">Integrate</router-link>
      </nav>
      <div class="sidebar-foot">
        <div>{{ session.user.username }} <span class="pill">{{ session.user.role }}</span></div>
        <button class="sm" style="margin-top:8px" @click="session.logout()">Sign out</button>
      </div>
    </aside>
    <main class="main"><router-view /></main>
  </div>
</template>
