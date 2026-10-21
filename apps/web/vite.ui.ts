import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import type { UserConfig } from "vite";

/**
 * The browser floor of Tailwind 4 (ADR 0103, section 2): Safari 16.4, Chrome 111, Firefox 128 (cascade
 * layers, `color-mix`, `oklch`, `@property`). Vite's default is the same but Firefox 114; the floor is
 * declared here and in `browserslist` (package.json), and a test keeps the two together.
 */
export const BROWSER_TARGET = [
  "chrome111",
  "edge111",
  "firefox128",
  "safari16.4",
  "ios16.4",
];

/**
 * What every build of the browser app shares for the interface base (ADR 0103): Tailwind through its Vite
 * plugin (no PostCSS, no tailwind.config.js), the `@/ui` and `@/lib` aliases of `components.json`, and no
 * asset inlined as `data:`. The shell has `font-src 'self'`, which refuses `data:`: a small font face
 * inlined by the default 4 KB limit would vanish in silence, seen only by a browser that needed it. The
 * target is the browser floor above.
 */
export const uiBuild = {
  build: { assetsInlineLimit: 0, target: BROWSER_TARGET },
  resolve: {
    alias: {
      "@/lib": fileURLToPath(new URL("./src/lib", import.meta.url)),
      "@/ui": fileURLToPath(new URL("./src/ui", import.meta.url)),
    },
  },
} satisfies UserConfig;

export const uiPlugins = () => tailwindcss();
