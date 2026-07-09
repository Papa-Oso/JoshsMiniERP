import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    strictPort: true,
    watch: {
      ignored: ["**/data/**"]
    },
    proxy: {
      "/api": "http://127.0.0.1:5174"
    }
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true
  }
});
