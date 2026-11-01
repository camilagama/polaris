const WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

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

export function parseNow(raw) {
  const instant = new Date(raw);
  if (!WITH_OFFSET.test(raw) || Number.isNaN(instant.getTime())) {
    throw new Error(
      `POLARIS_TEST_NOW inválido: "${raw}". Use ISO 8601 com Z ou ±hh:mm, por exemplo 2026-11-01T03:30:00Z (sem o fuso, a data seria lida no fuso do processo).`
    );
  }
  return instant;
}
