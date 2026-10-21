import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { uiBuild, uiPlugins } from "./vite.ui";

export default defineConfig({
  ...uiBuild,
  build: {
    ...uiBuild.build,
    emptyOutDir: true,
    outDir: "dist/offline-poc",
  },
  // The lab build (never deployed) runs the real app with the offline runtime on,
  // so the browser scenarios can open it the way a second visit would.
  define: {
    "import.meta.env.VITE_OFFLINE_RUNTIME_ENABLED": JSON.stringify("true"),
  },
  plugins: [uiPlugins(), react()],
});
