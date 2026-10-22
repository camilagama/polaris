/**
 * What a Playwright run takes from the environment, shared by the configs and the tests that name the app's origin.
 * The defaults are the ones the CI uses; a second session on the same machine sets its own ports
 * (docs/runbooks/testes-de-tela.md, "Duas sessões ao mesmo tempo").
 */
function integerFrom(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

const portFrom = (name: string, fallback: number) =>
  integerFrom(name, fallback, 1024, 65_535);

/** `vite preview` of the offline build (`playwright.offline-poc.config.ts`). */
export const OFFLINE_POC_PORT = portFrom("E2E_OFFLINE_POC_PORT", 4173);
/** The static server of the `pwa-e2e` build (`playwright.pwa.config.ts`). */
export const PWA_PORT = portFrom("E2E_PWA_PORT", 4174);

/** The two previews of the real local stack (`playwright.e2e-real.config.ts`), one per project. */
export const E2E_REAL_PORTS = {
  online: portFrom("E2E_REAL_PORT_ONLINE", 4321),
  "runtime-ligado": portFrom("E2E_REAL_PORT_RUNTIME", 4322),
} as const;

export const OFFLINE_POC_ORIGIN = `http://127.0.0.1:${OFFLINE_POC_PORT}`;
export const PWA_ORIGIN = `http://127.0.0.1:${PWA_PORT}`;

/** A server that is already listening is never reused in the CI, and outside it only when the person asks (`E2E_REUSE_SERVER=1`). */
export const reuseExistingServer =
  !process.env.CI && process.env.E2E_REUSE_SERVER === "1";

/** `E2E_WORKERS` sets the number of workers; without it, `fallback`. */
export const workersFrom = (fallback: number) =>
  integerFrom("E2E_WORKERS", fallback, 1, 32);
