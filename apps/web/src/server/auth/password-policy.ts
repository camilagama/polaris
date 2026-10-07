export type PasswordPolicyErrorCode =
  | "password_compromised"
  | "password_hibp_unavailable"
  | "password_invalid_unicode"
  | "password_too_long"
  | "password_too_short";

export class PasswordPolicyError extends Error {
  readonly code: PasswordPolicyErrorCode;

  constructor(code: PasswordPolicyErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.code = code;
    this.name = "PasswordPolicyError";
  }
}

export interface PasswordPolicyErrorDetails {
  code: PasswordPolicyErrorCode;
  message: string;
  status: 400 | 503;
}

export function passwordPolicyErrorDetails(
  error: PasswordPolicyError
): PasswordPolicyErrorDetails {
  const messages = {
    password_compromised:
      "Choose a password that has not appeared in a breach.",
    password_hibp_unavailable:
      "Password validation is temporarily unavailable.",
    password_invalid_unicode: "Password contains unsupported Unicode.",
    password_too_long: "Password exceeds the maximum length.",
    password_too_short: "Password does not meet the minimum length.",
  } satisfies Record<PasswordPolicyErrorCode, string>;

  return {
    code: error.code,
    message: messages[error.code],
    status: error.code === "password_hibp_unavailable" ? 503 : 400,
  };
}

const PASSWORD_MIN_CODE_POINTS = 15;
const PASSWORD_MAX_CODE_POINTS = 128;
const HIBP_RANGE_URL = "https://api.pwnedpasswords.com/range/";
const HIBP_TIMEOUT_MS = 5000;
const HASH_PREFIX_LENGTH = 5;
const HASH_SUFFIX_PATTERN = /^[A-F0-9]{35}$/;
const HASH_COUNT_PATTERN = /^\d+$/;
const RANGE_LINES_PATTERN = /\r?\n/;

export type PasswordRangeFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export function normalizePassword(password: string): string {
  if (hasUnpairedSurrogate(password)) {
    throw new PasswordPolicyError("password_invalid_unicode");
  }

  return password.normalize("NFC");
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);

    if (codeUnit >= 0xd8_00 && codeUnit <= 0xdb_ff) {
      if (index + 1 >= value.length) {
        return true;
      }

      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit < 0xdc_00 || nextCodeUnit > 0xdf_ff) {
        return true;
      }

      index += 1;
      continue;
    }

    if (codeUnit >= 0xdc_00 && codeUnit <= 0xdf_ff) {
      return true;
    }
  }

  return false;
}

function sha1Hex(value: string): Promise<string> {
  return crypto.subtle
    .digest("SHA-1", new TextEncoder().encode(value))
    .then((digest) =>
      Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0")
      )
        .join("")
        .toUpperCase()
    );
}

function hasPositiveMatch(rangeResponse: string, suffix: string): boolean {
  const lines = rangeResponse.trim().split(RANGE_LINES_PATTERN);

  if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) {
    throw new Error("The HIBP range response is empty.");
  }

  for (const line of lines) {
    const separatorIndex = line.indexOf(":");
    const candidateSuffix = line.slice(0, separatorIndex).trim().toUpperCase();
    const countText = line.slice(separatorIndex + 1).trim();

    if (
      separatorIndex < 0 ||
      !HASH_SUFFIX_PATTERN.test(candidateSuffix) ||
      !HASH_COUNT_PATTERN.test(countText)
    ) {
      throw new Error("The HIBP range response has an invalid format.");
    }

    if (candidateSuffix === suffix && Number(countText) > 0) {
      return true;
    }
  }

  return false;
}

async function isPasswordCompromised(
  normalizedPassword: string,
  fetcher: PasswordRangeFetcher
): Promise<boolean> {
  let hash: string;
  let response: Response;
  let body: string;

  try {
    hash = await sha1Hex(normalizedPassword);
    const prefix = hash.slice(0, HASH_PREFIX_LENGTH);
    response = await fetcher(`${HIBP_RANGE_URL}${prefix}`, {
      headers: {
        "Add-Padding": "true",
        "User-Agent": "Polaris/1.0",
      },
      signal: AbortSignal.timeout(HIBP_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error("The HIBP range request failed.");
    }

    body = await response.text();
    return hasPositiveMatch(body, hash.slice(HASH_PREFIX_LENGTH));
  } catch (error) {
    throw new PasswordPolicyError("password_hibp_unavailable", {
      cause: error,
    });
  }
}

export async function validateNewPassword(
  password: string,
  fetcher: PasswordRangeFetcher = fetch
): Promise<string> {
  const normalizedPassword = normalizePassword(password);
  const codePointLength = Array.from(normalizedPassword).length;

  if (codePointLength < PASSWORD_MIN_CODE_POINTS) {
    throw new PasswordPolicyError("password_too_short");
  }

  if (codePointLength > PASSWORD_MAX_CODE_POINTS) {
    throw new PasswordPolicyError("password_too_long");
  }

  if (await isPasswordCompromised(normalizedPassword, fetcher)) {
    throw new PasswordPolicyError("password_compromised");
  }

  return normalizedPassword;
}
