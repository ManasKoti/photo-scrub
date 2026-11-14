import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative base so the built site works from any sub-path
  // (e.g. GitHub Pages at https://<user>.github.io/photo-scrub/).
  base: './',
  build: {
    rollupOptions: {
      // Two pages: the tool and "Why it matters".
      input: {
        main: resolve(__dirname, 'index.html'),
        why: resolve(__dirname, 'why.html'),
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
