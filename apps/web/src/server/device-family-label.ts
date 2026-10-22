/**
 * The default name of a device the person did not name (U-51): the browser and the system, in family and without a
 * version, such as "Chrome no Android". It comes from a closed table, never from a piece of a header: the output is
 * one of `DEVICE_FAMILY_LABELS` or `null` (the screen shows "Aparelho sem nome"). Only the low-entropy Client Hints
 * that Chromium sends by default (`Sec-CH-UA`, `Sec-CH-UA-Platform`, no `Accept-CH`) and, without them (Safari,
 * Firefox), fixed tokens of the `User-Agent`. Only the first 512 characters of each header are looked at, with
 * `includes` and no regular expression; nothing of the headers is kept or logged.
 */

const MAX_HEADER_CHARACTERS = 512;

/** The browser by its `Sec-CH-UA` brand, in the order of the table: the first known brand of the table wins. */
const BRANDS: readonly (readonly [brand: string, browser: string])[] = [
  ["Microsoft Edge", "Edge"],
  ["Samsung Internet", "Samsung Internet"],
  ["Opera", "Opera"],
  ["Google Chrome", "Chrome"],
];

/** The browser by a token of the `User-Agent`, in this order (an Edge, Opera or Samsung one also says "Chrome"). */
const USER_AGENT_BROWSERS: readonly (readonly [
  token: string,
  browser: string,
])[] = [
  ["Edg", "Edge"],
  ["SamsungBrowser", "Samsung Internet"],
  ["OPR", "Opera"],
  ["CriOS", "Chrome"],
  ["FxiOS", "Firefox"],
  ["Firefox", "Firefox"],
  ["Chrome", "Chrome"],
];

/** The system by `Sec-CH-UA-Platform` (its value, without the quotes). */
const PLATFORMS: Readonly<Record<string, string>> = {
  Android: "Android",
  "Chrome OS": "ChromeOS",
  ChromeOS: "ChromeOS",
  Linux: "Linux",
  macOS: "Mac",
  Windows: "Windows",
};

/** The system by a token of the `User-Agent`, in this order (an iPhone says "Mac OS X", an Android says "Linux"). */
const USER_AGENT_SYSTEMS: readonly (readonly [
  token: string,
  system: string,
])[] = [
  ["iPhone", "iPhone"],
  ["iPad", "iPad"],
  ["Android", "Android"],
  ["Windows", "Windows"],
  ["CrOS", "ChromeOS"],
  ["Macintosh", "Mac"],
  ["Linux", "Linux"],
];

const BROWSERS = [
  ...new Set([
    ...BRANDS.map(([, browser]) => browser),
    ...USER_AGENT_BROWSERS.map(([, browser]) => browser),
    "Safari",
  ]),
];
const SYSTEMS = [...new Set(USER_AGENT_SYSTEMS.map(([, system]) => system))];
const UNKNOWN_BROWSER = "Navegador";

/** Every name this module can give. */
export const DEVICE_FAMILY_LABELS: ReadonlySet<string> = new Set([
  ...BROWSERS,
  ...[...BROWSERS, UNKNOWN_BROWSER].flatMap((browser) =>
    SYSTEMS.map((system) => `${browser} no ${system}`)
  ),
]);

function headerStart(headers: Headers, name: string): string | null {
  const value = headers.get(name);
  return value === null ? null : value.slice(0, MAX_HEADER_CHARACTERS);
}

/** The brands of `Sec-CH-UA` (`"Brand";v="1", …`): the text between the first two quotes of each item. */
function brandsOf(header: string): string[] {
  const brands: string[] = [];
  for (const item of header.split(",")) {
    const trimmed = item.trim();
    if (trimmed.startsWith('"')) {
      const end = trimmed.indexOf('"', 1);
      if (end > 1) {
        brands.push(trimmed.slice(1, end));
      }
    }
  }
  return brands;
}

/**
 * The browser by the hints: only a brand of the table counts, so a GREASE brand ("Not A(Brand", "Not/A)Brand" and the
 * like) is never taken, and "Chromium" alone is the unknown browser (a Chromium of no known brand: Brave, an app's
 * web view, a test browser).
 */
function browserByHints(header: string): string {
  const brands = new Set(brandsOf(header));
  for (const [brand, browser] of BRANDS) {
    if (brands.has(brand)) {
      return browser;
    }
  }
  return UNKNOWN_BROWSER;
}

function browserByUserAgent(userAgent: string): string {
  for (const [token, browser] of USER_AGENT_BROWSERS) {
    if (userAgent.includes(token)) {
      return browser;
    }
  }
  return userAgent.includes("Safari") && userAgent.includes("Version/")
    ? "Safari"
    : UNKNOWN_BROWSER;
}

function systemByUserAgent(userAgent: string): string | null {
  for (const [token, system] of USER_AGENT_SYSTEMS) {
    if (userAgent.includes(token)) {
      return system;
    }
  }
  return null;
}

function systemByHints(header: string): string | null {
  const value = header.trim();
  const unquoted =
    value.length >= 2 && value.startsWith('"') && value.endsWith('"')
      ? value.slice(1, -1)
      : value;
  return Object.hasOwn(PLATFORMS, unquoted)
    ? (PLATFORMS[unquoted] ?? null)
    : null;
}

/** "Chrome no Android", "Safari no iPhone", "Firefox", "Navegador no Linux", or `null` when nothing is known. */
export function deviceFamilyLabel(headers: Headers): string | null {
  const userAgent = headerStart(headers, "user-agent") ?? "";
  const hints = headerStart(headers, "sec-ch-ua");
  const platform = headerStart(headers, "sec-ch-ua-platform");

  const browser =
    hints !== null && hints.trim() !== ""
      ? browserByHints(hints)
      : browserByUserAgent(userAgent);
  const system =
    (platform === null ? null : systemByHints(platform)) ??
    systemByUserAgent(userAgent);

  if (system === null) {
    return browser === UNKNOWN_BROWSER ? null : browser;
  }
  return `${browser} no ${system}`;
}
