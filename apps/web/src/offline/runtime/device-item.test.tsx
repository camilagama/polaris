import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DeviceItem } from "./device-item";
import { deviceRows } from "./devices-model";

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
        actionError={null}
        busy={false}
        confirming={false}
        endOtherSessions={false}
        offline={false}
        onAsk={vi.fn()}
        onCancel={vi.fn()}
        onChoose={vi.fn()}
        online={true}
        onRevoke={vi.fn()}
        row={row()}
        sessionGone={false}
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

  it("the confirmation has the short red title, the two sentences, and the error right above the buttons", () => {
    const html = render({
      actionError: "Não conseguimos confirmar se o aparelho foi revogado.",
      confirming: true,
    });
    expect(html).toContain("Revogar este aparelho?");
    expect(html).toContain("Não dá para desfazer.");
    expect(html).toContain("Use para aparelho perdido ou roubado.");
    const alert = html.indexOf('role="alert"');
    expect(alert).toBeGreaterThan(html.indexOf("Use para aparelho perdido"));
    expect(alert).toBeLessThan(html.indexOf("Sim, revogar este aparelho"));
    expect(render({ confirming: true })).not.toContain('role="alert"');
  });

  it("the confirm button says Revogando… during the call", () => {
    const html = render({ busy: true, confirming: true });
    expect(html).toContain(">Revogando…<");
    expect(html).not.toContain(">Sim, revogar este aparelho<");
  });

  it("says where Sair is: in the Menu on a phone, or at the top of the page on a big screen", () => {
    const html = render({ row: row({ isCurrent: true }) });
    expect(html).toContain("use o botão <strong>Sair</strong>");
    expect(html).toContain("no celular ele está no Menu");
    expect(html).toContain("em tela grande, no alto da página");
  });

  it("this device, without a connection: says Sair will not take it off the list until it leaves online", () => {
    const html = render({ online: false, row: row({ isCurrent: true }) });
    expect(html).toContain(
      "Sem conexão, Sair não tira este aparelho da lista; ele sai quando você sair com internet, ou pode ser revogado de outro aparelho."
    );
    expect(html).not.toContain("Para tirar este aparelho");
    const connected = render({ online: true, row: row({ isCurrent: true }) });
    expect(connected).toContain("Para tirar este aparelho, use o botão");
    expect(connected).not.toContain("Sem conexão");
  });

  it("this device, session over: no promise about Sair, the panel above already says it", () => {
    const html = render({
      row: row({ isCurrent: true }),
      sessionGone: true,
    });
    expect(html).toContain("Este aparelho");
    expect(html).not.toContain("Sair");
  });
});

describe("the name of a device on the devices screen", () => {
  const hostile = '<img src=x onerror="alert(1)">Chrome no Android';
  const rowFor = (label: string | null, current: boolean) => {
    const [first] = deviceRows(
      [
        {
          createdAt: "2026-10-01T12:00:00.000Z",
          id: "0199c2d0-0000-7000-8000-0000000000d1",
          label,
          lastSeenAt: "2026-10-14T10:00:00.000Z",
          revokedAt: null,
        },
      ],
      current ? "0199c2d0-0000-7000-8000-0000000000d1" : null
    );
    if (!first) {
      throw new Error("no row");
    }
    return first;
  };

  it.each([
    ["this device", true],
    ["another device, with its confirmation open", false],
  ])("is rendered as text, never as HTML (%s)", (_name, current) => {
    const html = render({
      confirming: !current,
      row: rowFor(hostile, current),
    });
    expect(html).not.toContain("<img");
    expect(html).not.toContain('onerror="');
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("shows the default name as given, and a device with none as 'Aparelho sem nome'", () => {
    expect(render({ row: rowFor("Chrome no Android", true) })).toContain(
      "Chrome no Android"
    );
    expect(render({ row: rowFor(null, true) })).toContain("Aparelho sem nome");
  });
});
