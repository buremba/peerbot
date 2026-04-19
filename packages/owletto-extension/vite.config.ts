import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// Plugin to copy manifest, icons, and fix HTML paths after build
function copyExtensionFiles() {
  return {
    name: 'copy-extension-files',
    closeBundle() {
      const distDir = resolve(__dirname, 'dist');

      // Copy manifest.json
      copyFileSync(resolve(__dirname, 'manifest.json'), resolve(distDir, 'manifest.json'));

      // Copy icons
      const iconsDir = resolve(distDir, 'icons');
      if (!existsSync(iconsDir)) {
        mkdirSync(iconsDir, { recursive: true });
      }

      const srcIconsDir = resolve(__dirname, 'src/assets/icons');
      if (existsSync(srcIconsDir)) {
        const icons = [
          'icon-16.png',
          'icon-48.png',
          'icon-128.png',
          'icon-16-mono.png',
          'icon-48-mono.png',
          'icon-128-mono.png',
        ];
        for (const icon of icons) {
          const srcPath = resolve(srcIconsDir, icon);
          if (existsSync(srcPath)) {
            copyFileSync(srcPath, resolve(iconsDir, icon));
          }
        }
      }

      // Fix HTML paths - Vite outputs to dist/src/..., we need dist/...
      const htmlMappings = [
        { from: 'src/sidebar/index.html', to: 'sidebar/index.html' },
        { from: 'src/popup/index.html', to: 'popup/index.html' },
        { from: 'src/offscreen/document.html', to: 'offscreen/document.html' },
        { from: 'src/callback/callback.html', to: 'callback.html' },
      ];

      for (const mapping of htmlMappings) {
        const srcPath = resolve(distDir, mapping.from);
        const destPath = resolve(distDir, mapping.to);
        if (existsSync(srcPath)) {
          copyFileSync(srcPath, destPath);
        }
      }

      // Clean up the erroneous src directory
      const srcDir = resolve(distDir, 'src');
      if (existsSync(srcDir)) {
        rmSync(srcDir, { recursive: true });
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  // Load env file based on mode (.env, .env.production, etc.)
  const env = loadEnv(mode, __dirname, '');
  const apiUrl = env.VITE_API_URL || 'http://localhost:5173';

  console.log(`[Owletto Build] Mode: ${mode}, API URL: ${apiUrl}`);

  return {
    plugins: [react(), copyExtensionFiles()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
      },
    },
    define: {
      'import.meta.env.VITE_API_URL': JSON.stringify(apiUrl),
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: mode === 'development',
      rollupOptions: {
        input: {
          'background/service-worker': resolve(__dirname, 'src/background/service-worker.ts'),
          'content/index': resolve(__dirname, 'src/content/index.ts'),
          'sidebar/index': resolve(__dirname, 'src/sidebar/index.html'),
          'popup/index': resolve(__dirname, 'src/popup/index.html'),
          'offscreen/document': resolve(__dirname, 'src/offscreen/document.html'),
          'callback/callback': resolve(__dirname, 'src/callback/callback.html'),
        },
        output: {
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  };
});
