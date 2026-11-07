import { useEffect, useSyncExternalStore } from "react";
import { calendarDayInTimezone, clockPartsInTimezone } from "../lib/dates";
import { getUpdateStore } from "../pwa/runtime";
import type { UpdateSnapshot, UpdateStore } from "../pwa/update-store";

/**
 * The only place that speaks of the version (ADR 0041): the build swaps by itself and says
 * nothing, so whoever looks for it (or the support asking "que versão aparece aí?") finds it at the foot of
 * Configurações, with the new build that waits and what it waits for. No button and no colour of a notice.
 */
const PUBLISHED_ZONE = "America/Sao_Paulo";
const LINK =
  "focus-ring rounded-sm underline decoration-input underline-offset-4 hover:decoration-foreground";

/**
 * "Versão 2026.10.28 14:30 (a1b2c3) · atualizado em 28/10": the day and the time of the publication in São Paulo, the
 * start of the id (to tell, in the triage of a fix, whether this device has it) and when it went in on this device;
 * the id alone when the build carries no time; null without a worker.
 */
export function versionText(current: UpdateSnapshot["current"]): string | null {
  if (!current) {
    return null;
  }
  const name =
    current.publishedAt === null
      ? current.id
      : `${calendarDayInTimezone(
          new Date(current.publishedAt),
          PUBLISHED_ZONE
        ).replaceAll(
          "-",
          "."
        )} ${clockPartsInTimezone(new Date(current.publishedAt), PUBLISHED_ZONE).time} (${current.id.slice(0, 6)})`;
  const updated =
    current.activatedAt === null
      ? ""
      : ` · atualizado em ${clockPartsInTimezone(new Date(current.activatedAt), null).date.slice(0, 5)}`;
  return `Versão ${name}${updated}`;
}

export function AppVersionLineView({ snapshot }: { snapshot: UpdateSnapshot }) {
  const version = versionText(snapshot.current);
  const waiting = snapshot.pending !== null;
  if (!(version || waiting)) {
    return null;
  }
  return (
    <div
      className="mt-10 grid gap-1 text-muted-foreground text-support"
      id="versao-do-app"
    >
      {version ? <p className="m-0">{version}</p> : null}
      {waiting && snapshot.work.rejected > 0 ? (
        <p className="m-0">
          Nova versão pronta. Entra depois que as pendências forem resolvidas.{" "}
          <a className={LINK} href="/attention">
            Ver pendências
          </a>
        </p>
      ) : null}
      {waiting && snapshot.work.rejected === 0 ? (
        <p className="m-0">
          Nova versão pronta. Entra sozinha quando você fechar o app ou deixá-lo
          parado um tempo.
        </p>
      ) : null}
    </div>
  );
}

const READ_QUEUE_EVERY_MS = 15_000;

function ConnectedVersionLine({ store }: { store: UpdateStore }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const waiting = snapshot.pending !== null;
  // while a build waits, the line says whether refused records hold it: the queue is read again now and then
  useEffect(() => {
    if (!waiting) {
      return;
    }
    store.refreshWork().catch(() => undefined);
    const timer = setInterval(() => {
      store.refreshWork().catch(() => undefined);
    }, READ_QUEUE_EVERY_MS);
    return () => clearInterval(timer);
  }, [store, waiting]);
  return <AppVersionLineView snapshot={snapshot} />;
}

/** The line of this page's update store; nothing where there is no service worker. */
export function AppVersionLine() {
  const store = getUpdateStore();
  return store ? <ConnectedVersionLine store={store} /> : null;
}
