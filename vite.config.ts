import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Static single-page app. Everything (engine, viewer, fallback fonts)
// ships as static assets; all PDF processing happens in the browser.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: false },
});
