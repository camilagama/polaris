import { describe, expect, it } from "vitest";
import {
  ALREADY_RUNNING_TEXT,
  type DataExportItem,
  DEFAULT_EXPORT_FORMATS,
  EXPIRED_TEXT,
  EXPORT_FORMAT_OPTIONS,
  EXPORT_SUPPORT_TEXT,
  exportFileHref,
  exportView,
  FAILED_TEXT,
  formatFileSize,
  formatsProblem,
  LIMIT_REACHED_TEXT,
  listRefusal,
  NO_EXPORT_PERMISSION_TEXT,
  NO_FORMAT_TEXT,
  orderedFormats,
  PREPARING_TEXT,
  REQUEST_DONE_TEXT,
  REQUEST_FAILED_TEXT,
  REQUEST_UNCONFIRMED_TEXT,
  requestRefusal,
  TOO_LARGE_TEXT,
} from "./data-export-model";

const ZONE = "America/Sao_Paulo";
const TECHNICAL_WORDS =
  /export_|_error|storage_failed|\b(requested|running|failed|expired)\b/;
/** `2026-10-30T12:00` in São Paulo. */
const NOW = Date.parse("2026-10-30T15:00:00.000Z");

function item(overrides: Partial<DataExportItem> = {}): DataExportItem {
  return {
    errorCode: null,
    expiresAt: null,
    files: [],
    formats: ["json", "csv"],
    id: "0199c2d0-0000-7000-8000-0000000000aa",
    requestedAt: "2026-10-30T14:10:00.000Z",
    status: "requested",
    ...overrides,
  };
}

const READY = item({
  expiresAt: "2026-10-31T14:40:00.000Z",
  files: [
    {
      name: "polaris-imagens-2026-10-30-1.zip",
      ordinal: 2,
      sizeBytes: 31_500_000,
    },
    { name: "dados.json", ordinal: 1, sizeBytes: 820_400 },
  ],
  status: "ready",
});

const rpcError = (code: string, status: number, reason?: string) =>
  Object.assign(new Error(code), {
    code,
    data: reason === undefined ? undefined : { reason },
    status,
  });

describe("the form of Pedir cópia", () => {
  it("offers the three formats with JSON and the spreadsheet marked by default", () => {
    expect(EXPORT_FORMAT_OPTIONS.map((option) => option.label)).toEqual([
      "Dados em JSON",
      "Dados em planilha (CSV)",
      "Imagens dos produtos",
    ]);
    expect(DEFAULT_EXPORT_FORMATS).toEqual(["json", "csv"]);
  });

  it("asks for at least one format before anything leaves", () => {
    expect(formatsProblem([])).toBe(NO_FORMAT_TEXT);
    expect(NO_FORMAT_TEXT).toBe("Marque pelo menos um formato.");
    expect(formatsProblem(["images"])).toBeNull();
  });

  it("sends the formats in the contract's order, each once", () => {
    expect(orderedFormats(["images", "json", "images"])).toEqual([
      "json",
      "images",
    ]);
  });

  it("says the copy takes up to an hour, stays for 24 hours and holds the customers' personal data (AC-8)", () => {
    expect(EXPORT_SUPPORT_TEXT).toContain("até uma hora");
    expect(EXPORT_SUPPORT_TEXT).toContain("24 horas");
    expect(EXPORT_SUPPORT_TEXT).toContain("dados pessoais dos seus clientes");
  });
});

