import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // Raised above the default (500 KB) to avoid a pointless warning: the app's real
    // weight comes from public/best.onnx (~236 MB), which isn't counted here anyway since
    // it's a static asset served as-is, not a bundled JS chunk.
    chunkSizeWarningLimit: 2000,
  },
});
