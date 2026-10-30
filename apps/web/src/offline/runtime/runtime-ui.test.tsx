import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  bottomBarMark,
  NAV_ITEMS,
  resolveRoute,
} from "../../app-shell/navigation-model";
import { signOfflineLease } from "../../lib/offline-lease-token";
import { logoutDestination } from "../../lib/sign-in-path";
import type { LogoutWorkspace } from "../logout-guard";
import { MemoryOutboxStorage } from "../outbox/memory-storage";
import { Outbox } from "../outbox/outbox";
import { discardAndLeave, startLogout } from "./logout-flow";
import type { RuntimeSnapshot } from "./offline-runtime";
import {
  SyncStatusMenuLineView,
  SyncStatusView,
  syncStatusLabel,
} from "./sync-status";

const SHORT_TEXT = /<span aria-hidden="true" class="sync-status-short[^"]*">/;
const HIDDEN_ICON = /<svg[^>]*aria-hidden="true"/;

const snapshot = (
  overrides: Partial<RuntimeSnapshot> = {}
): RuntimeSnapshot => ({
  bootstrapped: true,
  counts: { pending: 0, rejected: 0, sending: 0 },
  dataVersion: 0,
  expiredWhileOpen: false,
  lastSyncAt: null,
  leaseExpiresAt: null,
  legalAcceptanceRequired: false,
  online: true,
  organizationClosed: false,
  phase: "ready",
  reason: null,
  renewalRefused: false,
  sessionRefused: false,
  syncing: false,
  ...overrides,
});
const counts = (
  overrides: Partial<RuntimeSnapshot["counts"]>
): RuntimeSnapshot["counts"] => ({
  pending: 0,
  rejected: 0,
  sending: 0,
  ...overrides,
});

