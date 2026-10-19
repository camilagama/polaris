import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LEGAL_CONTENT_SLUGS } from "@polaris/domain/legal/legal-documents";
import type { Plugin } from "vite";
import { checkLegalDocuments, isProductionBuild } from "./legal-guard";

const contentRoot = new URL("../src/legal/content/", import.meta.url);

/**
 * Runs the checks of `legal-guard.ts` before every build: the text and the version constant must
 * agree, and a production build refuses any marker still to be filled in. What counts as production
 * is in `isProductionBuild`: a build with no `CLOUDFLARE_ENV` counts too, unless `LEGAL_DRAFT_BUILD=1`
 * (the `build` script of the app) says it is a local or CI build.
 */
export function legalBuildGuardPlugin(): Plugin {
  let checked = false;
  return {
    apply: "build",
    buildStart() {
      // the Cloudflare plugin builds more than one environment; one check is enough
      if (checked) {
        return;
      }
      checked = true;
      const { errors, warnings } = checkLegalDocuments({
        production: isProductionBuild(process.env),
        readText: (document, version) => {
          try {
            return readFileSync(
              fileURLToPath(
                new URL(
                  `${LEGAL_CONTENT_SLUGS[document]}/v${version}.md`,
                  contentRoot
                )
              )
            );
          } catch {
            return null;
          }
        },
      });
      if (warnings.length > 0) {
        this.warn(
          `Texto legal ainda não final, visível na página (só o staging pode): ${warnings.join("; ")}`
        );
      }
      if (errors.length > 0) {
        this.error(errors.join("\n"));
      }
    },
    name: "polaris:legal-build-guard",
  };
}
