const sqlStatePattern = /^[0-9A-Z]{5}$/;

function errorField(error: unknown, field: "code" | "constraint") {
  const visited = new Set<object>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null) {
    if (visited.has(current)) {
      return;
    }
    visited.add(current);
    const candidate = current as {
      cause?: unknown;
      code?: unknown;
      constraint?: unknown;
    };
    const value = candidate[field];
    if (
      typeof value === "string" &&
      (field === "constraint" || sqlStatePattern.test(value))
    ) {
      return value;
    }
    current = candidate.cause;
  }
}

export function sqlState(error: unknown): string | undefined {
  return errorField(error, "code");
}

export function sqlConstraint(error: unknown): string | undefined {
  return errorField(error, "constraint");
}

export function redactConnectionStrings(text: string): string {
  return text.replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, "[redacted]");
}
