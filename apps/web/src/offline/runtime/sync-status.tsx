import type { RuntimeSnapshot } from "./offline-runtime";
import { useRuntimeSnapshot } from "./runtime-context";
import "./sync-status.css";

/**
 * The state of the offline work, in the header (Phase 5 wiring): whether the
 * device is online, how much is waiting to be sent and whether something needs a
 * person. A refused operation turns the chip into a link to the attention panel.
 * The visible text is short and the whole sentence is the accessible name, so the
 * name of the link starts with what is shown ("Atenção: 2", WCAG 2.5.3). With the
 * menu open, the same sentence is the first line of the menu (`SyncStatusMenuLine`),
 * because a tooltip does not show on touch.
 */
export interface SyncStatusLabel {
  attention: boolean;
  /** One short line for the header chip (it has to fit next to the brand and "Menu" at 360 px). */
  short: string;
  /** The whole sentence: the accessible name and the tooltip of the chip. */
  text: string;
  tone: "attention" | "busy" | "offline" | "ok";
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The operations still on the device that the server has not accepted (waiting or being sent). */
export function waitingOperations(snapshot: RuntimeSnapshot): number {
  return snapshot.counts.pending + snapshot.counts.sending;
}

/** The server waits for the legal acceptance: nothing was refused or lost, the send is only paused. */
function pausedForAcceptance(waiting: number): SyncStatusLabel {
  return {
    attention: false,
    short: "Envio pausado",
    text:
      waiting > 0
        ? `Envio pausado até o aceite dos termos · ${plural(waiting, "operação guardada", "operações guardadas")}`
        : "Envio pausado até o aceite dos termos",
    tone: "offline",
  };
}

/** Offline is not ready on this device: the access expired, offline is unavailable or it is still preparing. */
function notReadyLabel(snapshot: RuntimeSnapshot): SyncStatusLabel {
  if (snapshot.phase === "expired") {
    return {
      attention: false,
      // with internet "Conecte-se" would ask for what the person already has
      short: snapshot.online ? "Sem acesso" : "Conecte-se",
      text: "O acesso sem internet venceu",
      tone: "offline",
    };
  }
  if (snapshot.phase === "unavailable") {
    return {
      attention: false,
      short: "Sem offline",
      text: "Offline indisponível neste aparelho",
      tone: "offline",
    };
  }
  return {
    attention: false,
    short: "Preparando",
    text: "Preparando o modo offline…",
    tone: "busy",
  };
}

export function syncStatusLabel(snapshot: RuntimeSnapshot): SyncStatusLabel {
  const { counts } = snapshot;
  const waiting = waitingOperations(snapshot);
  if (snapshot.legalAcceptanceRequired && snapshot.online) {
    return pausedForAcceptance(waiting);
  }
  if (snapshot.phase !== "ready") {
    return notReadyLabel(snapshot);
  }
  if (counts.rejected > 0) {
    return {
      attention: true,
      short: `Atenção: ${counts.rejected}`,
      text: `Atenção: ${plural(counts.rejected, "operação precisa", "operações precisam")} de atenção`,
      tone: "attention",
    };
  }
  if (!snapshot.online) {
    return {
      attention: false,
      short: waiting > 0 ? `Offline · ${waiting}` : "Offline",
      text:
        waiting > 0
          ? `Sem conexão · ${plural(waiting, "operação guardada", "operações guardadas")}`
          : "Sem conexão · tudo guardado neste aparelho",
      tone: "offline",
    };
  }
  if (snapshot.reason === "sync_failed") {
    return {
      attention: false,
      short: "Envio falhou",
      text:
        waiting > 0
          ? `Não foi possível enviar · ${plural(waiting, "operação guardada", "operações guardadas")}`
          : "Não foi possível sincronizar agora",
      tone: "offline",
    };
  }
  if (snapshot.syncing || waiting > 0) {
    return {
      attention: false,
      short: waiting > 0 ? `Enviando ${waiting}` : "Atualizando",
      text:
        waiting > 0
          ? `Enviando ${plural(waiting, "operação", "operações")}…`
          : "Sincronizando…",
      tone: "busy",
    };
  }
  return {
    attention: false,
    short: "Sincronizado",
    text: "Tudo sincronizado",
    tone: "ok",
  };
}

export function SyncStatusView({ snapshot }: { snapshot: RuntimeSnapshot }) {
  const label = syncStatusLabel(snapshot);
  const content = (
    <>
      <span aria-hidden="true" className="sync-status-dot" />
      <span aria-hidden="true" className="sync-status-short">
        {label.short}
      </span>
      <span className="visually-hidden">{label.text}</span>
    </>
  );
  return label.attention ? (
    <a
      className="sync-status"
      data-tone={label.tone}
      href="/attention"
      title={label.text}
    >
      {content}
    </a>
  ) : (
    <p
      className="sync-status"
      data-tone={label.tone}
      role="status"
      title={label.text}
    >
      {content}
    </p>
  );
}

/**
 * The whole sentence of the state as the first line of the open menu, with the colour dot of the
 * chip. Narrow screens only (the CSS hides it from 1100 px, where the chip keeps the sentence in its
 * `title`). It is hidden from assistive technology: the chip already says the same thing.
 */
export function SyncStatusMenuLineView({
  snapshot,
}: {
  snapshot: RuntimeSnapshot;
}) {
  const label = syncStatusLabel(snapshot);
  return (
    <p
      aria-hidden="true"
      className="sync-status-menu-line"
      data-tone={label.tone}
    >
      <span className="sync-status-dot" />
      {label.text}
    </p>
  );
}

export function SyncStatusMenuLine() {
  const snapshot = useRuntimeSnapshot();
  return snapshot ? <SyncStatusMenuLineView snapshot={snapshot} /> : null;
}

/** The header chip; renders nothing when the offline runtime is not enabled. */
export function SyncStatus() {
  const snapshot = useRuntimeSnapshot();
  return snapshot ? <SyncStatusView snapshot={snapshot} /> : null;
}
