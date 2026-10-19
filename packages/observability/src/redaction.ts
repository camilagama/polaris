/**
 * Redaction policy of the backend's log events (ADR 0089, amended by PR116).
 *
 * One policy for every event: `emit` (the only way out of the logger) runs the
 * whole payload through `redact` before evlog sees it. It works in two ways at
 * any depth (objects, arrays, `Map`/`Set`, `Headers`, `error.cause` chains):
 *
 * - by key name: a key that says what it holds (`password`, `Cookie`,
 *   `customerEmail`, `clientIp`) loses its value, whatever the value looks like;
 * - by value pattern: a string that looks like personal data or a secret
 *   (an e-mail, a CPF/CNPJ, a phone number, a card number, an IP, a bearer
 *   token, a JWT, a URL with credentials) loses that part, whatever the key is.
 *
 * What is masked: password, cookie, token, Authorization, secret, key,
 * phone, e-mail, CPF/CNPJ, card and IP. The marker says the category
 * (`[REDACTED:email]`), never the value.
 *
 * Limits, on purpose (ADR 0089 lists them): a boolean or `null` under a
 * sensitive key is kept (it says "there is a password", not the password); a
 * number is masked by key name only, because timestamps and counters have the
 * digits of a phone number, and a counter (`tokenCount`) keeps its value; a
 * string longer than `MAX_TEXT` is cut, and a container keeps `MAX_ITEMS`
 * entries, so the policy costs the same however large the input is.
 * The only IP exception is the one an ADR asks for and `ipAllowedKeys` lists:
 * today there is none (the access record of ADR 0092 lives in PostgreSQL, never
 * in the log).
 */

type RedactionCategory =
  | "card"
  | "cnpj"
  | "cpf"
  | "email"
  | "ip"
  | "phone"
  | "secret";

/**
 * Keys that may carry an IP address because an ADR asks for the field in the
 * log. Empty: ADR 0092 keeps the IP out of the log (`auth_access_log_*` events
 * carry `requestId` and a reason, never the address). Adding a name here needs
 * the ADR that requires it, named in a comment on the entry.
 */
const ipAllowedKeys: ReadonlySet<string> = new Set<string>();

const MAX_DEPTH = 8;
/** Longest string the patterns read; the rest is cut (a message or a body can be huge). */
const MAX_TEXT = 4096;
/** Entries kept per object, array, `Map` or `Set`. */
const MAX_ITEMS = 100;

function marker(category: RedactionCategory): string {
  return `[REDACTED:${category}]`;
}

const lowerCase = /[a-z]/;
const upperCase = /[A-Z]/;
const hasDigit = /\d/;
const alnum = /[A-Za-z\d]/;
const hexGroup = /^[\da-f]{1,4}$/i;
const nonAlnum = /[^a-z\d]+/;
const camelBoundary = /([a-z\d])([A-Z])/g;
const acronymBoundary = /([A-Z]+)([A-Z][a-z])/g;
const nonDigit = /\D/g;
const invisible = /\p{Cf}/gu;

/** Splits a key into lowercase words: `clientIP`, `client_ip` and `client-ip` give `client`, `ip`. */
function wordsOf(key: string): string[] {
  return key
    .replaceAll(camelBoundary, "$1 $2")
    .replaceAll(acronymBoundary, "$1 $2")
    .toLowerCase()
    .split(nonAlnum)
    .filter(Boolean);
}

/** Secrets: the word anywhere in the key (`accessToken`, `token_expires`, `newPassword`). */
const secretWords: ReadonlySet<string> = new Set([
  "assertion",
  "authorization",
  "bearer",
  "chave",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "csrf",
  "dsn",
  "hmac",
  "jwt",
  "otp",
  "pass",
  "passphrase",
  "passwd",
  "password",
  "pin",
  "pwd",
  "secret",
  "secrets",
  "segredo",
  "senha",
  "sid",
  "sig",
  "signature",
  "token",
  "tokens",
]);
/** Spellings that run words together (`apikey`, `setcookie`, `connectionstring`). */
const secretSubstrings = [
  "accesskey",
  "apikey",
  "authorization",
  "connectionstring",
  "cookie",
  "databaseurl",
  "encryptionkey",
  "magiclink",
  "password",
  "privatekey",
  "secretkey",
  "sessionid",
  "sessiontoken",
  "setcookie",
  "signingkey",
  "token",
  "verificationcode",
];
/** A whole key that is just `key` or `session` is a secret; `objectKey` and `idempotencyKey` are not. */
const secretWholeKeys: ReadonlySet<string> = new Set(["key", "session"]);
/** Last word that makes a number a count or a size, never the secret itself. */
const counterWords: ReadonlySet<string> = new Set([
  "count",
  "counts",
  "failed",
  "length",
  "ms",
  "sent",
  "size",
  "total",
]);

