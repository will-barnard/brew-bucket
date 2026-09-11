import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    // Local dev only. In production nginx does this and the backend hostname
    // is a Docker service name, not localhost.
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
      '/s': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 900 },
});
