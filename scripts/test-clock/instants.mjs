const WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export const INSTANTES = [
  {
    chave: "dia-1-0030",
    now: "2026-11-01T03:30:00Z",
    saoPaulo: "2026-11-01 00:30",
  },
  {
    chave: "ultimo-dia-2350",
    now: "2026-12-01T02:50:00Z",
    saoPaulo: "2026-11-30 23:50",
  },
  {
    chave: "virada-do-ano",
    now: "2027-01-01T02:50:00Z",
    saoPaulo: "2026-12-31 23:50",
  },
  {
    chave: "bissexto-1200",
    now: "2028-02-29T15:00:00Z",
    saoPaulo: "2028-02-29 12:00",
  },
];

export const FUSOS = ["America/Sao_Paulo", "UTC"];

function isCalendarDay(year, month, day) {
  const check = new Date(Date.UTC(year, month - 1, day));
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day
  );
}

export function parseNow(raw) {
  const match = WITH_OFFSET.exec(raw);
  const instant = new Date(raw);
  // Date rolls 02-30 over to 03-01 and 24:00 to the next day instead of failing, which would run the sweep at another instant.
  const valid =
    match !== null &&
    !Number.isNaN(instant.getTime()) &&
    isCalendarDay(Number(match[1]), Number(match[2]), Number(match[3])) &&
    Number(match[4]) < 24 &&
    Number(match[5]) < 60;
  if (!valid) {
    throw new Error(
      `POLARIS_TEST_NOW inválido: "${raw}". Use ISO 8601 com Z ou ±hh:mm, por exemplo 2026-11-01T03:30:00Z (sem o fuso, a data seria lida no fuso do processo).`
    );
  }
  return instant;
}