/**
 * Personal data: the word must end the key (`customerEmail`, `emailAddress`,
 * `phone_number`), so `emailProvider`, `ipCount` and `cardinality` stay.
 */
const piiWords: Readonly<Record<string, RedactionCategory>> = {
  card: "card",
  cartao: "card",
  celular: "phone",
  cnpj: "cnpj",
  cpf: "cpf",
  cvc: "card",
  cvv: "card",
  documento: "cpf",
  email: "email",
  emails: "email",
  fone: "phone",
  ip: "ip",
  ipv4: "ip",
  ipv6: "ip",
  mail: "email",
  mobile: "phone",
  msisdn: "phone",
  pan: "card",
  phone: "phone",
  tel: "phone",
  telefone: "phone",
  whatsapp: "phone",
};
/** Words that may follow a personal-data word and still name the datum itself. */
const piiTail: ReadonlySet<string> = new Set([
  "addr",
  "address",
  "num",
  "number",
  "raw",
  "text",
  "value",
]);
/** Spellings that run words together (`cfconnectingip`, `xforwardedfor`, `creditcard`). */
const piiSubstrings: readonly [string, RedactionCategory][] = [
  ["clientip", "ip"],
  ["connectingip", "ip"],
  ["creditcard", "card"],
  ["forwardedfor", "ip"],
  ["ipaddress", "ip"],
  ["realip", "ip"],
  ["remoteaddr", "ip"],
  ["remoteip", "ip"],
];

function piiCategory(words: readonly string[]): RedactionCategory | undefined {
  for (let index = words.length - 1; index >= 0; index -= 1) {
    const word = words[index] ?? "";
    const category = piiWords[word];
    if (category !== undefined) {
      return category;
    }
    if (!piiTail.has(word)) {
      return undefined;
    }
  }
  return undefined;
}

/** The category a key name says it holds, or `undefined` for an innocent name. */
function categoryOfKey(key: string): RedactionCategory | undefined {
  const words = wordsOf(key);
  const squashed = words.join("");

  if (
    words.some((word) => secretWords.has(word)) ||
    secretWholeKeys.has(squashed) ||
    secretSubstrings.some((part) => squashed.includes(part))
  ) {
    return "secret";
  }
  const substring = piiSubstrings.find(([part]) => squashed.includes(part));
  const category =
    substring?.[1] ??
    piiCategory(words) ??
    (squashed.endsWith("email") ? "email" : undefined);
  if (category === "ip" && ipAllowedKeys.has(key)) {
    return undefined;
  }
  return category;
}

/** True when the last word of the key makes a number a counter (`tokenCount`). */
function isCounterKey(key: string): boolean {
  return counterWords.has(wordsOf(key).at(-1) ?? "");
}

