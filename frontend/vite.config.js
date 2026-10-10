import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test/setup.js'],
    include: ['src/**/*.test.{js,jsx}'],
    css: false,
    env: {
      // The QR interface is hidden by default (see config.SHOW_QR), but the
      // capability is not removed, so the tests covering it must still run.
      // Leaving this off would quietly delete that coverage — exactly what
      // hiding rather than deleting was meant to avoid.
      VITE_SHOW_QR: 'true',
    },
  },
});
