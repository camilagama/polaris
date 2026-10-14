/**
 * Set when the person chose "Sair" and the page is about to leave. A read of the
 * organizations that was already in flight can still answer after the cache was
 * cleared; it must not write the cache again.
 */
let signingOut = false;

export function markSigningOut(): void {
  signingOut = true;
}

export function isSigningOut(): boolean {
  return signingOut;
}
