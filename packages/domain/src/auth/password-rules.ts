/**
 * The rules of a new password (ADR 0100, amended), the one source of the screen and of the server: at least 8
 * characters, a number, an uppercase and a lowercase letter, and at most 128 characters. A special character is a
 * hint only: it makes the meter stronger and never refuses. Characters are code points of the NFC form, so an
 * accented letter typed as two code points counts once, as the server stores it.
 */
export const PASSWORD_MIN_CHARACTERS = 8;
export const PASSWORD_MAX_CHARACTERS = 128;

/** The required rules, in the order the screen lists them and the server reports the first one missing. */
export const PASSWORD_REQUIREMENTS = [
  "length",
  "number",
  "uppercase",
  "lowercase",
] as const;
export type PasswordRequirement = (typeof PASSWORD_REQUIREMENTS)[number];

/** 0: nothing typed; 1 and 2: weak; 3: every required rule; 4: those and a special character. */
export type PasswordStrength = 0 | 1 | 2 | 3 | 4;

const NUMBER = /\p{Nd}/u;
const UPPERCASE = /\p{Lu}/u;
const LOWERCASE = /\p{Ll}/u;
// a combining mark left after NFC belongs to a letter, not a special character
const SPECIAL = /[^\p{L}\p{N}\p{M}]/u;

export function passwordCharacters(password: string): number {
  return Array.from(password.normalize("NFC")).length;
}

const checks: Record<PasswordRequirement, (password: string) => boolean> = {
  length: (password) => passwordCharacters(password) >= PASSWORD_MIN_CHARACTERS,
  lowercase: (password) => LOWERCASE.test(password.normalize("NFC")),
  number: (password) => NUMBER.test(password.normalize("NFC")),
  uppercase: (password) => UPPERCASE.test(password.normalize("NFC")),
};

export function meetsPasswordRequirement(
  password: string,
  requirement: PasswordRequirement
): boolean {
  return checks[requirement](password);
}

export function unmetPasswordRequirements(
  password: string
): PasswordRequirement[] {
  return PASSWORD_REQUIREMENTS.filter(
    (requirement) => !checks[requirement](password)
  );
}

export function hasSpecialCharacter(password: string): boolean {
  return SPECIAL.test(password.normalize("NFC"));
}

export function passwordStrength(password: string): PasswordStrength {
  if (password.length === 0) {
    return 0;
  }
  const met =
    PASSWORD_REQUIREMENTS.length - unmetPasswordRequirements(password).length;
  if (met < PASSWORD_REQUIREMENTS.length) {
    return met >= 2 ? 2 : 1;
  }
  return hasSpecialCharacter(password) ? 4 : 3;
}