const uuidSplit =
  /(\b[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b)/i;

/** `(?<![A-Za-z\d])`: a run of digits inside a longer word or hash is not a document. */
const startsAlone = String.raw`(?<![A-Za-z\d])`;
const endsAlone = String.raw`(?![A-Za-z\d])`;

const cnpjPattern = new RegExp(
  `${startsAlone}(?:[A-Z\\d]{2}\\.[A-Z\\d]{3}\\.[A-Z\\d]{3}/[A-Z\\d]{4}-\\d{2}|\\d{14}|(?=[A-Z\\d]*\\d)(?=[A-Z\\d]*[A-Z])[A-Z\\d]{12}\\d{2})${endsAlone}`,
  "g"
);
const cpfPattern = new RegExp(
  `${startsAlone}(?:\\d{3}[.\\s-]\\d{3}[.\\s-]\\d{3}[-\\s]\\d{2}|\\d{11})${endsAlone}`,
  "g"
);
/** A mobile (`DDD 9xxxx-xxxx`) or landline (`DDD [2-5]xxx-xxxx`) number, with or without separators, with or without `+55`. */
const phonePatterns = [
  // international: a `+`, then digits and the usual separators
  /(?<![A-Za-z\d])\+\d[\d\s().-]{6,18}\d(?![A-Za-z\d])/g,
  // `5511988887777`: the country code without the `+` (WhatsApp, provider payloads)
  new RegExp(
    `${startsAlone}55[1-9]\\d(?:9\\d{8}|[2-5]\\d{7})${endsAlone}`,
    "g"
  ),
  // `(11) 99999-8888`, `11 9999-8888`, `99999-8888`, `9999-8888`
  new RegExp(
    `${startsAlone}(?:\\(?[1-9]\\d\\)?[\\s.-]?)?9?\\d{4}[\\s.-]\\d{4}${endsAlone}`,
    "g"
  ),
  // `11999998888` is caught by the CPF pattern (11 digits); a landline has 10
  new RegExp(`${startsAlone}[1-9]\\d[2-5]\\d{7}${endsAlone}`, "g"),
];
const ipv4Candidate = /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.]*\d)/g;
const ipv6Candidate =
  /(?<![\w:.])(?:[\da-f]{0,4}:){2,7}[\da-f]{0,4}(?![\w:])/gi;
const cardCandidate = /(?<!\d)\d(?:[\s./-]{0,2}\d){12,18}(?!\d)/g;

/** `postgresql://user:password@host`: what sits between `://` and `@` goes. */
const urlCredentialPattern = /(?<=:\/\/)[^\s/@]+(?=@)/g;

/** `Cookie: a=1; b=2` and `Set-Cookie: ...`: the rest of the line is the secret. */
const cookieHeaderPattern = /\b(?:set-)?cookie\s*[:=][^\r\n]*/gi;

const secretValuePatterns: readonly RegExp[] = [
  // `Authorization: Bearer abc`, `Bearer abc`
  /\bBearer\s+[\w~+/.=-]{6,}/gi,
  // a JWT
  /\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]*/g,
  // provider keys: Stripe-like, Asaas (`$aact_`), webhook secrets, GitHub, Slack, AWS
  /\$?\b(?:sk|rk|pk|whsec|ghp|gho|ghs|xox[abprs]|aact)_[\w.-]{8,}/gi,
  /\b(?:AKIA|ASIA)[A-Z\d]{16}\b/g,
  // `password=...`, `"token": "..."`, `session_token=...`, `Authorization: Basic x`
  /(?<![A-Za-z])(?:pass(?:word|wd)?|pwd|senha|secret|segredo|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|session[_-]?(?:id|token|data)|sid|csrf|signature|hmac|credentials?)[\w.-]{0,32}["']?\s*[=:]\s*["']?(?:(?:Bearer|Basic|Token|Digest)\s+)?[^\s"',;&}]+/gi,
];

/** A long run of base64/URL-safe characters that switches case and digits like random data is a token. */
const tokenShapePattern = /[A-Za-z\d_+=-]{32,}/g;
const TOKEN_CHANGE_RATE = 0.45;

function classOf(char: string): number {
  if (lowerCase.test(char)) {
    return 0;
  }
  return upperCase.test(char) ? 1 : 2;
}

function looksLikeToken(candidate: string): boolean {
  if (
    !(
      lowerCase.test(candidate) &&
      upperCase.test(candidate) &&
      hasDigit.test(candidate)
    )
  ) {
    return false;
  }
  // `ScheduledJobRunOutcomeHandler2Failure` changes class rarely; random data often
  let changes = 0;
  let last = -1;
  for (const char of candidate) {
    if (alnum.test(char)) {
      const current = classOf(char);
      if (last !== -1 && current !== last) {
        changes += 1;
      }
      last = current;
    }
  }
  return changes / candidate.length >= TOKEN_CHANGE_RATE;
}

