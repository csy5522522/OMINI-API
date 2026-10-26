import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), tailwindcss()],
    server: {
      host: env.DEV_HOST || '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: { '/api': { target: 'http://127.0.0.1:3001', changeOrigin: false } },
    },
    build: {
      outDir: 'dist/web',
      rollupOptions: { output: { manualChunks: { charts: ['recharts'] } } },
    },
  };
});
