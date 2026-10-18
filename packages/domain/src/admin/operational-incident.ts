/**
 * What an operator may ask of an operational incident (plan PR111, ADR 0085): to send one dead event
 * again, with a reason. The reason is typed by a person; it is checked on the call and not written to the
 * administrative audit (immutable, so free text must not get in, ADR 0081), and it is short, has no control or invisible formatting character (a line break, a
 * direction override) and says nothing about a tenant's data (the form of the field cannot enforce that
 * last part; the runbook says it). The database repeats the check with the same explicit list, not the
 * locale's idea of a control character.
 */

export const INCIDENT_RETRY_REASON_MAX_LENGTH = 150;

export class InvalidIncidentRetryError extends Error {
  readonly code = "invalid_incident_reason";

  constructor() {
    super("invalid_incident_reason");
    this.name = "InvalidIncidentRetryError";
  }
}

/** C0 and C1 controls, zero-width and direction marks, line and paragraph separators, direction overrides and isolates, the byte order mark. */
function hasUnsafeCharacter(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (
      code < 32 ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x20_0b && code <= 0x20_0f) ||
      (code >= 0x20_28 && code <= 0x20_2e) ||
      (code >= 0x20_66 && code <= 0x20_69) ||
      code === 0xfe_ff
    ) {
      return true;
    }
  }
  return false;
}

/** The reason of a retry, trimmed; refused when it is missing, too long or has a control character. */
export function normalizeIncidentRetryReason(reason: unknown): string {
  const text = typeof reason === "string" ? reason.trim() : "";
  if (
    text === "" ||
    [...text].length > INCIDENT_RETRY_REASON_MAX_LENGTH ||
    hasUnsafeCharacter(text)
  ) {
    throw new InvalidIncidentRetryError();
  }
  return text;
}
