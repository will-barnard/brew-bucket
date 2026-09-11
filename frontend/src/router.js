import { createRouter, createWebHistory } from 'vue-router';
import { useSession } from './stores/session';

const routes = [
  { path: '/', name: 'dashboard', component: () => import('./views/Dashboard.vue') },
  { path: '/buckets', name: 'buckets', component: () => import('./views/Buckets.vue') },
  { path: '/buckets/:slug', name: 'bucket', component: () => import('./views/BucketDetail.vue'), props: true },
  { path: '/keys', name: 'keys', component: () => import('./views/Keys.vue') },
  { path: '/nodes', name: 'nodes', component: () => import('./views/Nodes.vue') },
  { path: '/repos', name: 'repos', component: () => import('./views/Repos.vue') },
  { path: '/activity', name: 'activity', component: () => import('./views/Activity.vue') },
  { path: '/users', name: 'users', component: () => import('./views/Users.vue') },
  { path: '/integrate', name: 'integrate', component: () => import('./views/Integrate.vue') },
  { path: '/login', name: 'login', component: () => import('./views/Login.vue'), meta: { public: true } },
  { path: '/setup', name: 'setup', component: () => import('./views/Setup.vue'), meta: { public: true } },
  { path: '/register', name: 'register', component: () => import('./views/Setup.vue'), meta: { public: true } },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

const router = createRouter({ history: createWebHistory(), routes });

router.beforeEach(async (to) => {
  const session = useSession();
  if (!session.loaded) await session.load();
  if (session.needsSetup && to.name !== 'setup') return { name: 'setup' };
  if (!session.signedIn && !to.meta.public) return { name: 'login', query: { next: to.fullPath } };
  if (session.signedIn && (to.name === 'login' || to.name === 'setup')) return { name: 'dashboard' };
  return true;
});

export default router;