describe("each state of a copy (AC-3)", () => {
  it("requested and running read as preparing, with the wait and no file", () => {
    for (const status of ["requested", "running"] as const) {
      const view = exportView(item({ status }), NOW, ZONE);
      expect(view.kind).toBe("preparing");
      expect(view.text).toBe(PREPARING_TEXT);
      expect(view.text).toContain(
        "Pode levar até uma hora. Você pode sair e voltar."
      );
      expect(view.files).toEqual([]);
    }
  });

  it("names the formats of a copy in short, the long labels staying on the request", () => {
    const cases: [DataExportItem["formats"], string][] = [
      [["json"], "JSON"],
      [["csv"], "planilha"],
      [["images"], "imagens"],
      [["json", "csv"], "JSON e planilha"],
      [["images", "json"], "JSON e imagens"],
      [["csv", "images"], "planilha e imagens"],
      [["images", "csv", "json"], "JSON, planilha e imagens"],
    ];
    for (const [formats, expected] of cases) {
      expect(exportView(item({ formats }), NOW, ZONE).formats).toBe(expected);
    }
  });

  it("says a failed copy has to be asked for again", () => {
    expect(FAILED_TEXT).toBe(
      "Não foi possível preparar a cópia. Peça de novo."
    );
  });

  it("confirms the request with what happens next", () => {
    expect(REQUEST_DONE_TEXT).toBe(
      "Cópia pedida. Preparando: pode levar até uma hora. Você pode sair e voltar."
    );
  });

  it("ready: the deadline in the store's time and one download per file, in order, with its size", () => {
    const view = exportView(READY, NOW, ZONE);
    expect(view.kind).toBe("ready");
    expect(view.text).toBe(
      "Sua cópia está pronta. Baixe até 31/10/2026 11:40."
    );
    expect(view.files).toEqual([
      { label: "Baixar dados.json (820 KB)", ordinal: 1 },
      {
        label: "Baixar polaris-imagens-2026-10-30-1.zip (31,5 MB)",
        ordinal: 2,
      },
    ]);
    expect(view.requested).toBe("Pedida em 30/10/2026 11:10");
    expect(view.formats).toBe("JSON e planilha");
  });

  it("never says ready past the deadline or without files: the download would be refused", () => {
    const late = exportView(
      READY,
      Date.parse("2026-10-31T14:40:00.000Z"),
      ZONE
    );
    expect(late.kind).toBe("expired");
    expect(late.files).toEqual([]);
    expect(exportView({ ...READY, files: [] }, NOW, ZONE).kind).toBe("expired");
    expect(exportView({ ...READY, expiresAt: null }, NOW, ZONE).kind).toBe(
      "expired"
    );
  });

  it("expired", () => {
    const view = exportView(item({ status: "expired" }), NOW, ZONE);
    expect(view).toMatchObject({
      files: [],
      kind: "expired",
      text: EXPIRED_TEXT,
    });
  });

  it("failed, without the error code", () => {
    const view = exportView(
      item({ errorCode: "internal_error", status: "failed" }),
      NOW,
      ZONE
    );
    expect(view).toMatchObject({
      files: [],
      kind: "failed",
      text: FAILED_TEXT,
    });
  });

  it("too large with images suggests only the data; without images it is a plain failure", () => {
    const withImages = exportView(
      item({
        errorCode: "export_too_large",
        formats: ["json", "images"],
        status: "failed",
      }),
      NOW,
      ZONE
    );
    expect(withImages).toMatchObject({
      kind: "too_large",
      text: TOO_LARGE_TEXT,
    });
    expect(TOO_LARGE_TEXT).toContain("Peça só os dados (JSON ou planilha)");
    const dataOnly = exportView(
      item({ errorCode: "export_too_large", status: "failed" }),
      NOW,
      ZONE
    );
    expect(dataOnly.kind).toBe("failed");
  });

  it("no text of any state says pronta unless the copy is ready, nor shows a code", () => {
    const states: DataExportItem[] = [
      item({ status: "requested" }),
      item({ status: "running" }),
      item({ status: "expired" }),
      item({
        errorCode: "export_too_large",
        formats: ["images"],
        status: "failed",
      }),
      item({ errorCode: "storage_failed", status: "failed" }),
      READY,
    ];
    for (const state of states) {
      const view = exportView(state, NOW, ZONE);
      const text = [
        view.text,
        view.requested,
        view.formats,
        ...view.files.map((file) => file.label),
      ].join(" ");
      expect(text.includes("pronta")).toBe(state.status === "ready");
      expect(text).not.toMatch(TECHNICAL_WORDS);
    }
  });
});

