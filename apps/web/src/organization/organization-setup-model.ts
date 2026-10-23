import {
  legalAcceptanceMessage,
  rpcErrorCode,
  rpcErrorReason,
} from "../lib/rpc-error";

export const MAX_ORGANIZATION_NAME_LENGTH = 128;
export const MAX_TIMEZONE_LENGTH = 64;

export interface SetupDraft {
  name: string;
  timezone: string;
}

export interface SetupErrors {
  name?: string;
  timezone?: string;
}

export const BRASILIA_TIMEZONE = "America/Sao_Paulo";

/** The zones of Brazil, by the name a person knows them (the Select of the first access). Brasília comes first. */
export const BRAZIL_TIMEZONES: ReadonlyArray<{ id: string; label: string }> = [
  { id: BRASILIA_TIMEZONE, label: "Horário de Brasília (São Paulo)" },
  { id: "America/Manaus", label: "Horário de Manaus" },
  { id: "America/Cuiaba", label: "Horário de Cuiabá" },
  { id: "America/Rio_Branco", label: "Horário do Acre (Rio Branco)" },
  { id: "America/Noronha", label: "Horário de Fernando de Noronha" },
];

/** The device's IANA zone, the usual answer for the organization's zone. */
export function defaultTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || BRASILIA_TIMEZONE;
}

/** Brasília unless the device is in another zone of Brazil: the list has no other place to go. */
export function initialTimezone(device: string = defaultTimezone()): string {
  return BRAZIL_TIMEZONES.some((zone) => zone.id === device)
    ? device
    : BRASILIA_TIMEZONE;
}

export const SETUP_SESSION_ENDED = "Sua sessão acabou. Entre de novo.";

/** The server answered that the session is over: the screen says so and offers "Entrar de novo". */
export function setupSessionEnded(error: unknown): boolean {
  return rpcErrorCode(error) === "UNAUTHORIZED";
}

export function isValidTimezone(timezone: string): boolean {
  try {
    return (
      new Intl.DateTimeFormat("pt-BR", { timeZone: timezone }).resolvedOptions()
        .timeZone !== ""
    );
  } catch {
    return false;
  }
}

/** The first field with an error is the one to focus. */
const SETUP_FIELD_ORDER: ReadonlyArray<keyof SetupErrors> = [
  "name",
  "timezone",
];

export function validateSetup(draft: SetupDraft): {
  errors: SetupErrors;
  input: { name: string; timezone: string } | null;
} {
  const name = draft.name.trim();
  const timezone = draft.timezone.trim();
  const errors: SetupErrors = {};
  if (name === "") {
    errors.name = "Informe o nome da organização.";
  } else if ([...name].length > MAX_ORGANIZATION_NAME_LENGTH) {
    errors.name = `Use no máximo ${MAX_ORGANIZATION_NAME_LENGTH} caracteres.`;
  }
  if (timezone === "") {
    errors.timezone = "Informe o fuso horário.";
  } else if (timezone.length > MAX_TIMEZONE_LENGTH) {
    errors.timezone = `Use no máximo ${MAX_TIMEZONE_LENGTH} caracteres.`;
  } else if (!isValidTimezone(timezone)) {
    errors.timezone =
      "Fuso horário desconhecido. Use um identificador IANA, como America/Sao_Paulo.";
  }
  return {
    errors,
    input: errors.name || errors.timezone ? null : { name, timezone },
  };
}

export function firstInvalidField(
  errors: SetupErrors
): keyof SetupErrors | null {
  return SETUP_FIELD_ORDER.find((field) => errors[field] !== undefined) ?? null;
}

/** Opening an organization is idempotent, so any failure can be retried. */
export function setupErrorMessage(error: unknown): string {
  const unaccepted = legalAcceptanceMessage(error);
  if (unaccepted !== undefined) {
    return unaccepted;
  }
  const code = rpcErrorCode(error);
  const reason = rpcErrorReason(error);
  if (code === "UNAUTHORIZED") {
    return "A organização não foi aberta.";
  }
  if (code === "FORBIDDEN") {
    return "Verifique seu email antes de criar ou abrir uma organização.";
  }
  if (code === "BAD_REQUEST") {
    return "O nome ou o fuso horário foram recusados. Revise os campos.";
  }
  if (code === "CONFLICT" || reason === "multiple_existing_organizations") {
    return "Sua conta já tem uma organização que não pôde ser aberta automaticamente. Fale com o suporte.";
  }
  if (code === "SERVICE_UNAVAILABLE") {
    return "O Polaris está temporariamente indisponível. Tente novamente.";
  }
  return "Não foi possível criar ou abrir a organização. Tente novamente.";
}
