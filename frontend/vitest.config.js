import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Separate Vitest config (kept apart from vite.config.js to avoid touching
// the existing dev/build configuration). Provides a jsdom environment for
// component tests (e.g. frontend/src/components/Dashboard.test.jsx).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
  },
});
