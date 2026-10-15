import type { RuntimeSnapshot } from "./offline-runtime";
import { useRuntimeSnapshot } from "./runtime-context";
import "./sync-status.css";

/**
 * The state of the offline work, in the header (Phase 5 wiring): whether the
 * device is online, how much is waiting to be sent and whether something needs a
 * person. A refused operation turns the chip into a link to the attention panel.
 */
export interface SyncStatusLabel {
  attention: boolean;
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

export function syncStatusLabel(snapshot: RuntimeSnapshot): SyncStatusLabel {
  const { counts } = snapshot;
  const waiting = waitingOperations(snapshot);
  if (snapshot.phase === "unavailable") {
    return {
      attention: false,
      text: "Offline indisponível neste aparelho",
      tone: "offline",
    };
  }
  if (snapshot.phase !== "ready") {
    return {
      attention: false,
      text: "Preparando o modo offline…",
      tone: "busy",
    };
  }
  if (counts.rejected > 0) {
    return {
      attention: true,
      text: `${plural(counts.rejected, "operação precisa", "operações precisam")} de atenção`,
      tone: "attention",
    };
  }
  if (!snapshot.online) {
    return {
      attention: false,
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
      text:
        waiting > 0
          ? `Enviando ${plural(waiting, "operação", "operações")}…`
          : "Sincronizando…",
      tone: "busy",
    };
  }
  return { attention: false, text: "Tudo sincronizado", tone: "ok" };
}

export function SyncStatusView({ snapshot }: { snapshot: RuntimeSnapshot }) {
  const label = syncStatusLabel(snapshot);
  const content = (
    <>
      <span aria-hidden="true" className="sync-status-dot" />
      <span>{label.text}</span>
    </>
  );
  return label.attention ? (
    <a className="sync-status" data-tone={label.tone} href="/attention">
      {content}
    </a>
  ) : (
    <p className="sync-status" data-tone={label.tone} role="status">
      {content}
    </p>
  );
}

/** The header chip; renders nothing when the offline runtime is not enabled. */
export function SyncStatus() {
  const snapshot = useRuntimeSnapshot();
  return snapshot ? <SyncStatusView snapshot={snapshot} /> : null;
}
