import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NO_PENDING_WORK } from "../pwa/update-model";
import type { UpdateSnapshot } from "../pwa/update-store";
import { AppVersionLineView, versionText } from "./app-version-line";

const CURRENT = {
  activatedAt: Date.parse("2026-10-28T13:00:00.000Z"),
  id: "a1b2c3d4e5f6",
  // 01:30 of the 28th in UTC is still the 27th in São Paulo: the version is named after the São Paulo day
  publishedAt: Date.parse("2026-10-28T01:30:00.000Z"),
  seenAt: null,
  urgent: false,
  workerId: null,
};

const WITH_UPDATED =
  /^Versão 2026\.10\.27 22:30 \(a1b2c3\) · atualizado em \d{2}\/\d{2}$/;
const BY_ID = /^Versão a1b2c3d4e5f6/;

const snapshot = (change: Partial<UpdateSnapshot> = {}): UpdateSnapshot => ({
  current: CURRENT,
  pending: null,
  swapping: false,
  work: NO_PENDING_WORK,
  ...change,
});
const WAITING = {
  build: null,
  firstSeenAt: 0,
  kind: "waiting",
  urgent: false,
} as const;
const render = (value: UpdateSnapshot) =>
  renderToStaticMarkup(<AppVersionLineView snapshot={value} />);

describe("a linha da versão em Configurações", () => {
  it("diz a versão pelo dia e pela hora da publicação em São Paulo, o começo do id e quando ela entrou neste aparelho", () => {
    expect(versionText(CURRENT)).toMatch(WITH_UPDATED);
    expect(versionText({ ...CURRENT, activatedAt: null })).toBe(
      "Versão 2026.10.27 22:30 (a1b2c3)"
    );
    // a build without a time is named by its id
    expect(versionText({ ...CURRENT, publishedAt: null })).toMatch(BY_ID);
    expect(versionText(null)).toBeNull();
  });

  it("sem build nova, só a versão; sem botão nem link", () => {
    const html = render(snapshot());
    expect(html).toContain("Versão 2026.10.27 22:30 (a1b2c3)");
    expect(html).not.toContain("Nova versão");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<a ");
  });

  it("com build nova esperando, diz que ela entra sozinha quando o app fechar ou ficar parado", () => {
    const html = render(snapshot({ pending: WAITING }));
    expect(html).toContain(
      "Nova versão pronta. Entra sozinha quando você fechar o app ou deixá-lo parado um tempo."
    );
    expect(html).not.toContain("Ver pendências");
    expect(html).not.toContain("<button");
  });

  it("com registro recusado, a espera é pelas pendências, com o link Ver pendências", () => {
    const html = render(
      snapshot({ pending: WAITING, work: { ...NO_PENDING_WORK, rejected: 2 } })
    );
    expect(html).toContain(
      "Nova versão pronta. Entra depois que as pendências forem resolvidas."
    );
    expect(html).toContain('href="/attention"');
    expect(html).toContain("Ver pendências");
    expect(html).not.toContain("Entra sozinha");
  });

  it("sem service worker e sem build esperando, nada", () => {
    expect(render(snapshot({ current: null }))).toBe("");
  });
});
