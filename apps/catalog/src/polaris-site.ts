/**
 * The address of the Polaris site the catalog footer links to. It comes from the POLARIS_SITE_URL variable
 * of the Worker (not a secret, empty until the site has an address): a value that is not a plain https
 * address (no credentials, no fragment) is the same as none, so the footer is then only text and nothing
 * fails. What comes back is the address itself and nothing about the store.
 */
export function polarisSiteHref(
  value: string | null | undefined
): string | null {
  if (typeof value !== "string" || value === "" || value !== value.trim()) {
    return null;
  }
  // anything the URL parser would silently drop or fix (tabs, line breaks, backslashes, invisible or non-ASCII
  // characters: a host in Unicode is given in punycode) is refused as written
  if (hasUnsafeCharacter(value) || value.includes("#")) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname === "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return null;
  }
  return url.href;
}

function hasUnsafeCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x20 || code >= 0x7f || character === "\\") {
      return true;
    }
  }
  return false;
}
