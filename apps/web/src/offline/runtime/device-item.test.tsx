import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DeviceItem } from "./device-item";

const LABELLED_FIELD =
  /<label class="device-check"><input[^>]*type="checkbox"[^>]*\/><span>Encerrar também as outras sessões<\/span><\/label>/;
const row = (
  overrides: Partial<Parameters<typeof DeviceItem>[0]["row"]> = {}
) => ({
  id: "0199c2d0-0000-7000-8000-000000000002",
  isCurrent: false,
  labelText: "Celular da Ana",
  lastSeenText: "13/10/2026, 07:00",
  registeredText: "01/10/2026, 09:00",
  ...overrides,
});

function render(props: Partial<Parameters<typeof DeviceItem>[0]> = {}): string {
  return renderToStaticMarkup(
    <ul>
      <DeviceItem
        busy={false}
        confirming={false}
        endOtherSessions={false}
        offline={false}
        onAsk={vi.fn()}
        onCancel={vi.fn()}
        onChoose={vi.fn()}
        onRevoke={vi.fn()}
        row={row()}
        {...props}
      />
    </ul>
  );
}

describe("a device row", () => {
  it("has no option outside the confirmation, only the Revogar button", () => {
    const html = render();
    expect(html).not.toContain('type="checkbox"');
    expect(html).toContain("Revogar o aparelho Celular da Ana");
  });

  it("offers the option, unticked, with a label tied to the field and the help text, only while confirming", () => {
    const html = render({ confirming: true });
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain("checked");
    // the whole line is the label: it wraps the field and the text
    expect(html).toMatch(LABELLED_FIELD);
    expect(html).toContain("aria-describedby=");
    expect(html).toContain(
      "todos os outros celulares e computadores, menos neste"
    );
    expect(html).toContain("Sim, revogar este aparelho");
    expect(html).not.toContain("será desconectado agora");
    expect(html).not.toContain("Revogar o aparelho Celular da Ana");
  });

  it("ticked: shows the extra warning and changes the confirm button, which goes back when unticked", () => {
    const ticked = render({ confirming: true, endOtherSessions: true });
    expect(ticked).toContain("será desconectado agora");
    expect(ticked).toContain("Sim, revogar e encerrar as outras sessões");
    expect(ticked).not.toContain(">Sim, revogar este aparelho<");
    const unticked = render({ confirming: true, endOtherSessions: false });
    expect(unticked).toContain(">Sim, revogar este aparelho<");
    expect(unticked).not.toContain("será desconectado agora");
  });

  it("never says before the answer that this browser leaves", () => {
    expect(
      render({ confirming: true, endOtherSessions: true }).toLowerCase()
    ).not.toContain("navegador");
  });

  it("this device has neither the button nor the option: it leaves through Sair", () => {
    for (const confirming of [false, true]) {
      const html = render({ confirming, row: row({ isCurrent: true }) });
      expect(html).not.toContain('type="checkbox"');
      expect(html).not.toContain("Revogar o aparelho");
      expect(html).toContain("<strong>Sair</strong>");
    }
  });

  it("offline: the button, the option and the confirm are disabled", () => {
    const html = render({ confirming: true, offline: true });
    const disabled = html.match(/disabled=""/g) ?? [];
    // checkbox + confirm; Cancelar stays available
    expect(disabled).toHaveLength(2);
    expect(render({ offline: true })).toContain('disabled=""');
  });
});
