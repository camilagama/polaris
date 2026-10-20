import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ACCESS_EXPIRED_BODY,
  ACCESS_EXPIRED_BODY_ONLINE,
  ACCESS_EXPIRED_TITLE,
  ACCESS_RENEW_FAILED,
  ACCESS_RENEW_REFUSED,
  ACCESS_RENEWED,
  ACCESS_RENEWING,
  ACCESS_RETRY,
  ACCESS_RETURNS_BY_ITSELF,
  ACCESS_SALE_NOT_KEPT,
  OfflineAccessExpiredView,
  OfflineAccessGateView,
  storedOperationsText,
} from "./offline-access-expired";
import type { RuntimeSnapshot } from "./offline-runtime";
import { syncStatusLabel } from "./sync-status";

const snapshot = (
  overrides: Partial<RuntimeSnapshot> = {}
): RuntimeSnapshot => ({
  bootstrapped: false,
  counts: { pending: 0, rejected: 0, sending: 0 },
  dataVersion: 0,
  expiredWhileOpen: false,
  lastSyncAt: null,
  leaseExpiresAt: "2026-10-17T12:00:00.000Z",
  online: false,
  phase: "expired",
  reason: "offline_access_expired",
  renewalRefused: false,
  sessionRefused: false,
  syncing: false,
  ...overrides,
});

/** Technical codes, dates or the lease length in a text meant for the shopkeeper. */
const TECHNICAL = /72|hora|sess[aã]o|lease|offline_|_|\d{2}\/\d{2}/i;

describe("the notice of the offline access that expired", () => {
  it("counts every operation kept on the device, in the singular, the plural and none", () => {
    expect(storedOperationsText(0)).toBe(
      "Não há operações guardadas neste aparelho."
    );
    expect(storedOperationsText(1)).toBe(
      "Há 1 operação guardada neste aparelho. Ela não se perde."
    );
    expect(storedOperationsText(3)).toBe(
      "Há 3 operações guardadas neste aparelho. Elas não se perdem."
    );
  });

  it("shows the title, the body and the queue, waiting, being sent and refused", () => {
    const html = renderToStaticMarkup(
      <OfflineAccessExpiredView
        snapshot={snapshot({
          counts: { pending: 1, rejected: 1, sending: 1 },
        })}
      />
    );
    expect(html).toContain(ACCESS_EXPIRED_TITLE);
    expect(html).toContain(ACCESS_EXPIRED_BODY);
    expect(html).toContain("Há 3 operações guardadas neste aparelho.");
    expect(html).not.toContain(ACCESS_RENEWING);
  });

  it("says it is renewing only while the network is back and the renewal runs", () => {
    const renewing = renderToStaticMarkup(
      <OfflineAccessExpiredView
        snapshot={snapshot({ online: true, syncing: true })}
      />
    );
    expect(renewing).toContain(ACCESS_RENEWING);
    const failed = renderToStaticMarkup(
      <OfflineAccessExpiredView
        snapshot={snapshot({ online: true, syncing: false })}
      />
    );
    expect(failed).not.toContain(ACCESS_RENEWING);
  });

  it("has no technical code, no date and no 72 hours (AC-42)", () => {
    const texts = [
      ACCESS_EXPIRED_TITLE,
      ACCESS_EXPIRED_BODY,
      ACCESS_EXPIRED_BODY_ONLINE,
      ACCESS_RENEWING,
      ACCESS_SALE_NOT_KEPT,
      ACCESS_RETURNS_BY_ITSELF,
      ACCESS_RENEW_FAILED,
      ACCESS_RENEW_REFUSED,
      ACCESS_RETRY,
      ACCESS_RENEWED,
      storedOperationsText(0),
      storedOperationsText(1),
      storedOperationsText(2),
      syncStatusLabel(snapshot()).text,
      syncStatusLabel(snapshot()).short,
      syncStatusLabel(snapshot({ online: true })).short,
    ];
    for (const text of texts) {
      expect(text).not.toMatch(TECHNICAL);
    }
  });

  it("offline: the body asks to connect; with internet it only says what happened", () => {
    expect(ACCESS_EXPIRED_BODY).toBe(
      "Este aparelho ficou muito tempo sem se conectar à internet. Conecte-se para continuar."
    );
    expect(ACCESS_EXPIRED_BODY_ONLINE).toBe(
      "Este aparelho ficou muito tempo sem se conectar à internet."
    );
    const offline = renderToStaticMarkup(
      <OfflineAccessExpiredView snapshot={snapshot({ online: false })} />
    );
    expect(offline).toContain("Conecte-se para continuar.");
    for (const overrides of [
      { online: true },
      { online: true, syncing: true },
      { online: true, renewalRefused: true },
    ]) {
      const html = renderToStaticMarkup(
        <OfflineAccessExpiredView snapshot={snapshot(overrides)} />
      );
      expect(html).toContain(ACCESS_EXPIRED_BODY_ONLINE);
      expect(html).not.toContain("Conecte-se");
    }
  });

  it("the final refusal does not send the person to a support channel the app does not have", () => {
    expect(ACCESS_RENEW_REFUSED).toBe(
      "Não conseguimos renovar o acesso deste aparelho. Feche e abra o app com internet."
    );
    expect(ACCESS_RENEW_REFUSED.toLowerCase()).not.toContain("suporte");
  });

  it("with internet the chip says 'Sem acesso' (not 'Conecte-se'), and the long text does not change", () => {
    expect(syncStatusLabel(snapshot({ online: true }))).toEqual({
      attention: false,
      short: "Sem acesso",
      text: "O acesso sem internet venceu",
      tone: "offline",
    });
  });

  it("the header chip says the access expired", () => {
    expect(syncStatusLabel(snapshot())).toEqual({
      attention: false,
      short: "Conecte-se",
      text: "O acesso sem internet venceu",
      tone: "offline",
    });
  });
});

