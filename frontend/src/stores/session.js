import { defineStore } from 'pinia';
import { api } from '../lib/api';

export const useSession = defineStore('session', {
  state: () => ({ user: null, needsSetup: false, loaded: false }),
  getters: {
    isAdmin: (s) => s.user && s.user.role === 'admin',
    signedIn: (s) => !!s.user,
  },
  actions: {
    async load() {
      try {
        const { user } = await api.get('/auth/me');
        this.user = user;
      } catch {
        this.user = null;
        // Only ask the bootstrap question when we know nobody is signed in.
        const { needs_setup } = await api.get('/auth/bootstrap');
        this.needsSetup = needs_setup;
      } finally {
        this.loaded = true;
      }
    },
    async login(username, password) {
      const { user } = await api.post('/auth/login', { username, password });
      this.user = user;
      this.needsSetup = false;
    },
    async register(payload) {
      const { user } = await api.post('/auth/register', payload);
      this.user = user;
      this.needsSetup = false;
    },
    async logout() {
      await api.post('/auth/logout');
      this.user = null;
      await this.load();
    },
  },
});
