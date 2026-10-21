import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import type { UserConfig } from "vite";

/**
 * What every build of the browser app shares for the interface base (ADR 0103): Tailwind through its Vite
 * plugin (no PostCSS, no tailwind.config.js), the `@/ui` and `@/lib` aliases of `components.json`, and no
 * asset inlined as `data:`. The shell has `font-src 'self'`, which refuses `data:`: a small font face
 * inlined by the default 4 KB limit would vanish in silence, seen only by a browser that needed it.
 */
export const uiBuild = {
  build: { assetsInlineLimit: 0 },
  resolve: {
    alias: {
      "@/lib": fileURLToPath(new URL("./src/lib", import.meta.url)),
      "@/ui": fileURLToPath(new URL("./src/ui", import.meta.url)),
    },
  },
} satisfies UserConfig;

export const uiPlugins = () => tailwindcss();
