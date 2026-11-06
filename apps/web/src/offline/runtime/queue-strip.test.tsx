import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  fadeState,
  QueueStripView,
  type Spoken,
  spokenFor,
} from "./queue-strip";
import type { RuntimeSnapshot } from "./offline-runtime";
import {
  type QueueStripText,
  queueStripText,
  syncStatusLabel,
} from "./sync-status";

const BARE_SPIN = /(?<![:\w-])animate-spin/;
const BARE_MOTION = /(?<![:\w-])(?:transition|duration-\d+)/;

const snapshot = (
  overrides: Partial<RuntimeSnapshot> = {},
  counts: Partial<RuntimeSnapshot["counts"]> = {}
): RuntimeSnapshot => ({
  bootstrapped: true,
  counts: { pending: 0, rejected: 0, sending: 0, ...counts },
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

const offline = (waiting: number) =>
  queueStripText(snapshot({ online: false }, { pending: waiting }));
const sending = (waiting: number) =>
  queueStripText(snapshot({ syncing: true }, { sending: waiting }));

describe("the strip of the queue (AC-T6.1)", () => {
  it("without connection it says the state and what happens to the work, in the words of the chip", () => {
    const text = offline(3);
    expect(text).toEqual({
      consequence: "3 operações guardadas, enviam quando voltar",
      title: "Sem conexão",
      tone: "offline",
    });
    expect(
      syncStatusLabel(snapshot({ online: false }, { pending: 3 })).text
    ).toBe("Sem conexão · 3 operações guardadas, enviam quando voltar");
    expect(offline(1)?.consequence).toBe(
      "1 operação guardada, envia quando voltar"
    );
  });

  it("while sending it says how many are going, with no consequence", () => {
    expect(sending(2)).toEqual({
      consequence: null,
      title: "Enviando 2 operações…",
      tone: "busy",
    });
    expect(sending(1)?.title).toBe("Enviando 1 operação…");
  });

  it("with an empty queue it does not exist, with or without connection", () => {
    expect(queueStripText(snapshot())).toBeNull();
    expect(queueStripText(snapshot({ online: false }))).toBeNull();
    expect(queueStripText(snapshot({ syncing: true }))).toBeNull();
    expect(
      renderToStaticMarkup(<QueueStripView level="full" text={null} />)
    ).toBe("");
  });

  it("a refused operation does not hide the work that waits behind it", () => {
    expect(
      queueStripText(snapshot({ online: false }, { pending: 2, rejected: 1 }))
        ?.title
    ).toBe("Sem conexão");
  });

  it("does not speak for a runtime that is not ready", () => {
    expect(
      queueStripText(snapshot({ phase: "expired" }, { pending: 2 }))
    ).toBeNull();
    expect(
      queueStripText(snapshot({ phase: "starting" }, { pending: 2 }))
    ).toBeNull();
  });

  it("the paused send for the acceptance keeps its words and counts as a warning", () => {
    expect(
      queueStripText(
        snapshot({ legalAcceptanceRequired: true }, { pending: 2 })
      )
    ).toMatchObject({
      consequence: "2 operações guardadas",
      title: "Envio pausado até o aceite dos termos",
      tone: "offline",
    });
  });
});

describe("how the strip is drawn", () => {
  it("is a polite status of at least 36 px, in the warning tone without connection", () => {
    const html = renderToStaticMarkup(
      <QueueStripView level="full" text={offline(2)} />
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("min-h-9");
    expect(html).toContain("border-warning/30");
    expect(html).toContain("Sem conexão");
    expect(html).toContain("2 operações guardadas, enviam quando voltar");
    expect(html).not.toContain("animate-spin");
  });

  it("is muted with a spinner while sending, and the spinner turns only where the interface moves (AC-T6.5)", () => {
    const html = renderToStaticMarkup(
      <QueueStripView level="full" text={sending(2)} />
    );
    expect(html).toContain('data-tone="busy"');
    expect(html).toContain("bg-muted/60");
    expect(html).toContain("motion-full:animate-spin");
    expect(html).not.toMatch(BARE_SPIN);
  });

  it("the fade is 150 ms under motion-full and no other motion class is bare (AC-T6.5)", () => {
    const html = renderToStaticMarkup(
      <QueueStripView level="essential" text={offline(1)} />
    );
    expect(html).toContain("motion-full:transition-opacity");
    expect(html).toContain("motion-full:duration-150");
    expect(html).not.toMatch(BARE_MOTION);
  });

  it("the title and the consequence share a line from 480 px and stack below", () => {
    const html = renderToStaticMarkup(
      <QueueStripView level="full" text={offline(2)} />
    );
    expect(html).toContain("flex-col");
    expect(html).toContain("min-[480px]:flex-row");
  });
});

describe("leaving (AC-T6.5)", () => {
  const last: QueueStripText = {
    consequence: null,
    title: "Enviando 1 operação…",
    tone: "busy",
  };

  it("where the interface moves, the last text stays while it fades", () => {
    expect(fadeState(null, last, false, "full")).toEqual({
      leaving: true,
      shown: last,
    });
    expect(fadeState(null, last, true, "full")).toEqual({
      leaving: false,
      shown: null,
    });
  });

  it("on the phone and with reduced motion it goes in the same frame", () => {
    expect(fadeState(null, last, false, "essential")).toEqual({
      leaving: false,
      shown: null,
    });
    expect(fadeState(null, last, false, "none")).toEqual({
      leaving: false,
      shown: null,
    });
  });

  it("with text there is nothing leaving", () => {
    expect(fadeState(last, last, false, "full").leaving).toBe(false);
  });
});

describe("what the screen reader hears (AC-T6.7)", () => {
  const empty: Spoken = { key: "", sentence: "" };

  it("speaks the state once: the count going down gives the same sentence back", () => {
    const first = spokenFor(empty, sending(3) as QueueStripText);
    const second = spokenFor(first, sending(2) as QueueStripText);
    const third = spokenFor(second, sending(1) as QueueStripText);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(first.sentence).toBe("Enviando 3 operações…");
  });

  it("the same for the work waiting without connection, whatever the count", () => {
    const first = spokenFor(empty, offline(1) as QueueStripText);
    expect(spokenFor(first, offline(4) as QueueStripText)).toBe(first);
  });

  it("speaks again when the state changes: offline, then sending", () => {
    const waiting = spokenFor(empty, offline(2) as QueueStripText);
    const going = spokenFor(waiting, sending(2) as QueueStripText);
    expect(going).not.toBe(waiting);
    expect(going.sentence).toBe("Enviando 2 operações…");
    expect(waiting.sentence).toBe(
      "Sem conexão. 2 operações guardadas, enviam quando voltar"
    );
  });

  it("the visible text is hidden from assistive technology and one sentence stands for it", () => {
    const html = renderToStaticMarkup(
      <QueueStripView level="full" text={offline(2)} />
    );
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).toContain('<span class="sr-only">Sem conexão. 2 operações');
    expect(html).toContain('aria-hidden="true" class="flex');
  });
});
