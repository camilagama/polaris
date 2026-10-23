import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { mergeConfig, type Plugin } from "vite";
import base from "./vite.config";

const measure: Plugin = {
  name: "measure",
  generateBundle(_options, bundle) {
    const per = new Map<string, number>();
    for (const chunk of Object.values(bundle)) {
      if (chunk.type !== "chunk") continue;
      const gz = gzipSync(chunk.code, { level: 9 }).byteLength;
      const total = Object.values(chunk.modules).reduce((a, m) => a + m.renderedLength, 0) || 1;
      for (const [id, m] of Object.entries(chunk.modules)) {
        const key = id.replace(/.*\/apps\/web\//, "").replace(/.*node_modules\/(\.bun\/)?/, "nm:");
        per.set(key, (per.get(key) ?? 0) + (gz * m.renderedLength) / total);
      }
    }
    const lines = [...per.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${Math.round(v)}\t${k}`);
    writeFileSync(process.env.MEASURE_OUT ?? "/tmp/measure.txt", lines.join("\n"));
  },
};
export default async (env: never) => {
  const resolved = typeof base === "function" ? await (base as (e: never) => unknown)(env) : base;
  return mergeConfig(resolved as never, { plugins: [measure] });
};
