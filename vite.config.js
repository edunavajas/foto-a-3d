import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The SPA lives in web/ and builds to the repo-root dist/, which Express serves.
// emptyOutDir stays off: dist/foto_a_3d.zip (Blender add-on package) must survive builds.
export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  build: { outDir: '../dist', emptyOutDir: false },
  server: { proxy: { '/api': 'http://localhost:3000' } },
});
