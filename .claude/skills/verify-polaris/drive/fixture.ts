import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test as base, type Page } from "@playwright/test";
import { appendLeiame, commitLabel, evidenceDir } from "../scripts/leiame";

// biome-ignore lint/performance/noBarrelFile: the drives import test and expect from one place
export { expect } from "@playwright/test";

const DRIVE_SUFFIX = /\.verify\.ts$/;

/**
 * The fixture of every verify-polaris drive: the page is signed in as the store of the run (config), the whole drive
 * is traced, and `evidence.shot` writes a screenshot and an ARIA snapshot to the evidence directory with one line of
 * LEIAME.md each (file, state, address, store, project, commit). The evidence directory is never cleaned by the skill.
 */
export interface Evidence {
  /** Screenshot and ARIA snapshot of the page now, named `<nome>-<projeto>`, with `estado` in LEIAME.md. */
  shot: (nome: string, estado: string, page?: Page) => Promise<string>;
}

export const test = base.extend<{ evidence: Evidence }>({
  evidence: [
    async ({ context, page }, use, testInfo) => {
      const dir = evidenceDir();
      mkdirSync(join(dir, "traces"), { recursive: true });
      mkdirSync(join(dir, "drives"), { recursive: true });
      const project = testInfo.project.name;
      const loja = process.env.VERIFY_LOJA ?? "vazia";
      const drive = basename(testInfo.file).replace(DRIVE_SUFFIX, "");
      const sha = commitLabel();
      await context.tracing.start({ screenshots: true, snapshots: true });
      await use({
        shot: async (nome, estado, target = page) => {
          const name = `${nome}-${project}`;
          const png = join(dir, `${name}.png`);
          await target.screenshot({ path: png });
          // the whole body: an open modal Dialog takes the page out of the tree, and it is in the body too
          writeFileSync(
            join(dir, `${name}.aria.yml`),
            await target.locator("body").ariaSnapshot()
          );
          const address = new URL(target.url());
          appendLeiame({
            address: `${address.pathname}${address.search}`,
            file: `${name}.png (+ .aria.yml)`,
            loja,
            project,
            sha,
            state: estado,
          });
          return png;
        },
      });
      const trace = `traces/${drive}-${project}-${Date.now()}.zip`;
      await context.tracing.stop({ path: join(dir, trace) });
      copyFileSync(testInfo.file, join(dir, "drives", basename(testInfo.file)));
      const passed = testInfo.status === testInfo.expectedStatus;
      appendLeiame({
        address: "",
        file: trace,
        loja,
        project,
        sha,
        state: `traço do drive ${drive}: ${passed ? "passou" : `FALHOU (${testInfo.status})`}`,
      });
    },
    { auto: true },
  ],
});
