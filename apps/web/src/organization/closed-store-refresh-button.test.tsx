import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { refreshButtonProps } from "./closed-refresh-notice";
import type { ClosedStore } from "./closed-store-model";
import { PanelBody, StatusCard } from "./closed-store-page";

vi.mock("../lib/orpc", () => ({ orpcClient: {} }));

const NATIVE_DISABLED = / disabled[ =>]/;
const NOW = Date.parse("2026-10-30T12:00:00.000Z");
const STORE: ClosedStore = {
  canRecover: true,
  deletableFrom: "2027-01-18T03:00:00.000Z",
  deletionDate: "2027-01-18",
  exportOpenUntil: "2027-01-18T03:00:00.000Z",
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja de Teste",
  phase: "closing",
  recoverUntil: "2026-11-19T12:00:00.000Z",
  renewal: "not_handled",
  requestedAt: "2026-10-20T12:00:00.000Z",
  timezone: "America/Sao_Paulo",
};
const noop = () => undefined;

const card = (reading: boolean, online = true) =>
  renderToStaticMarkup(
    <StatusCard
      now={NOW}
      online={online}
      onRefresh={noop}
      onUndo={noop}
      reading={reading}
      store={STORE}
    />
  );

const refreshButton = (html: string, name: string) =>
  html.match(new RegExp(`<button[^>]*>${name}</button>`))?.[0] ?? "";

describe("Atualizar of the status card", () => {
  it("is enabled while no read is on its way", () => {
    const button = refreshButton(card(false), "Atualizar");
    expect(button).not.toBe("");
    expect(button).not.toContain(" aria-disabled=");
    expect(card(false)).not.toContain("Atualizando…");
  });

  it("says Atualizando… on a button locked with aria-disabled, not disabled, while the read is on its way", () => {
    const html = card(true);
    const button = refreshButton(html, "Atualizando…");
    expect(button).toContain('aria-disabled="true"');
    expect(button).not.toMatch(NATIVE_DISABLED);
    expect(refreshButton(html, "Atualizar")).toBe("");
  });

  it("keeps the offline lock and the same text offline", () => {
    const button = refreshButton(card(false, false), "Atualizar");
    expect(button).toContain('aria-disabled="true"');
    expect(button).toContain("closed-store-offline");
    expect(card(false, false)).not.toContain("Atualizando…");
  });

  it("keeps the lock and the reason when offline while a read is on its way", () => {
    const button = refreshButton(card(true, false), "Atualizando…");
    expect(button).toContain('aria-disabled="true"');
    expect(button).toContain("closed-store-offline");
  });
});

describe("the props of the refresh buttons: one request per touch", () => {
  it("fires the read on a touch while idle", () => {
    const onRefresh = vi.fn();
    refreshButtonProps(true, false, onRefresh).onClick?.();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("fires nothing on a touch while the read is on its way", () => {
    const onRefresh = vi.fn();
    const props = refreshButtonProps(true, true, onRefresh);
    expect(props.onClick).toBeUndefined();
    expect(props["aria-disabled"]).toBe(true);
  });
});

describe("the card and the notice share the read state", () => {
  const body = (reading: boolean) =>
    renderToStaticMarkup(
      <PanelBody
        justClosed={false}
        load={{ refreshFailed: true, status: "loaded", stores: [STORE] }}
        online
        onRefresh={noop}
        reading={reading}
      />
    );

  it("shows Tentar de novo, enabled, while idle", () => {
    const html = body(false);
    expect(refreshButton(html, "Tentar de novo")).not.toBe("");
    expect(html).not.toContain("Atualizando…");
  });

  it("shows Atualizando… on both while the read is on its way", () => {
    const html = body(true);
    expect(html.match(/Atualizando…/g)).toHaveLength(2);
    expect(html.match(/aria-disabled="true"/g)).toHaveLength(2);
    expect(refreshButton(html, "Tentar de novo")).toBe("");
  });
});