describe("the sync status in the header", () => {
  it("says everything is synchronized when online and nothing is waiting", () => {
    expect(syncStatusLabel(snapshot())).toEqual({
      attention: false,
      short: "Sincronizado",
      text: "Tudo sincronizado",
      tone: "ok",
    });
  });

  it("tells how much is kept on the device when there is no connection (U-54)", () => {
    expect(
      syncStatusLabel(
        snapshot({ counts: counts({ pending: 2 }), online: false })
      )
    ).toMatchObject({
      text: "Sem conexão · 2 operações guardadas",
      tone: "offline",
    });
    // U-54: with nothing queued the sentence is only "Sem conexão", for the screen reader too
    expect(syncStatusLabel(snapshot({ online: false }))).toMatchObject({
      short: "Offline",
      text: "Sem conexão",
    });
    const html = renderToStaticMarkup(
      <SyncStatusView
        snapshot={snapshot({ counts: counts({ pending: 2 }), online: false })}
      />
    );
    expect(html).toContain(
      '<span class="sr-only">Sem conexão · 2 operações guardadas</span>'
    );
  });

  it("on a screen that works only online, says it needs internet instead of promising what the device keeps (U-54)", () => {
    const onlineOnly = { onlineOnly: true };
    expect(
      syncStatusLabel(snapshot({ online: false }), onlineOnly)
    ).toMatchObject({
      short: "Offline",
      text: "Sem conexão · esta tela precisa de internet",
      tone: "offline",
    });
    expect(
      syncStatusLabel(
        snapshot({ counts: counts({ pending: 2 }), online: false }),
        onlineOnly
      ).text
    ).toBe(
      "Sem conexão · 2 operações guardadas · esta tela precisa de internet"
    );
    // online, nothing changes
    expect(syncStatusLabel(snapshot(), onlineOnly).text).toBe(
      "Tudo sincronizado"
    );
    const html = renderToStaticMarkup(
      <SyncStatusView
        screen={onlineOnly}
        snapshot={snapshot({ online: false })}
      />
    );
    expect(html).toContain("esta tela precisa de internet");
    expect(html).not.toContain("tudo guardado neste aparelho");
  });

  it("shows progress while sending, and a failure that kept everything", () => {
    expect(
      syncStatusLabel(snapshot({ counts: counts({ pending: 1 }) }))
    ).toMatchObject({ text: "Enviando 1 operação…", tone: "busy" });
    expect(
      syncStatusLabel(snapshot({ reason: "sync_failed", syncing: false }))
    ).toMatchObject({ tone: "offline" });
  });

  it("says the server is busy when it died on the send, and keeps 'Envio falhou' for any other failure", () => {
    expect(
      syncStatusLabel(
        snapshot({
          counts: counts({ pending: 2 }),
          reason: "server_busy",
          syncing: false,
        })
      )
    ).toEqual({
      attention: false,
      short: "Ocupado · 2",
      text: "Servidor ocupado · 2 operações guardadas neste aparelho",
      tone: "offline",
    });
    expect(
      syncStatusLabel(snapshot({ reason: "server_busy", syncing: false }))
    ).toMatchObject({
      short: "Ocupado",
      text: "Servidor ocupado · tentando de novo sozinho",
    });
    expect(
      syncStatusLabel(
        snapshot({
          counts: counts({ pending: 2 }),
          reason: "sync_failed",
          syncing: false,
        })
      )
    ).toMatchObject({
      short: "Envio falhou",
      text: "Não foi possível enviar · 2 operações guardadas",
    });
  });

  it("a refused operation becomes a call for attention, whatever else is going on", () => {
    expect(
      syncStatusLabel(
        snapshot({ counts: counts({ pending: 3, rejected: 1 }), online: false })
      )
    ).toEqual({
      attention: true,
      short: "Atenção: 1",
      text: "Atenção: 1 operação precisa de atenção",
      tone: "attention",
    });
  });

  it("says when the offline mode is being prepared or is not available", () => {
    expect(syncStatusLabel(snapshot({ phase: "starting" })).tone).toBe("busy");
    expect(
      syncStatusLabel(
        snapshot({ phase: "unavailable", reason: "no_lease_offline" })
      ).text
    ).toContain("indisponível");
  });

  it("has a short text for the header chip, with the whole sentence kept for the tooltip and the screen reader", () => {
    const cases = [
      snapshot({ counts: counts({ pending: 12 }), online: false }),
      snapshot({ online: false }),
      snapshot({ counts: counts({ pending: 12 }) }),
      snapshot({ reason: "sync_failed", syncing: false }),
      snapshot({ reason: "server_busy", syncing: false }),
      snapshot({
        counts: counts({ pending: 12 }),
        reason: "server_busy",
        syncing: false,
      }),
      snapshot({ syncing: true }),
      snapshot({ phase: "starting" }),
      snapshot({ phase: "unavailable", reason: "no_lease_offline" }),
      snapshot({ counts: counts({ rejected: 12 }) }),
      snapshot(),
    ];
    for (const item of cases) {
      const label = syncStatusLabel(item);
      // at 360 px the chip has room for about a dozen characters
      expect(label.short.length).toBeLessThanOrEqual(13);
      expect(label.short.length).toBeLessThan(label.text.length);
      const html = renderToStaticMarkup(<SyncStatusView snapshot={item} />);
      expect(html).toContain(`title="${label.text}"`);
      expect(html).toContain(`<span class="sr-only">${label.text}</span>`);
      expect(html).toContain(`>${label.short}</span>`);
      expect(html).toMatch(SHORT_TEXT);
      // never only color: an icon goes with the text
      expect(html).toMatch(HIDDEN_ICON);
    }
    expect(
      syncStatusLabel(
        snapshot({ counts: counts({ pending: 12 }), online: false })
      ).short
    ).toBe("Offline · 12");
    // the name of the link to the attention page starts with the visible text
    const attention = syncStatusLabel(
      snapshot({ counts: counts({ rejected: 2 }) })
    );
    expect(attention.text.startsWith(attention.short)).toBe(true);
  });

  it("renders a link to the attention page only when something needs attention", () => {
    const plain = renderToStaticMarkup(
      <SyncStatusView snapshot={snapshot()} />
    );
    expect(plain).not.toContain("<a");
    expect(plain).toContain('role="status"');
    const attention = renderToStaticMarkup(
      <SyncStatusView
        snapshot={snapshot({ counts: counts({ rejected: 2 }) })}
      />
    );
    expect(attention).toContain('href="/attention"');
    expect(attention).toContain("Atenção: 2 operações precisam de atenção");
  });
});

