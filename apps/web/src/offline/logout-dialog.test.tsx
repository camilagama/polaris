import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LogoutDialog } from "./logout-dialog";
import type { BlockedWorkspace } from "./logout-guard";

const none = () => undefined;
const blocked = (
  overrides: Partial<BlockedWorkspace> = {}
): BlockedWorkspace => ({
  attention: { items: [], waitingBehind: 0 },
  label: "Loja Centro",
  pending: 2,
  reason: "offline",
  sending: 0,
  total: 2,
  ...overrides,
});

function render(items: BlockedWorkspace[], busy = false): string {
  return renderToStaticMarkup(
    <LogoutDialog
      blocked={items}
      busy={busy}
      onCancel={none}
      onDiscard={none}
      onRetry={none}
      onShowAttention={none}
    />
  );
}

describe("the logout dialog", () => {
  it("says how much work would be lost and why it could not be sent", () => {
    const html = render([blocked()]);
    expect(html).toContain("2 operações");
    expect(html).toContain("Loja Centro");
    expect(html).toContain("sem conexão com o servidor");
    expect(html).toContain("elas se perdem");
  });

  it("offers retry, staying signed in and a discard that is not immediate", () => {
    const html = render([blocked()]);
    expect(html).toContain("Tentar enviar de novo");
    expect(html).toContain("Ficar conectado");
    expect(html).toContain("Descartar e sair…");
    expect(html).not.toContain("Confirmar");
    expect(html).not.toContain("Ver o que precisa de atenção");
  });

  it("offers the attention panel only when the server refused something", () => {
    const html = render([
      blocked({
        attention: {
          items: [
            {
              actions: ["discard"],
              blocksQueue: true,
              cause: "sku_conflict",
              code: "sku_conflict",
              commandId: "0199c2d0-0000-7000-8000-000000000101",
              detail: "x",
              facts: null,
              kind: "product",
              title: "Produto",
            },
          ],
          waitingBehind: 0,
        },
        reason: "refused",
      }),
    ]);
    expect(html).toContain("O servidor recusou operações");
    expect(html).toContain("Ver o que precisa de atenção");
  });

  it("adds up several workspaces and has no way to log out anyway", () => {
    const html = render([
      blocked(),
      blocked({ label: "Loja Norte", reason: "still_pending", total: 3 }),
    ]);
    expect(html).toContain("5 operações");
    expect(html).toContain("Loja Norte");
    const lower = html.toLowerCase();
    expect(lower).not.toContain("sair assim mesmo");
    expect(lower).not.toContain("forç");
  });

  it("disables the buttons while working", () => {
    const html = render([blocked()], true);
    expect(html.match(/<button\b/g)).toHaveLength(3);
    expect(html.match(/<button\b[^>]*\sdisabled=""/g)).toHaveLength(3);
  });
});
