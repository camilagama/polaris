/**
 * Registers the service worker of the app shell (plan PR60). Only in a production
 * build, only where the browser supports it and the page is a secure context, and
 * never for the offline laboratories (they are served without a worker so their
 * checks do not depend on one).
 */
export interface RegisterEnvironment {
  isProduction: boolean;
  isSecureContext: boolean;
  pathname: string;
  register: (
    url: string,
    options: { scope: string; updateViaCache: "none" }
  ) => Promise<ServiceWorkerRegistration>;
  supportsServiceWorker: boolean;
}

const LAB_PREFIX = "/offline-";

export function shouldRegisterServiceWorker(
  environment: RegisterEnvironment
): boolean {
  return (
    environment.isProduction &&
    environment.supportsServiceWorker &&
    environment.isSecureContext &&
    !environment.pathname.startsWith(LAB_PREFIX)
  );
}

/** Registers `/sw.js`; resolves to null when it should not or could not. */
export async function registerServiceWorker(
  environment: RegisterEnvironment
): Promise<ServiceWorkerRegistration | null> {
  if (!shouldRegisterServiceWorker(environment)) {
    return null;
  }
  try {
    return await environment.register("/sw.js", {
      // The worker script itself is never served from the HTTP cache.
      scope: "/",
      updateViaCache: "none",
    });
  } catch {
    // The app works without the shell cache; nothing to tell the person.
    return null;
  }
}

/** The environment of the running page, or null on a server. */
export function browserRegisterEnvironment(): RegisterEnvironment | null {
  if (typeof navigator === "undefined" || typeof window === "undefined") {
    return null;
  }
  return {
    isProduction: import.meta.env.PROD,
    isSecureContext: window.isSecureContext,
    pathname: window.location.pathname,
    register: (url, options) => navigator.serviceWorker.register(url, options),
    supportsServiceWorker: "serviceWorker" in navigator,
  };
}
