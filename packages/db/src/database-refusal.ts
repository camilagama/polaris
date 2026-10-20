/**
 * Telling a refusal of a database function apart from any other error. A function refuses with its own message and
 * SQLSTATE; a constraint names itself. Both are looked up along the error's causes (the driver and the ORM wrap them).
 */

/**
 * True when the database raised exactly this refusal: its SQLSTATE and the message the function gives it. 42501 is
 * also PostgreSQL's "insufficient privilege", so the code alone would turn a missing grant into a polite refusal
 * instead of an error.
 */
export function raised(
  error: unknown,
  state: string,
  message: string
): boolean {
  const visited = new Set<object>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null) {
    if (visited.has(current)) {
      return false;
    }
    visited.add(current);
    const candidate = current as {
      cause?: unknown;
      code?: unknown;
      message?: unknown;
    };
    if (typeof candidate.code === "string" && candidate.code.length === 5) {
      return candidate.code === state && candidate.message === message;
    }
    current = candidate.cause;
  }
  return false;
}

/** True when the error, or one of its causes, is the violation of this constraint. */
export function hasConstraint(error: unknown, constraint: string): boolean {
  const seen = new Set<object>();
  let current: unknown = error;
  while (
    typeof current === "object" &&
    current !== null &&
    !seen.has(current)
  ) {
    seen.add(current);
    const candidate = current as { cause?: unknown; constraint?: unknown };
    if (candidate.constraint === constraint) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

/** The SQLSTATE of the error or of the first of its causes that has one. */
export function sqlStateOf(error: unknown): string | undefined {
  const visited = new Set<object>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null) {
    if (visited.has(current)) {
      return undefined;
    }
    visited.add(current);
    const candidate = current as { cause?: unknown; code?: unknown };
    if (typeof candidate.code === "string" && candidate.code.length === 5) {
      return candidate.code;
    }
    current = candidate.cause;
  }
  return undefined;
}