describe("the download (AC-4)", () => {
  it("is a link to the route that streams the file, with the store as context", () => {
    expect(
      exportFileHref(
        "0199c2d0-0000-7000-8000-0000000000aa",
        2,
        "0199c2d0-0000-7000-8000-00000000a001"
      )
    ).toBe(
      "/api/data-exports/0199c2d0-0000-7000-8000-0000000000aa/files/2?organizationId=0199c2d0-0000-7000-8000-00000000a001"
    );
  });

  it("writes sizes in KB under a megabyte and in MB with a comma above", () => {
    expect(formatFileSize(300)).toBe("1 KB");
    expect(formatFileSize(820_400)).toBe("820 KB");
    expect(formatFileSize(16_777_216)).toBe("16,8 MB");
  });
});

describe("a refused or unanswered request", () => {
  it("the Worker's 503 server_busy says it may have been made and asks for Atualizar", () => {
    const refusal = requestRefusal(
      rpcError("SERVICE_UNAVAILABLE", 503, "server_busy")
    );
    expect(refusal).toEqual({
      text: REQUEST_UNCONFIRMED_TEXT,
      repeatsNow: false,
    });
    expect(REQUEST_UNCONFIRMED_TEXT).toBe(
      "O pedido não foi confirmado. Pode ter sido feito: toque em Atualizar antes de repetir."
    );
    expect(requestRefusal(rpcError("SERVICE_UNAVAILABLE", 503)).text).toBe(
      REQUEST_UNCONFIRMED_TEXT
    );
  });

  it("no answer and the cut of the platform are the same doubt", () => {
    expect(requestRefusal(new TypeError("Failed to fetch")).text).toBe(
      REQUEST_UNCONFIRMED_TEXT
    );
    expect(
      requestRefusal(rpcError("INTERNAL_SERVER_ERROR", 503, "platform_cut"))
        .text
    ).toBe(REQUEST_UNCONFIRMED_TEXT);
    expect(
      requestRefusal(rpcError("INTERNAL_SERVER_ERROR", 500, "internal_error"))
        .text
    ).toBe(REQUEST_UNCONFIRMED_TEXT);
  });

  it("the limit of 3 a day and the copy already in preparation have their own text", () => {
    expect(
      requestRefusal(rpcError("CONFLICT", 409, "export_limit_reached"))
    ).toEqual({
      text: LIMIT_REACHED_TEXT,
      repeatsNow: true,
    });
    expect(LIMIT_REACHED_TEXT).toContain("3 cópias nas últimas 24 horas");
    expect(
      requestRefusal(rpcError("CONFLICT", 409, "export_already_running"))
    ).toEqual({ text: ALREADY_RUNNING_TEXT, repeatsNow: true });
    expect(ALREADY_RUNNING_TEXT).toContain("Já há uma cópia sendo preparada");
  });

  it("FORBIDDEN is the owner's text, and the legal acceptance is not a lack of permission", () => {
    expect(
      requestRefusal(rpcError("FORBIDDEN", 403, "capability_denied")).text
    ).toBe(NO_EXPORT_PERMISSION_TEXT);
    expect(
      requestRefusal(rpcError("FORBIDDEN", 403, "legal_acceptance_required"))
        .text
    ).toContain("Termos de Uso");
    expect(listRefusal(rpcError("FORBIDDEN", 403))).toBe(
      NO_EXPORT_PERMISSION_TEXT
    );
  });

  it("anything else is a plain failure, with no code", () => {
    const { text } = requestRefusal(
      rpcError("BAD_REQUEST", 400, "invalid_export_request")
    );
    expect(text).toBe(REQUEST_FAILED_TEXT);
    expect(text).not.toContain("invalid");
  });
});