describe("the sync status while the send waits for the legal acceptance", () => {
  const paused = (rejected: number, pending = 0) =>
    syncStatusLabel(
      snapshot({
        counts: counts({ pending, rejected }),
        legalAcceptanceRequired: true,
      })
    );

  it("keeps the short chip and the count of what is waiting", () => {
    expect(paused(0, 2)).toEqual({
      attention: false,
      short: "Envio pausado",
      text: "Envio pausado até o aceite dos termos · 2 operações guardadas",
      tone: "offline",
    });
  });

  it("adds what needs attention to the sentence, not to the chip", () => {
    expect(paused(0).text).toBe("Envio pausado até o aceite dos termos");
    expect(paused(1).text).toBe(
      "Envio pausado até o aceite dos termos · 1 precisa de atenção"
    );
    expect(paused(3, 1)).toMatchObject({
      short: "Envio pausado",
      text: "Envio pausado até o aceite dos termos · 1 operação guardada · 3 precisam de atenção",
    });
  });
});

describe("the sync status line at the top of Mais", () => {
  it("shows the whole sentence of the state with its icon, hidden from assistive technology", () => {
    const cases = [
      snapshot({ counts: counts({ pending: 3 }), online: false }),
      snapshot({ reason: "sync_failed" }),
      snapshot({ phase: "unavailable", reason: "no_lease_offline" }),
      snapshot({ counts: counts({ rejected: 2 }) }),
      snapshot(),
    ];
    for (const item of cases) {
      const label = syncStatusLabel(item);
      const html = renderToStaticMarkup(
        <SyncStatusMenuLineView snapshot={item} />
      );
      expect(html).toContain('aria-hidden="true"');
      expect(html).toContain(`data-tone="${label.tone}"`);
      expect(html).toContain("<svg");
      expect(html).toContain(label.text);
    }
  });

  it("uses words that do not read as something else", () => {
    expect(syncStatusLabel(snapshot()).short).toBe("Sincronizado");
    expect(syncStatusLabel(snapshot({ phase: "unavailable" })).short).toBe(
      "Sem offline"
    );
  });
});

describe("the attention page route", () => {
  it("exists, outside the main menu, and the bottom bar marks Mais on it", () => {
    expect(resolveRoute("/attention")).toMatchObject({
      id: "attention",
      kind: "page",
      navId: "attention",
    });
    expect(NAV_ITEMS.some((item) => item.id === "attention")).toBe(false);
    expect(bottomBarMark("attention")).toBe("more");
  });
});

const deviceId = "0199c2d0-0000-7000-8000-0000000000d1";
const key = { id: "k1", secret: "s".repeat(40) };
const now = new Date("2026-10-14T12:30:00.000Z");

async function workspace(commands: number, trySync = () => Promise.resolve()) {
  const lease = await signOfflineLease(
    buildOfflineLeaseClaims({
      capabilities: ["sale:create"],
      deviceId,
      epoch: 0,
      expiresAt: new Date(now.getTime() + 24 * 3_600_000),
      grantId: "0199c2d0-0000-7000-8000-000000000900",
      issuedAt: new Date(now.getTime() - 3_600_000),
      organizationId: "org-1",
      userId: "user-1",
    }),
    key
  );
  const outbox = new Outbox({
    deviceId,
    now: () => now,
    organizationId: "org-1",
    storage: new MemoryOutboxStorage(),
    userId: "user-1",
  });
  for (let n = 1; n <= commands; n += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: commands are queued in order
    await outbox.enqueue({
      baseVersion: null,
      commandId: `0199c2d0-0000-7000-8000-${String(100 + n).padStart(12, "0")}`,
      deviceId,
      lease,
      organizationId: "org-1",
      payload: { items: [], occurredAt: now.toISOString() },
      type: "sale.confirm",
    });
  }
  const purge = vi.fn((_options: { discardPending: boolean }) =>
    Promise.resolve()
  );
  const value: LogoutWorkspace = { label: "Loja", outbox, purge, trySync };
  return { purge, value };
}

