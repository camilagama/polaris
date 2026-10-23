import CheckIcon from "lucide-react/dist/esm/icons/check";
import CloudOffIcon from "lucide-react/dist/esm/icons/cloud-off";
import RefreshCwIcon from "lucide-react/dist/esm/icons/refresh-cw";
import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert";
import type { RuntimeSnapshot } from "./offline-runtime";
import { useRuntimeSnapshot } from "./runtime-context";

/**
 * The state of the offline work, in the header (Phase 5 wiring): whether the
 * device is online, how much is waiting to be sent and whether something needs a
 * person. A refused operation turns the chip into a link to the attention panel.
 * The visible text is short and the whole sentence is the accessible name, so the
 * name of the link starts with what is shown ("Atenção: 2", WCAG 2.5.3). On the
 * phone, the same sentence is the first line of "Mais" (`SyncStatusMenuLine`),
 * because a tooltip does not show on touch.
 */
export interface SyncStatusLabel {
  attention: boolean;
  /** One short line for the chip (on the phone it has to fit next to the brand and the theme button at 320 px). */
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

/**
 * The server waits for the legal acceptance: nothing was refused or lost, the send is only paused. The short
 * chip stays "Envio pausado"; the sentence (menu line and tooltip) keeps the count of what needs attention.
 */
function pausedForAcceptance(
  waiting: number,
  rejected: number
): SyncStatusLabel {
  const parts = ["Envio pausado até o aceite dos termos"];
  if (waiting > 0) {
    parts.push(plural(waiting, "operação guardada", "operações guardadas"));
  }
  if (rejected > 0) {
    parts.push(`${plural(rejected, "precisa", "precisam")} de atenção`);
  }
  return {
    attention: false,
    short: "Envio pausado",
    text: parts.join(" · "),
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

/** What the label says about the screen being open, not about the device (U-54). */
export interface SyncStatusScreen {
  /** The screen works only with a connection (it reads and saves on the server): offline it says so. */
  onlineOnly?: boolean;
}

const NEEDS_INTERNET = "esta tela precisa de internet";

export function syncStatusLabel(
  snapshot: RuntimeSnapshot,
  screen: SyncStatusScreen = {}
): SyncStatusLabel {
  const { counts } = snapshot;
  const waiting = waitingOperations(snapshot);
  if (snapshot.legalAcceptanceRequired && snapshot.online) {
    return pausedForAcceptance(waiting, counts.rejected);
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
      text: offlineText(waiting, screen.onlineOnly === true),
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

/**
 * The sentence when there is no connection. "Tudo guardado neste aparelho" is true only for what the device keeps:
 * on a screen that works only online it would promise the opposite, so it says the screen needs internet.
 */
function offlineText(waiting: number, onlineOnly: boolean): string {
  const kept =
    waiting > 0
      ? plural(waiting, "operação guardada", "operações guardadas")
      : null;
  if (onlineOnly) {
    return ["Sem conexão", kept, NEEDS_INTERNET].filter(Boolean).join(" · ");
  }
  return `Sem conexão · ${kept ?? "tudo guardado neste aparelho"}`;
}

/* v5.1 (the SyncChip of the design): a 20 px pill. Synced and sending are neutral; only what asks for attention has
   color, and never only color: an icon and the text go with it. */
const TONE_CLASS: Record<SyncStatusLabel["tone"], string> = {
  attention: "bg-destructive/10 text-destructive dark:bg-destructive/15",
  busy: "border-border bg-card text-foreground",
  offline: "border-warning/30 bg-warning/10 text-warning",
  ok: "border-border bg-card text-foreground",
};

const TONE_ICON = {
  attention: TriangleAlertIcon,
  busy: RefreshCwIcon,
  offline: CloudOffIcon,
  ok: CheckIcon,
};

const CHIP =
  "sync-status inline-flex h-5 min-w-0 max-w-full shrink items-center gap-1 whitespace-nowrap rounded-full border border-transparent pr-2 pl-1.5 font-medium text-xs leading-none no-underline [&>svg]:size-3 [&>svg]:shrink-0";

export function SyncStatusView({
  screen,
  snapshot,
}: {
  screen?: SyncStatusScreen;
  snapshot: RuntimeSnapshot;
}) {
  const label = syncStatusLabel(snapshot, screen);
  const Icon = TONE_ICON[label.tone];
  const content = (
    <>
      <Icon aria-hidden="true" />
      {/* one line; the ellipsis is only the last resort, for a chip alone on a line that is still too narrow */}
      <span
        aria-hidden="true"
        className="sync-status-short min-w-0 overflow-hidden text-ellipsis"
      >
        {label.short}
      </span>
      <span className="sr-only">{label.text}</span>
    </>
  );
  return label.attention ? (
    <a
      className={`${CHIP} touch-hit focus-ring ${TONE_CLASS[label.tone]}`}
      data-tone={label.tone}
      href="/attention"
      title={label.text}
    >
      {content}
    </a>
  ) : (
    <p
      className={`${CHIP} m-0 ${TONE_CLASS[label.tone]}`}
      data-tone={label.tone}
      role="status"
      title={label.text}
    >
      {content}
    </p>
  );
}

const LINE_TONE_CLASS: Record<SyncStatusLabel["tone"], string> = {
  attention: "bg-destructive/10 text-destructive",
  busy: "bg-muted text-foreground",
  offline: "bg-warning/10 text-warning",
  ok: "bg-muted text-foreground",
};

/**
 * The whole sentence of the state as the first line of "Mais", on the phone (a `title` does not show on touch;
 * on the desktop the sentence is the `title` of the chip). Hidden from assistive technology: the chip already
 * says the same thing.
 */
export function SyncStatusMenuLineView({
  screen,
  snapshot,
}: {
  screen?: SyncStatusScreen;
  snapshot: RuntimeSnapshot;
}) {
  const label = syncStatusLabel(snapshot, screen);
  const Icon = TONE_ICON[label.tone];
  return (
    <p
      aria-hidden="true"
      className={`sync-status-menu-line m-0 flex items-center gap-2 rounded-md px-3 py-2 font-medium text-sm [overflow-wrap:anywhere] [&>svg]:size-4 [&>svg]:shrink-0 ${LINE_TONE_CLASS[label.tone]}`}
      data-tone={label.tone}
    >
      <Icon />
      {label.text}
    </p>
  );
}

export function SyncStatusMenuLine(screen: SyncStatusScreen) {
  const snapshot = useRuntimeSnapshot();
  return snapshot ? (
    <SyncStatusMenuLineView screen={screen} snapshot={snapshot} />
  ) : null;
}

/** The header chip; renders nothing when the offline runtime is not enabled. */
export function SyncStatus(screen: SyncStatusScreen) {
  const snapshot = useRuntimeSnapshot();
  return snapshot ? (
    <SyncStatusView screen={screen} snapshot={snapshot} />
  ) : null;
}
