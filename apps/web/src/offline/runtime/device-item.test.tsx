import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DeviceItem, RevokeForm } from "./device-item";
import { deviceRows } from "./devices-model";

const LABEL_FOR_CHECKBOX =
  /<label [^>]*data-slot="field-label" for="[^"]*-end-others">Encerrar também as outras sessões<\/label>/;
/** The opening tag of the button that says `label`. */
function buttonTag(html: string, label: string): string {
  const end = html.indexOf(`>${label}<`);
  return html.slice(html.lastIndexOf("<button", end), end);
}

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

  it("shows the confirmation only in the dialog: the row itself offers the button and nothing else", () => {
    // a dialog draws into a portal, after the page mounts: the static markup is the row as it waits
    const html = render({ confirming: true });
    expect(html).not.toContain('type="checkbox"');
    expect(html).toContain("Revogar o aparelho Celular da Ana");
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

  it("offline: the button is off but reachable, and reads the line that says why", () => {
    const html = render({ offline: true, reasonId: "devices-offline" });
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('aria-describedby="devices-offline"');
    expect(html).not.toContain('disabled=""');
    const on = render({ reasonId: "devices-offline" });
    expect(on).not.toContain('aria-disabled="true"');
    expect(on).not.toContain("aria-describedby");
  });

  it("says where Sair is: under Mais on a phone, or in the menu of the store card on a big screen", () => {
    const html = render({ row: row({ isCurrent: true }) });
    expect(html).toContain("use <strong>Sair</strong>");
    expect(html).toContain("no celular ele está em Mais");
    expect(html).toContain(
      "em tela grande, no menu ⋯ do cartão da loja, no pé da barra lateral"
    );
  });

  it("this device, without a connection: says Sair will not take it off the list until it leaves online", () => {
    const html = render({ online: false, row: row({ isCurrent: true }) });
    expect(html).toContain(
      "Sair sem internet não tira este aparelho da lista. Ele sai quando você sair conectado, ou pode ser revogado de outro aparelho."
    );
    expect(html).not.toContain("Para tirar este aparelho");
    const connected = render({ online: true, row: row({ isCurrent: true }) });
    expect(connected).toContain("Para tirar este aparelho, use <strong>Sair</strong>");
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

describe("the form of the confirmation of a revocation", () => {
  const form = (props: Partial<Parameters<typeof RevokeForm>[0]> = {}) =>
    renderToStaticMarkup(
      <RevokeForm
        actionError={null}
        busy={false}
        endOtherSessions={false}
        offline={false}
        onCancel={vi.fn()}
        onChoose={vi.fn()}
        onRevoke={vi.fn()}
        row={row()}
        {...props}
      />
    );

  it("offers the option, unticked, with a label tied to the field and the help text", () => {
    const html = form();
    expect(html).toContain('role="checkbox"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toMatch(LABEL_FOR_CHECKBOX);
    expect(html).toContain(
      'aria-describedby="0199c2d0-0000-7000-8000-000000000002-help"'
    );
    expect(html).toContain(
      "todos os outros celulares e computadores, menos neste"
    );
    expect(html).toContain("Sim, revogar este aparelho");
    expect(html).toContain(">Cancelar<");
    expect(html).not.toContain("será desconectado agora");
  });

  it("ticked: shows the extra warning and changes the confirm button, which goes back when unticked", () => {
    const ticked = form({ endOtherSessions: true });
    expect(ticked).toContain("será desconectado agora");
    expect(ticked).toContain("Sim, revogar e encerrar as outras sessões");
    expect(ticked).not.toContain(">Sim, revogar este aparelho<");
    const unticked = form({ endOtherSessions: false });
    expect(unticked).toContain(">Sim, revogar este aparelho<");
    expect(unticked).not.toContain("será desconectado agora");
  });

  it("never says before the answer that this browser leaves", () => {
    expect(form({ endOtherSessions: true }).toLowerCase()).not.toContain(
      "navegador"
    );
  });

  it("offline: the option is off, the confirm is off but reads why, and Cancelar stays available", () => {
    const html = form({ offline: true, reasonId: "devices-offline" });
    // the checkbox (a real disabled field, with the line of the reason right above the buttons)
    expect(html).toContain("data-disabled");
    const confirm = buttonTag(html, "Sim, revogar este aparelho");
    expect(confirm).toContain('aria-disabled="true"');
    expect(confirm).toContain('aria-describedby="devices-offline"');
    expect(buttonTag(html, "Cancelar")).not.toContain('aria-disabled="true"');
  });

  it("the error of the attempt is an alert right above the buttons, and only when there is one", () => {
    const html = form({
      actionError: "Não conseguimos confirmar se o aparelho foi revogado.",
    });
    const alert = html.indexOf('role="alert"');
    expect(alert).toBeGreaterThan(html.indexOf("todos os outros celulares"));
    expect(alert).toBeLessThan(html.indexOf("Sim, revogar este aparelho"));
    expect(form()).not.toContain('role="alert"');
  });

  it("the confirm button says Revogando… during the call, and both buttons are off", () => {
    const html = form({ busy: true });
    expect(html).toContain(">Revogando…<");
    expect(html).not.toContain(">Sim, revogar este aparelho<");
    expect(buttonTag(html, "Cancelar")).toContain('aria-disabled="true"');
    expect(buttonTag(html, "Revogando…")).toContain('aria-disabled="true"');
  });
});