function luhnOk(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = Number(digits.charAt(index));
    if (double) {
      value *= 2;
      if (value > 9) {
        value -= 9;
      }
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

function isIpv4(candidate: string): boolean {
  return candidate.split(".").every((octet) => Number(octet) <= 255);
}

function isIpv6(candidate: string): boolean {
  const groups = candidate.split(":");
  if (candidate.includes("::")) {
    return (
      candidate.split("::").length === 2 &&
      groups.length <= 9 &&
      groups.every((group) => group.length <= 4)
    );
  }
  return groups.length === 8 && groups.every((group) => hexGroup.test(group));
}

const emailLocal = /[^\s@<>()[\]",;:\\]/;
const emailDomain = /[^\s@<>()[\]",;:\\/]/;

/**
 * E-mail addresses, found from each `@` outwards: linear, where a pattern that
 * starts at every character of a long word would not be.
 */
function maskEmails(text: string): string {
  let at = text.indexOf("@");
  let out = "";
  let copied = 0;
  while (at !== -1) {
    let start = at;
    while (start > copied && emailLocal.test(text.charAt(start - 1))) {
      start -= 1;
    }
    let end = at + 1;
    while (end < text.length && emailDomain.test(text.charAt(end))) {
      end += 1;
    }
    // a trailing dot ends a sentence, it is not part of the host
    while (end > at + 1 && text.charAt(end - 1) === ".") {
      end -= 1;
    }
    const domain = text.slice(at + 1, end);
    if (start < at && domain.includes(".") && !domain.startsWith(".")) {
      out += text.slice(copied, start) + marker("email");
      copied = end;
      at = text.indexOf("@", end);
    } else {
      at = text.indexOf("@", at + 1);
    }
  }
  return out + text.slice(copied);
}

/** Secrets first and over the whole text: a token shaped like a UUID is still a token. */
function scrubSecrets(text: string): string {
  let result = text
    .replace(cookieHeaderPattern, marker("secret"))
    .replace(urlCredentialPattern, marker("secret"));
  for (const pattern of secretValuePatterns) {
    result = result.replace(pattern, marker("secret"));
  }
  return result;
}

function scrubPersonal(text: string): string {
  let result = maskEmails(text);
  result = result.replace(cardCandidate, (match) =>
    luhnOk(match.replaceAll(nonDigit, "")) ? marker("card") : match
  );
  result = result.replace(cnpjPattern, marker("cnpj"));
  result = result.replace(cpfPattern, marker("cpf"));
  for (const pattern of phonePatterns) {
    result = result.replace(pattern, marker("phone"));
  }
  result = result.replace(ipv4Candidate, (match) =>
    isIpv4(match) ? marker("ip") : match
  );
  result = result.replace(ipv6Candidate, (match) =>
    isIpv6(match) ? marker("ip") : match
  );
  return result.replace(tokenShapePattern, (match) =>
    looksLikeToken(match) ? marker("secret") : match
  );
}

function scrub(text: string): string {
  // `split` with a capture group keeps the UUIDs (ids) at the odd positions
  return scrubSecrets(text)
    .split(uuidSplit)
    .map((part, index) => (index % 2 === 1 ? part : scrubPersonal(part)))
    .join("");
}

/**
 * The text with every personal-data or secret-looking part masked. The patterns
 * read the compatibility form (full-width digits, `＠`) with the invisible
 * characters taken out, and the text is only replaced by that form when
 * something was masked.
 */
export function redactText(text: string): string {
  const bounded =
    text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}[TRUNCATED]` : text;
  const plain = bounded.normalize("NFKC").replaceAll(invisible, "");
  const scrubbed = scrub(plain);
  return scrubbed === plain ? bounded : scrubbed;
}

function redactError(
  error: Error,
  depth: number,
  seen: WeakSet<object>
): Record<string, unknown> {
  const out = new Map<string, unknown>([
    ["message", redactText(error.message)],
    ["name", redactText(error.name)],
  ]);
  if (error.stack !== undefined) {
    out.set("stack", redactText(error.stack));
  }
  if ("cause" in error) {
    out.set("cause", redactValue(error.cause, depth + 1, seen));
  }
  if (error instanceof AggregateError) {
    out.set("errors", redactValue(error.errors, depth + 1, seen));
  }
  // own enumerable extras (`code`, `status`, a provider payload)
  for (const [key, value] of Object.entries(error).slice(0, MAX_ITEMS)) {
    out.set(key, redactEntry(key, value, depth + 1, seen));
  }
  return Object.fromEntries(out);
}

function redactEntry(
  key: string,
  value: unknown,
  depth: number,
  seen: WeakSet<object>
): unknown {
  const category = categoryOfKey(key);
  if (category === undefined) {
    return redactValue(value, depth, seen);
  }
  // "there is a password" says nothing about the password; a count is not one either
  if (
    typeof value === "boolean" ||
    value === null ||
    value === undefined ||
    (typeof value === "number" && isCounterKey(key))
  ) {
    return value;
  }
  return marker(category);
}

function redactRecord(
  entries: Iterable<[unknown, unknown]>,
  depth: number,
  seen: WeakSet<object>
): Record<string, unknown> {
  // `fromEntries` defines own properties: a key named `__proto__` stays data
  const out = new Map<string, unknown>();
  let dropped = 0;
  for (const [rawKey, value] of entries) {
    if (out.size >= MAX_ITEMS) {
      dropped += 1;
      continue;
    }
    const key = String(rawKey);
    // a key can carry data too (`{ "maria@example.com": 1 }`)
    const masked = redactText(key);
    let safeKey = masked;
    let suffix = 1;
    while (safeKey !== key && out.has(safeKey)) {
      suffix += 1;
      safeKey = `${masked}#${suffix}`;
    }
    out.set(safeKey, redactEntry(key, value, depth, seen));
  }
  if (dropped > 0) {
    out.set("[TRUNCATED]", dropped);
  }
  return Object.fromEntries(out);
}

function redactList(
  items: readonly unknown[],
  depth: number,
  seen: WeakSet<object>
): unknown[] {
  const kept = items
    .slice(0, MAX_ITEMS)
    .map((item) => redactValue(item, depth + 1, seen));
  if (items.length > MAX_ITEMS) {
    kept.push(`[TRUNCATED:${items.length - MAX_ITEMS}]`);
  }
  return kept;
}

/** Objects with a known safe reading; `handled: false` for a plain object, an array, a `Map` or a `Set`. */
function redactSpecial(
  value: object,
  depth: number,
  seen: WeakSet<object>
): { handled: boolean; result?: unknown } {
  if (value instanceof Date) {
    return {
      handled: true,
      result: Number.isNaN(value.getTime()) ? null : value.toISOString(),
    };
  }
  if (value instanceof Error) {
    return { handled: true, result: redactError(value, depth, seen) };
  }
  if (
    value instanceof String ||
    value instanceof Number ||
    value instanceof Boolean
  ) {
    return { handled: true, result: redactValue(value.valueOf(), depth, seen) };
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return { handled: true, result: `[BINARY:${value.byteLength}]` };
  }
  if (value instanceof URL) {
    return { handled: true, result: redactText(value.href) };
  }
  if (value instanceof Headers || value instanceof URLSearchParams) {
    return {
      handled: true,
      result: redactRecord(value.entries(), depth + 1, seen),
    };
  }
  if (value instanceof Request || value instanceof Response) {
    return { handled: true, result: `[${value.constructor.name}]` };
  }
  return { handled: false };
}

/** Walks any value; what it cannot represent safely is dropped or replaced by a marker. */
function redactValue(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet()
): unknown {
  switch (typeof value) {
    case "string":
      return redactText(value);
    case "number":
    case "boolean":
    case "undefined":
      return value;
    case "bigint":
      return value.toString();
    case "object":
      break;
    default:
      // functions and symbols are not log data
      return undefined;
  }
  if (value === null) {
    return null;
  }
  if (depth >= MAX_DEPTH) {
    return "[TRUNCATED]";
  }
  if (seen.has(value)) {
    return "[CIRCULAR]";
  }
  seen.add(value);
  try {
    const special = redactSpecial(value, depth, seen);
    if (special.handled) {
      return special.result;
    }
    if (Array.isArray(value)) {
      return redactList(value, depth, seen);
    }
    if (value instanceof Set) {
      return redactList([...value], depth, seen);
    }
    if (value instanceof Map) {
      return redactRecord(value.entries(), depth + 1, seen);
    }
    return redactRecord(Object.entries(value), depth + 1, seen);
  } finally {
    // a shared (non-circular) reference may appear twice; only a cycle is cut
    seen.delete(value);
  }
}

/** Redacts the fields of one event. Always returns a new object; throws only if the input does (a getter). */
export function redact(
  fields: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  return redactRecord(Object.entries(fields), 0, new WeakSet());
}
