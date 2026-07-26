import { defineConfig } from 'vite';
import { routesApiPlugin } from './tools/dev-routes-api';

export default defineConfig({
  server: {
    port: 5173,
  },
  plugins: [routesApiPlugin()],
});
