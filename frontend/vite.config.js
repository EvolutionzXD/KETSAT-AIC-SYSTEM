import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 8083,
    host: '0.0.0.0', // Listen on all network interfaces
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8602',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://127.0.0.1:8602',
        changeOrigin: true,
      },
      '/ws': {
        target: 'http://127.0.0.1:8602',
        ws: true,
      },
    },
  },
});
