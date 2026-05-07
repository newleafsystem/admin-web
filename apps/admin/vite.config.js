import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  envDir: '../..',
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (
            id.includes('/firebase/') ||
            id.includes('\\firebase\\') ||
            id.includes('/@firebase/') ||
            id.includes('\\@firebase\\')
          ) {
            return 'firebase';
          }
          if (id.includes('/react/') || id.includes('\\react\\') || id.includes('/react-dom/') || id.includes('\\react-dom\\')) {
            return 'react-vendor';
          }
          return 'vendor';
        },
      },
    },
  },
});
