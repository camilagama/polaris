import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ACCESS_EXPIRED_BODY,
  ACCESS_EXPIRED_TITLE,
  ACCESS_RENEWING,
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
  lastSyncAt: null,
  leaseExpiresAt: "2026-10-17T12:00:00.000Z",
  online: false,
  phase: "expired",
  reason: "offline_access_expired",
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

  it("has no technical code, no date, no promise of renewal and no 72 hours (AC-42)", () => {
    const texts = [
      ACCESS_EXPIRED_TITLE,
      ACCESS_EXPIRED_BODY,
      ACCESS_RENEWING,
      storedOperationsText(0),
      storedOperationsText(1),
      storedOperationsText(2),
      syncStatusLabel(snapshot()).text,
      syncStatusLabel(snapshot()).short,
    ];
    for (const text of texts) {
      expect(text).not.toMatch(TECHNICAL);
    }
  });

  it("the header chip says the access expired", () => {
    expect(syncStatusLabel(snapshot())).toEqual({
      attention: false,
      short: "Sem acesso",
      text: "O acesso sem internet venceu",
      tone: "offline",
    });
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
});
