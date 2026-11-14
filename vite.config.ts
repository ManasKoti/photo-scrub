import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative base so the built site works from any sub-path
  // (e.g. GitHub Pages at https://<user>.github.io/photo-scrub/).
  base: './',
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
