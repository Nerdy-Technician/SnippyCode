import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.SNIPPYCODE_API_URL || 'http://localhost:5000';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,
    // Dev server is often reached through a LAN hostname; only use it for development.
    allowedHosts: true,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      '/raw': { target: apiTarget, changeOrigin: true }
    }
  },
  preview: {
    port: 3000
  },
  css: {
    preprocessorOptions: {
      scss: {
        // Bootstrap 5 still uses legacy Sass APIs; keep build output readable.
        quietDeps: true,
        silenceDeprecations: ['import', 'global-builtin', 'color-functions', 'if-function']
      }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
});
