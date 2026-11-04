import {
  PASSWORD_MAX_CHARACTERS,
  type PasswordRequirement,
  passwordCharacters,
  unmetPasswordRequirements,
} from "@polaris/domain/auth/password-rules";

export type PasswordPolicyErrorCode =
  | "password_invalid_unicode"
  | "password_missing_lowercase"
  | "password_missing_number"
  | "password_missing_uppercase"
  | "password_too_long"
  | "password_too_short";

export class PasswordPolicyError extends Error {
  readonly code: PasswordPolicyErrorCode;

  constructor(code: PasswordPolicyErrorCode) {
    super(code);
    this.code = code;
    this.name = "PasswordPolicyError";
  }
}

export interface PasswordPolicyErrorDetails {
  code: PasswordPolicyErrorCode;
  message: string;
  status: 400;
}

export function passwordPolicyErrorDetails(
  error: PasswordPolicyError
): PasswordPolicyErrorDetails {
  const messages = {
    password_invalid_unicode: "Password contains unsupported Unicode.",
    password_missing_lowercase: "Password needs a lowercase letter.",
    password_missing_number: "Password needs a number.",
    password_missing_uppercase: "Password needs an uppercase letter.",
    password_too_long: "Password exceeds the maximum length.",
    password_too_short: "Password does not meet the minimum length.",
  } satisfies Record<PasswordPolicyErrorCode, string>;

  return { code: error.code, message: messages[error.code], status: 400 };
}

/** One error per rule: the first rule missing, in the order of the screen's list. */
const REQUIREMENT_ERRORS = {
  length: "password_too_short",
  lowercase: "password_missing_lowercase",
  number: "password_missing_number",
  uppercase: "password_missing_uppercase",
} satisfies Record<PasswordRequirement, PasswordPolicyErrorCode>;

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

/** The rules of a new password (`@polaris/domain/auth/password-rules`), on the NFC form the hash takes. */
export function validateNewPassword(password: string): string {
  const normalizedPassword = normalizePassword(password);

  if (passwordCharacters(normalizedPassword) > PASSWORD_MAX_CHARACTERS) {
    throw new PasswordPolicyError("password_too_long");
  }

  const [missing] = unmetPasswordRequirements(normalizedPassword);
  if (missing) {
    throw new PasswordPolicyError(REQUIREMENT_ERRORS[missing]);
  }

  return normalizedPassword;
}
