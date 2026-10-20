/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";

/**
 * The Content-Security-Policy of the SPA shell, read from the file the Worker serves (ADR 0090): the one
 * in the `/*` block, the rule that covers every path, not the first CSP line the file happens to have.
 */
const headers = readFileSync(
  new URL("../public/_headers", import.meta.url),
  "utf8"
);

const INDENTED_LINE = /^[ \t]+\S/;
const CSP_LINE = /^Content-Security-Policy: (.+)$/m;

/** The indented lines under a path rule of a Cloudflare `_headers` file, up to the next rule. */
function headersBlock(file: string, path: string) {
  const lines = file.split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === path);
  if (start === -1) {
    return "";
  }
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!INDENTED_LINE.test(line)) {
      break;
    }
    block.push(line.trim());
  }
  return block.join("\n");
}

export function policyOfBlock(file: string, path: string) {
  return CSP_LINE.exec(headersBlock(file, path))?.[1] ?? "";
}

export const productionPolicy = policyOfBlock(headers, "/*");

/**
 * Serves the documents, scripts and workers of the page under the production policy, as the static
 * assets of the Worker would. Under the dev server nothing applies it, so a violation would go unseen.
 */
export async function serveUnderProductionCsp(page: Page) {
  await page.route("**/*", async (route) => {
    const response = await route.fetch();
    const responseHeaders = { ...response.headers() };
    if (
      ["document", "other", "script"].includes(route.request().resourceType())
    ) {
      responseHeaders["content-security-policy"] = productionPolicy;
    }
    await route.fulfill({ headers: responseHeaders, response });
  });
}

interface CspEvent {
  blocked: string;
  directive: string;
  file: string;
}

/**
 * Violations that are known and harmless, each with the reason. Keep it as short as it can be: a new
 * entry needs the same justification in review.
 *
 * - Zod 4 probes `Function("")` inside a try/catch to decide whether it may compile validators
 *   (the `allowsEval` check, bundled in the orpc chunk). The CSP blocks it, the catch turns the JIT off,
 *   and nothing else happens. Dropping this entry takes `z.config({ jitless: true })` at startup.
 *   Recorded on 2026-10-20 (ADR 0103, PR 0): it leaves in the base PR, the first one that adds an interface
 *   package, together with that `z.config` call (not applied here: PR 0 changes no application code).
 *   `ui-supply-chain.test.ts` fails in that PR until this list is emptied.
 */
export const KNOWN_HARMLESS = [
  {
    blocked: "eval",
    directive: "script-src",
    file: /\/assets\/orpc-[\w-]+\.js$/,
    reason: "zod allowsEval probe",
  },
];

function isKnownHarmless(event: CspEvent) {
  return KNOWN_HARMLESS.some(
    (known) =>
      known.directive === event.directive &&
      known.blocked === event.blocked &&
      known.file.test(event.file)
  );
}

const CSP_CONSOLE_ERROR = /Content[- ]Security[- ]Policy|Refused to /i;

/**
 * Records every CSP violation of the page: the `securitypolicyviolation` event (registered by an init
 * script, so before any script of the page runs and again in every new document) and the console error
 * the browser prints for it. Workers do not fire the event on the document; their violation only
 * shows up in the console, which is why both are watched. `violations()` is what a test asserts empty.
 */
export async function watchCspViolations(page: Page) {
  const events: CspEvent[] = [];
  const consoleErrors: string[] = [];
  // exposeFunction survives navigations, unlike a variable in the page.
  await page.exposeFunction("__reportCspViolation", (detail: string) => {
    events.push(JSON.parse(detail) as CspEvent);
  });
  await page.addInitScript(() => {
    document.addEventListener(
      "securitypolicyviolation",
      (event) => {
        (
          window as unknown as {
            __reportCspViolation: (detail: string) => void;
          }
        ).__reportCspViolation(
          JSON.stringify({
            blocked: event.blockedURI || "inline",
            directive: event.effectiveDirective,
            file: event.sourceFile,
          })
        );
      },
      true
    );
  });
  page.on("console", (message) => {
    if (message.type() === "error" && CSP_CONSOLE_ERROR.test(message.text())) {
      consoleErrors.push(message.text().slice(0, 200));
    }
  });
  const describe = (event: CspEvent) =>
    `${event.directive} blocked ${event.blocked} at ${event.file}`;
  return {
    consoleErrors: () => [...consoleErrors],
    events: () =>
      events.filter((event) => !isKnownHarmless(event)).map(describe),
    violations: () => [
      ...events
        .filter((event) => !isKnownHarmless(event))
        .map((event) => `event: ${describe(event)}`),
      ...consoleErrors.map((text) => `console: ${text}`),
    ],
  };
}
