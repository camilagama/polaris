import type { Page } from "@playwright/test";

type Answer = Record<string, unknown>;

/**
 * The `closedStatus` answer of a store in its closing window and the ready copy that `listClosed` returns,
 * shared by the Loja encerrada e2e and the guardrail screens so a change in the answer's format breaks both.
 * Every date here is read against `CLOSED_NOW`, so the page clock is fixed there by the same module.
 */
export const CLOSED_STORE_ID = "0199c2d0-0000-7000-8000-00000000a001";
export const CLOSED_COPY_ID = "0199c2d0-0000-7000-8000-0000000000aa";
export const CLOSED_NOW = new Date("2026-10-30T12:00:00-03:00");

export const fixClosedStoreClock = (page: Page) =>
  page.clock.setFixedTime(CLOSED_NOW);

export const closingStore = (overrides: Answer = {}): Answer => ({
  canRecover: true,
  deletableFrom: "2027-01-18T03:00:00.000Z",
  deletionDate: "2027-01-18",
  exportOpenUntil: "2027-01-18T03:00:00.000Z",
  id: CLOSED_STORE_ID,
  milestones: {
    closure: "2026-10-20T12:00:00.000Z",
    d7: "2027-01-11T03:00:00.000Z",
    d30: "2026-12-19T03:00:00.000Z",
    deletionDay: "2027-01-18T03:00:00.000Z",
  },
  name: "Loja do teste",
  phase: "closing",
  recoverUntil: "2026-11-19T12:00:00.000Z",
  renewal: "not_handled",
  requestedAt: "2026-10-20T12:00:00.000Z",
  timezone: "America/Sao_Paulo",
  ...overrides,
});

export const READY_COPY: Answer = {
  errorCode: null,
  expiresAt: "2026-10-31T14:40:00.000Z",
  files: [{ name: "dados.json", ordinal: 1, sizeBytes: 820_400 }],
  formats: ["json", "csv"],
  id: CLOSED_COPY_ID,
  mode: "closed",
  readyAt: "2026-10-30T14:40:00.000Z",
  requestedAt: "2026-10-30T14:10:00.000Z",
  status: "ready",
  totalBytes: 820_400,
};
