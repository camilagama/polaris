import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fillLegalCompanyFields } from "@polaris/domain/legal/legal-company";
import { LEGAL_CONTENT_SLUGS } from "@polaris/domain/legal/legal-documents";
import type { Plugin } from "vite";
import {
  checkLegalDocuments,
  isProductionBuild,
  type LegalCompanyEnv,
  legalCompanyValues,
} from "./legal-guard";

const contentRoot = new URL("../src/legal/content/", import.meta.url);
const rawTemplate =
  /[\\/]legal[\\/]content[\\/][^\\/?]+[\\/]v\d+\.md\?(?:[^#]*&)?raw(?:&|$)/;

/**
 * Runs the checks of `legal-guard.ts` before every build: the template and the version constant must
 * agree, and a production build refuses any marker still to be filled in, any missing company
 * variable and any token left in the text. What counts as production is in `isProductionBuild`: a
 * build with no `CLOUDFLARE_ENV` counts too, unless `LEGAL_DRAFT_BUILD=1` (the `build` script of the
 * app) says it is a local or CI build.
 *
 * It also fills the `{{FICHA}}` tokens of the templates as they load, so the bundle carries the final
 * text and the pages open offline with no Worker. The dev server never counts as production and
 * shows the examples where a variable is absent.
 */
export function legalBuildGuardPlugin(company: LegalCompanyEnv): Plugin {
  let building = false;
  let checked = false;
  const isProduction = () => building && isProductionBuild(process.env);
  return {
    buildStart() {
      // the Cloudflare plugin builds more than one environment; one check is enough
      if (!building || checked) {
        return;
      }
      checked = true;
      const { errors, warnings } = checkLegalDocuments({
        company,
        production: isProduction(),
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
    configResolved(config) {
      building = config.command === "build";
    },
    enforce: "pre",
    load(id) {
      if (!rawTemplate.test(id)) {
        return null;
      }
      const template = readFileSync(id.slice(0, id.indexOf("?")), "utf8");
      const { values } = legalCompanyValues(company, isProduction());
      return `export default ${JSON.stringify(fillLegalCompanyFields(template, values))};`;
    },
    name: "polaris:legal-build-guard",
  };
}