/** A browser with no device (the runtime never registered one): nothing to revoke. */
const noDevice = () => ({
  forget: () => undefined,
  id: null,
  isOnline: () => true,
  revoke: () => Promise.reject(new Error("not called")),
});

describe("logging out end to end", () => {
  it("purges, ends the session and leaves, in that order, when nothing is queued", async () => {
    const { purge, value } = await workspace(0);
    const order: string[] = [];
    purge.mockImplementation(() => {
      order.push("purge");
      return Promise.resolve();
    });
    const result = await startLogout({
      device: noDevice(),
      leave: () => order.push("leave"),
      signOut: () => {
        order.push("signOut");
        return Promise.resolve();
      },
      workspaces: [value],
    });
    expect(result).toEqual({ status: "signed_out" });
    expect(order).toEqual(["purge", "signOut", "leave"]);
  });

  it("does not touch the session, and purges nothing, while the guard blocks", async () => {
    const { purge, value } = await workspace(2, () =>
      Promise.reject(new Error("offline"))
    );
    const signOut = vi.fn(() => Promise.resolve());
    const leave = vi.fn();
    const result = await startLogout({
      device: noDevice(),
      leave,
      signOut,
      workspaces: [value],
    });
    expect(result).toMatchObject({
      blocked: [{ reason: "offline", total: 2 }],
      status: "blocked",
    });
    expect(purge).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    expect(leave).not.toHaveBeenCalled();
  });

  it("discarding on purpose purges with the flag, then ends the session", async () => {
    const { purge, value } = await workspace(0);
    const signOut = vi.fn(() => Promise.resolve());
    const leave = vi.fn();
    expect(
      await discardAndLeave({
        device: noDevice(),
        leave,
        signOut,
        workspaces: [value],
      })
    ).toEqual({ status: "signed_out" });
    expect(purge).toHaveBeenCalledWith({ discardPending: true });
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it("reports a session that could not be ended after the data was purged, and does not leave", async () => {
    const { value } = await workspace(0);
    const leave = vi.fn();
    expect(
      await startLogout({
        device: noDevice(),
        leave,
        signOut: () => Promise.reject(new Error("network")),
        workspaces: [value],
      })
    ).toEqual({ status: "sign_out_failed" });
    expect(leave).not.toHaveBeenCalled();
  });

  describe("with a destination (AC-43)", () => {
    it("leaves for the sign-in screen with the reason and the destination, only after the session ended", async () => {
      const { value } = await workspace(0);
      const order: string[] = [];
      const destination = logoutDestination({
        reason: "recente",
        returnTo: "/devices",
      });
      await startLogout({
        device: noDevice(),
        leave: () => order.push(`leave ${destination}`),
        signOut: () => {
          order.push("signOut");
          return Promise.resolve();
        },
        workspaces: [value],
      });
      expect(order).toEqual([
        "signOut",
        "leave /entrar?motivo=recente&voltar=/devices",
      ]);
    });

    it.each([
      "//evil.example",
      "https://evil.example",
      "/entrar",
      "/api/auth/sign-out",
    ])(
      "goes to the start when the destination is not valid (%s)",
      (returnTo) => {
        expect(logoutDestination({ reason: "recente", returnTo })).toBe("/");
      }
    );

    it("navigates nowhere while the queue blocks the exit", async () => {
      const { value } = await workspace(2, () =>
        Promise.reject(new Error("offline"))
      );
      const leave = vi.fn();
      const result = await startLogout({
        device: noDevice(),
        leave,
        signOut: () => Promise.resolve(),
        workspaces: [value],
      });
      expect(result.status).toBe("blocked");
      expect(leave).not.toHaveBeenCalled();
    });
  });
});
