import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StaticOrganizationProvider } from "../lib/current-organization";
import { DataExportList } from "./data-export-list";
import type { DataExportItem } from "./data-export-model";
import { exportFileHref } from "./data-export-model";
import { DataExportPage } from "./data-export-page";

// the client of the server reads `window` when it loads: a static render runs no effect, so nothing is called
vi.mock("../lib/orpc", () => ({ orpcClient: {} }));

const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  timezone: "America/Sao_Paulo",
};
const NOW = Date.parse("2026-10-30T15:00:00.000Z");
const CONTROL = /<(button|a|form|input|select)[\s>]/;
const OFFLINE_LINK =
  /<a [^>]*aria-describedby="connection-required-text"[^>]*aria-disabled="true"|<a [^>]*aria-disabled="true"[^>]*aria-describedby="connection-required-text"/;
const OFFLINE_REFRESH = /<button[^>]*aria-disabled="true"[^>]*>Atualizar/;
const DOWNLOAD_LINK = /<a [^>]*href="\/api\/data-exports\/[^"]+"[^>]*>Baixar /g;

const READY: DataExportItem = {
  errorCode: null,
  expiresAt: "2026-10-31T14:40:00.000Z",
  files: [{ name: "dados.json", ordinal: 1, sizeBytes: 820_400 }],
  formats: ["json"],
  id: "0199c2d0-0000-7000-8000-0000000000aa",
  requestedAt: "2026-10-30T14:10:00.000Z",
  status: "ready",
};

function pageOf(role: string) {
  return renderToStaticMarkup(
    <StaticOrganizationProvider
      billingSelfService={false}
      organization={{ ...ORGANIZATION, role }}
    >
      <DataExportPage />
    </StaticOrganizationProvider>
  );
}

const fileHref = (id: string, ordinal: number) =>
  exportFileHref(id, ordinal, ORGANIZATION.id);
const ignore = () => undefined;

function listOf(exports: DataExportItem[] | null, online = true) {
  return renderToStaticMarkup(
    <DataExportList
      exports={exports}
      fileHref={fileHref}
      loadError={null}
      now={NOW}
      online={online}
      onRefresh={ignore}
      refreshing={false}
      timeZone={ORGANIZATION.timezone}
    />
  );
}

describe("Seus dados without organization:export (AC-1)", () => {
  it("says only that the owner can ask for and download the copy, with no button, link or form", () => {
    const html = pageOf("staff");
    expect(html).toContain(
      "Só o dono da loja pode pedir e baixar a cópia dos dados."
    );
    expect(html).not.toMatch(CONTROL);
    expect(html).not.toContain("Pedir cópia dos dados");
  });
});

describe("Seus dados for the owner", () => {
  it("draws the support text, the formats with JSON and the spreadsheet marked, and the button (AC-2, AC-8)", () => {
    const html = pageOf("owner");
    expect(html).toContain("Seus dados");
    expect(html).toContain("Pedir cópia");
    expect(html).toContain(
      "A cópia leva até uma hora para ficar pronta e fica disponível por 24 horas. Ela tem dados pessoais dos seus clientes: guarde com cuidado."
    );
    // the checkbox's own input carries the id, and `checked` when it is marked
    const inputOf = (value: string) =>
      html.match(
        new RegExp(`<input id="data-export-format-${value}"[^>]*>`)
      )?.[0];
    expect(inputOf("json")).toContain('checked=""');
    expect(inputOf("csv")).toContain('checked=""');
    expect(inputOf("images")).toBeDefined();
    expect(inputOf("images")).not.toContain('checked=""');
    expect(html).toContain("Pedir cópia dos dados");
    expect(html).toContain("Suas cópias");
    expect(html).toContain("Atualizar");
  });
});

describe("the list of copies", () => {
  it("links each file to the route that streams it, never to a file read by the screen (AC-4)", () => {
    const html = listOf([READY]);
    const links = html.match(DOWNLOAD_LINK) ?? [];
    expect(links).toHaveLength(1);
    expect(html).toContain(
      `href="/api/data-exports/${READY.id}/files/1?organizationId=${ORGANIZATION.id}"`
    );
    expect(html).toContain("Baixar dados.json (820 KB)");
    expect(html).not.toContain("blob:");
    expect(html).not.toContain("download=");
  });

  it("offline, the links and Atualizar are off and say why (AC-7)", () => {
    const html = listOf([READY], false);
    expect(html).toMatch(OFFLINE_LINK);
    expect(html).toMatch(OFFLINE_REFRESH);
    const online = listOf([READY]);
    expect(online).not.toContain('aria-disabled="true"');
  });

  it("says nothing was asked yet when the list is empty, and nothing before the first read", () => {
    expect(listOf([])).toContain("Nenhuma cópia pedida ainda.");
    expect(listOf(null)).not.toContain("Nenhuma cópia pedida ainda.");
  });

  it("marks each entry with its state, in words and not only by color (AC-9)", () => {
    const html = listOf([
      { ...READY, files: [], id: "a", status: "running" },
      { ...READY, files: [], id: "b", status: "expired" },
      READY,
    ]);
    expect(html).toContain('data-export-state="preparing"');
    expect(html).toContain('data-export-state="expired"');
    expect(html).toContain('data-export-state="ready"');
    expect(html).toContain("Preparando sua cópia.");
    expect(html).toContain("Esta cópia expirou. Peça outra.");
    expect(html).toContain(
      "Sua cópia está pronta. Baixe até 31/10/2026 11:40."
    );
  });
});
