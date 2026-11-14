import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vitest/config';

/**
 * Content Security Policy for the built site. It tells the browser this page
 * may only load code, styles, fonts and images from its own origin, and may
 * not send data anywhere else. Anyone can check it with their browser's dev
 * tools: it's the proof behind "your photo never leaves this device".
 *
 * - 'wasm-unsafe-eval' + blob: workers: needed by the HEIC decoder (WebAssembly).
 * - blob:/data: images: previews of your own photo, created in the page.
 * Not applied in `npm run dev`, because Vite's dev server needs a live connection.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self' blob: data:",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

function contentSecurityPolicy(): Plugin {
  return {
    name: 'photo-scrub-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
    },
  };
}

export default defineConfig({
  // Relative base so the built site works from any sub-path
  // (e.g. GitHub Pages at https://<user>.github.io/photo-scrub/).
  base: './',
  plugins: [contentSecurityPolicy()],
  build: {
    // The HEIC decoder is ~3 MB, but it is only downloaded when someone
    // opens an iPhone photo.
    chunkSizeWarningLimit: 3500,
    rollupOptions: {
      // Two pages: the tool and "Why it matters".
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        why: resolve(import.meta.dirname, 'why.html'),
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