const noRetry = () => undefined;
const render = (overrides: Partial<RuntimeSnapshot> = {}) =>
  renderToStaticMarkup(
    <OfflineAccessExpiredView
      onRetry={noRetry}
      snapshot={snapshot(overrides)}
    />
  );

describe("the sale that was being put together when the access ended", () => {
  it("tells it was not kept when the access ended with the app open", () => {
    expect(render({ expiredWhileOpen: true })).toContain(ACCESS_SALE_NOT_KEPT);
  });

  it("says nothing of it when the page was already opened expired", () => {
    expect(render({ expiredWhileOpen: false })).not.toContain(
      ACCESS_SALE_NOT_KEPT
    );
  });
});

describe("the way out of the notice", () => {
  it("offline: says the access comes back by itself, with no retry button", () => {
    const html = render({ online: false });
    expect(html).toContain(ACCESS_RETURNS_BY_ITSELF);
    expect(html).not.toContain(ACCESS_RETRY);
    expect(html).not.toContain(ACCESS_RENEW_FAILED);
  });

  it("online and not renewing: says it could not renew, will try again, and offers 'Tentar agora'", () => {
    const html = render({ online: true, syncing: false });
    expect(html).toContain(ACCESS_RENEW_FAILED);
    expect(html).toContain(ACCESS_RETRY);
    expect(html).toContain('class="secondary-button"');
    expect(html).not.toContain(ACCESS_RETURNS_BY_ITSELF);
    expect(html).not.toContain(ACCESS_RENEW_REFUSED);
  });

  it("online and renewing: only the renewing line, no button", () => {
    const html = render({ online: true, syncing: true });
    expect(html).toContain(ACCESS_RENEWING);
    expect(html).not.toContain(ACCESS_RETRY);
    expect(html).not.toContain(ACCESS_RENEW_FAILED);
  });

  it("refused for another reason than the session: its own text, no button and no promise that it comes back alone", () => {
    for (const online of [true, false]) {
      const html = render({ online, renewalRefused: true });
      expect(html).toContain(ACCESS_RENEW_REFUSED);
      expect(html).not.toContain(ACCESS_RETRY);
      expect(html).not.toContain(ACCESS_RETURNS_BY_ITSELF);
      expect(html).not.toContain(ACCESS_RENEW_FAILED);
    }
  });

  it("draws no button when nobody can act on it", () => {
    const html = renderToStaticMarkup(
      <OfflineAccessExpiredView snapshot={snapshot({ online: true })} />
    );
    expect(html).not.toContain(ACCESS_RETRY);
  });
});

describe("the gate of the page", () => {
  const page = <p>Tela da venda com a Camiseta</p>;

  it("draws the notice in place of the page while the access is expired, and none of the page", () => {
    const html = renderToStaticMarkup(
      <OfflineAccessGateView snapshot={snapshot()}>
        {page}
      </OfflineAccessGateView>
    );
    expect(html).toContain(ACCESS_EXPIRED_TITLE);
    expect(html).not.toContain("Camiseta");
  });

  it("draws the page when the runtime is ready, unavailable or not enabled", () => {
    for (const value of [
      snapshot({ phase: "ready", reason: null }),
      snapshot({ phase: "unavailable", reason: "no_lease_offline" }),
      null,
    ]) {
      const html = renderToStaticMarkup(
        <OfflineAccessGateView snapshot={value}>{page}</OfflineAccessGateView>
      );
      expect(html).toContain("Camiseta");
      expect(html).not.toContain(ACCESS_EXPIRED_TITLE);
    }
  });

  it("says the access was renewed above the page, only when asked to", () => {
    const screen = <p>Tela da venda</p>;
    const ready = snapshot({ phase: "ready", reason: null });
    const shown = renderToStaticMarkup(
      <OfflineAccessGateView renewed snapshot={ready}>
        {screen}
      </OfflineAccessGateView>
    );
    expect(shown).toContain(`role="status">${ACCESS_RENEWED}`);
    expect(shown).toContain("Tela da venda");
    const hidden = renderToStaticMarkup(
      <OfflineAccessGateView snapshot={ready}>{screen}</OfflineAccessGateView>
    );
    expect(hidden).not.toContain(ACCESS_RENEWED);
  });
});
