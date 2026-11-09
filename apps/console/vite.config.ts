import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// Geliştirmede /v1 (REST + WebSocket) API'ye yönlendirilir: CONSOLE_API_PROXY (varsayılan http://localhost:3000).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.CONSOLE_API_PROXY || 'http://localhost:3000';
  return {
    plugins: [react()],
    server: {
      port: Number(env.CONSOLE_PORT || 5173),
      strictPort: true,
      proxy: { '/v1': { target, changeOrigin: true, ws: true } },
    },
    build: { sourcemap: true },
  };
});
