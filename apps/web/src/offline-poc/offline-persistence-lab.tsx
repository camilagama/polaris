import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { useLiveQuery } from "@tanstack/react-db";
import type { OfflineTransaction } from "@tanstack/offline-transactions";
import {
  clearOfflinePocStorage,
  copyLegacyNotesToV2,
  createOfflinePocRuntime,
  getMockServerReceiptCount,
  inspectOfflinePocCapabilities,
  OFFLINE_POC_DATABASE_FILE,
  resumeOfflinePocResetIfNeeded,
  queueOfflineNote,
  removeOfflinePocDatabaseFile,
  SHARED_RECORD_ID,
  writeSharedNote,
  type OfflineNoteV1,
  type OfflineNoteV2,
  type OfflinePocMigrationResult,
  type OfflinePocRuntime,
} from "./runtime";
import "./offline-poc.css";

const EVICTION_RECOVERY_KEY = "polaris-pr12-offline-poc-eviction";
const BFCACHE_RECOVERY_KEY = "polaris-pr12-offline-poc-bfcache";

function getReleaseVersion(): 1 | 2 {
  return new URLSearchParams(window.location.search).get("release") === "2"
    ? 2
    : 1;
}

function getTabId() {
  return crypto.randomUUID().slice(0, 8);
}

function useOfflineRuntime(release: 1 | 2) {
  const [runtime, setRuntime] = useState<OfflinePocRuntime | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runtimeRef = useRef<OfflinePocRuntime | null>(null);

  useEffect(() => {
    let cancelled = false;

    const initializeRuntime = async () => {
      try {
        await resumeOfflinePocResetIfNeeded();
        const createdRuntime = await createOfflinePocRuntime(release);
        if (cancelled) {
          await createdRuntime.close();
          return;
        }
        runtimeRef.current = createdRuntime;
        setRuntime(createdRuntime);
      } catch (reason: unknown) {
        if (!cancelled) {
          setError(
            reason instanceof Error
              ? reason.message
              : "Falha ao inicializar as persistências do laboratório."
          );
        }
      }
    };

    initializeRuntime().catch(() => undefined);

    return () => {
      cancelled = true;
      const activeRuntime = runtimeRef.current;
      runtimeRef.current = null;
      activeRuntime?.close().catch(() => undefined);
    };
  }, [release]);

  return { error, runtime };
}

function useLabSnapshot(runtime: OfflinePocRuntime) {
  const [snapshot, setSnapshot] = useState<LabSnapshot>({
    actualBrowserOnline: navigator.onLine,
    loaded: false,
    mockOnline: runtime.onlineDetector.isOnline(),
    mockServerReceipts: 0,
    outbox: [],
    offlineEnabled: runtime.executor.isOfflineEnabled,
    refreshFailure: null,
    storageFailure: runtime.diagnostics.storageFailure ?? null,
    unknownMutation:
      runtime.diagnostics.unknownMutation?.mutationFnName ?? null,
  });

  const refresh = useCallback(async () => {
    try {
      const [outbox, mockServerReceipts] = await Promise.all([
        runtime.executor.peekOutbox(),
        getMockServerReceiptCount(runtime.mockServerStorage),
      ]);
      setSnapshot({
        actualBrowserOnline: navigator.onLine,
        loaded: true,
        mockOnline: runtime.onlineDetector.isOnline(),
        mockServerReceipts,
        outbox,
        offlineEnabled: runtime.executor.isOfflineEnabled,
        refreshFailure: null,
        storageFailure: runtime.diagnostics.storageFailure ?? null,
        unknownMutation:
          runtime.diagnostics.unknownMutation?.mutationFnName ?? null,
      });
    } catch (error) {
      setSnapshot((current) => ({
        ...current,
        refreshFailure:
          error instanceof Error
            ? error.message
            : "Falha ao ler o estado atual do outbox.",
      }));
    }
  }, [runtime]);

  useEffect(() => {
    refresh();
    const intervalId = window.setInterval(refresh, 500);
    const onBrowserNetworkChange = () => refresh();
    window.addEventListener("online", onBrowserNetworkChange);
    window.addEventListener("offline", onBrowserNetworkChange);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("online", onBrowserNetworkChange);
      window.removeEventListener("offline", onBrowserNetworkChange);
    };
  }, [refresh]);

  return { refresh, snapshot };
}

export function OfflinePersistenceLab() {
  const release = getReleaseVersion();
  const { error, runtime } = useOfflineRuntime(release);
  const [lifecycleMessage, setLifecycleMessage] = useState("");

  useEffect(() => {
    if (sessionStorage.getItem(BFCACHE_RECOVERY_KEY) === "reload") {
      sessionStorage.removeItem(BFCACHE_RECOVERY_KEY);
      setLifecycleMessage(
        "O navegador restaurou a página pelo BFCache; o laboratório recarregou para abrir conexões OPFS novas."
      );
    }
    if (sessionStorage.getItem(EVICTION_RECOVERY_KEY) === "awaiting") {
      setLifecycleMessage(
        "Eviction OPFS simulada. Compare as notas recuperadas e a outbox abaixo; o teste não presume que todo o armazenamento do navegador seja imune a eviction."
      );
      sessionStorage.removeItem(EVICTION_RECOVERY_KEY);
    }

    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        sessionStorage.setItem(BFCACHE_RECOVERY_KEY, "reload");
        window.location.reload();
      }
    };

    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  if (error) {
    return (
      <main className="offline-lab-shell">
        <header className="offline-lab-header">
          <p className="offline-lab-eyebrow">Polaris · PR12</p>
          <h1>Persistência offline</h1>
        </header>
        <section
          className="offline-lab-panel offline-lab-panel-error"
          role="alert"
        >
          <h2>Persistência indisponível</h2>
          <p>{error}</p>
          <p>
            O laboratório não substitui OPFS ou IndexedDB por memória e não
            declara a prova aprovada quando o armazenamento durável falha.
          </p>
        </section>
      </main>
    );
  }

  if (!runtime) {
    return (
      <main className="offline-lab-shell">
        <header className="offline-lab-header">
          <p className="offline-lab-eyebrow">Polaris · PR12</p>
          <h1>Persistência offline</h1>
        </header>
        <p aria-live="polite" className="offline-lab-status">
          Abrindo OPFS, SQLite e IndexedDB…
        </p>
      </main>
    );
  }

  return (
    <OfflinePersistenceLabReady
      lifecycleMessage={lifecycleMessage}
      release={release}
      runtime={runtime}
    />
  );
}

interface OfflinePersistenceLabReadyProps {
  lifecycleMessage: string;
  release: 1 | 2;
  runtime: OfflinePocRuntime;
}

interface LabSnapshot {
  actualBrowserOnline: boolean;
  loaded: boolean;
  mockOnline: boolean;
  mockServerReceipts: number;
  outbox: OfflineTransaction[];
  offlineEnabled: boolean;
  refreshFailure: string | null;
  storageFailure: string | null;
  unknownMutation: string | null;
}

type Feedback = (message: string) => void;

function OfflinePersistenceLabReady({
  lifecycleMessage,
  release,
  runtime,
}: OfflinePersistenceLabReadyProps) {
  const [tabId] = useState(getTabId);
  const [actionMessage, setActionMessage] = useState("");
  const [actionError, setActionError] = useState("");
  const { refresh, snapshot } = useLabSnapshot(runtime);
  const reportMessage = useCallback<Feedback>((message) => {
    setActionError("");
    setActionMessage(message);
  }, []);
  const reportError = useCallback<Feedback>((message) => {
    setActionError(message);
  }, []);

  return (
    <main className="offline-lab-shell">
      <LabHeader release={release} />
      <CapabilitiesPanel
        onMessage={reportMessage}
        refresh={refresh}
        runtime={runtime}
        snapshot={snapshot}
      />
      <OutboxPanel
        onError={reportError}
        onMessage={reportMessage}
        refresh={refresh}
        release={release}
        runtime={runtime}
        snapshot={snapshot}
      />
      <LocalDataPanel
        onError={reportError}
        onMessage={reportMessage}
        release={release}
        runtime={runtime}
        tabId={tabId}
      />
      <ResiliencePanel
        onError={reportError}
        release={release}
        runtime={runtime}
        snapshot={snapshot}
      />
      <LabFeedback
        actionError={actionError}
        actionMessage={actionMessage}
        lifecycleMessage={lifecycleMessage}
        refreshFailure={snapshot.refreshFailure}
      />
    </main>
  );
}

function LabHeader({ release }: { release: 1 | 2 }) {
  return (
    <header className="offline-lab-header">
      <p className="offline-lab-eyebrow">Polaris · POC de fundação · PR12</p>
      <h1>Persistência offline</h1>
      <p>
        Dados sintéticos em OPFS/SQLite e uma outbox IndexedDB. Não há API,
        Neon, autenticação ou entidades reais nesta página.
      </p>
      <div className="offline-lab-header-actions">
        <span className="offline-lab-version">Release simulada v{release}</span>
        {release === 1 ? (
          <a className="offline-lab-link-button" href="/offline-poc?release=2">
            Simular atualização para v2
          </a>
        ) : (
          <a className="offline-lab-link-button" href="/offline-poc?release=1">
            Reabrir release v1
          </a>
        )}
      </div>
    </header>
  );
}

interface CapabilitiesPanelProps {
  onMessage: Feedback;
  refresh: () => Promise<void>;
  runtime: OfflinePocRuntime;
  snapshot: LabSnapshot;
}

function CapabilitiesPanel({
  onMessage,
  refresh,
  runtime,
  snapshot,
}: CapabilitiesPanelProps) {
  const capabilities = inspectOfflinePocCapabilities();
  const toggleMockServer = useCallback(() => {
    const nextOnline = !snapshot.mockOnline;
    runtime.onlineDetector.setOnline(nextOnline);
    onMessage(
      `Mock server ${nextOnline ? "online" : "offline"}; a rede real do navegador aparece separadamente.`
    );
    refresh();
  }, [onMessage, refresh, runtime, snapshot.mockOnline]);

  return (
    <section
      aria-label="Capacidades do navegador"
      className="offline-lab-panel"
    >
      <h2>Capacidades</h2>
      <dl className="offline-lab-grid">
        <StatusValue
          label="Contexto seguro"
          value={capabilities.secureContext}
        />
        <StatusValue label="OPFS" value={capabilities.opfs} />
        <StatusValue label="IndexedDB" value={capabilities.indexedDb} />
        <StatusValue
          label="BroadcastChannel"
          value={capabilities.broadcastChannel}
        />
        <StatusValue label="Web Locks" value={capabilities.webLocks} />
        <StatusValue
          label="Offline outbox líder"
          value={snapshot.offlineEnabled}
          testId="offline-enabled"
        />
        <StatusValue
          label="Rede real do navegador"
          value={snapshot.actualBrowserOnline}
          testId="browser-network"
        />
        <StatusValue
          label="Mock server"
          testId="mock-online"
          value={snapshot.mockOnline}
        />
      </dl>
      <p className="offline-lab-muted">
        O modo do mock server controla apenas o replay do outbox. O estado da
        rede do navegador é independente.
      </p>
      <button onClick={toggleMockServer} type="button">
        Colocar mock server {snapshot.mockOnline ? "offline" : "online"}
      </button>
    </section>
  );
}

interface OutboxPanelProps {
  onError: Feedback;
  onMessage: Feedback;
  refresh: () => Promise<void>;
  release: 1 | 2;
  runtime: OfflinePocRuntime;
  snapshot: LabSnapshot;
}

function OutboxPanel({
  onError,
  onMessage,
  refresh,
  release,
  runtime,
  snapshot,
}: OutboxPanelProps) {
  const [title, setTitle] = useState("");
  const handleTitleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setTitle(event.currentTarget.value);
    },
    []
  );
  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!snapshot.offlineEnabled) {
        onError(
          "Esta aba não é a líder do outbox. O executor oferece gravação offline somente à aba líder."
        );
        return;
      }

      const noteTitle =
        title.trim() || `Nota de teste ${new Date().toLocaleTimeString()}`;
      const now = new Date().toISOString();
      const note: OfflineNoteV1 | OfflineNoteV2 =
        release === 1
          ? {
              createdAt: now,
              formatVersion: 1,
              id: crypto.randomUUID(),
              origin: "created",
              title: noteTitle,
            }
          : {
              category: "created-in-v2",
              createdAt: now,
              formatVersion: 2,
              id: crypto.randomUUID(),
              origin: "created",
              title: noteTitle,
            };

      try {
        const { idempotencyKey } = await queueOfflineNote(runtime, note);
        setTitle("");
        onMessage(
          `Mutation ${idempotencyKey} está confirmada no outbox local; o mock server está ${snapshot.mockOnline ? "online" : "offline"}.`
        );
        await refresh();
      } catch (error) {
        onError(
          error instanceof Error
            ? error.message
            : "Não foi possível persistir a mutation offline."
        );
      }
    },
    [
      onError,
      onMessage,
      refresh,
      release,
      runtime,
      snapshot.mockOnline,
      snapshot.offlineEnabled,
      title,
    ]
  );

  return (
    <section aria-label="Outbox durável" className="offline-lab-panel">
      <h2>Outbox durável</h2>
      <p>
        Mutações offline só são admitidas pela aba líder. O outbox usa IndexedDB
        explicitamente; o laboratório não aceita fallback para localStorage nem
        sucesso em memória.
      </p>
      <form className="offline-lab-form" onSubmit={handleSubmit}>
        <label htmlFor="offline-note-title">Título da nota sintética</label>
        <input
          id="offline-note-title"
          onChange={handleTitleChange}
          placeholder="Ex.: anotação offline"
          value={title}
        />
        <button disabled={!snapshot.offlineEnabled} type="submit">
          Gravar mutation offline
        </button>
      </form>
      <p aria-live="polite" className="offline-lab-counts">
        Pendentes no outbox:{" "}
        <strong data-testid="outbox-count">{snapshot.outbox.length}</strong> ·
        Receipts idempotentes do mock server:{" "}
        <strong data-testid="mock-server-receipts">
          {snapshot.mockServerReceipts}
        </strong>
      </p>
      {snapshot.outbox.length > 0 ? (
        <ul className="offline-lab-list">
          {snapshot.outbox.map((transaction) => (
            <li key={transaction.id}>
              <code>{transaction.idempotencyKey}</code> ·{" "}
              {transaction.mutationFnName} · {transaction.mutations.length}{" "}
              mutation(s)
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

interface LocalDataPanelProps {
  onError: Feedback;
  onMessage: Feedback;
  release: 1 | 2;
  runtime: OfflinePocRuntime;
  tabId: string;
}

function LocalDataPanel({
  onError,
  onMessage,
  release,
  runtime,
  tabId,
}: LocalDataPanelProps) {
  const [migrationResult, setMigrationResult] =
    useState<OfflinePocMigrationResult | null>(null);
  const v1Query = useLiveQuery({
    query: (q) => q.from({ note: runtime.notesV1 }),
  });
  const v1Notes = v1Query.data ?? [];

  const handleSharedWrite = useCallback(async () => {
    try {
      const title = await writeSharedNote(runtime, tabId);
      onMessage(
        `${title} foi persistida localmente. Compare o mesmo registro na outra aba.`
      );
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "A gravação concorrente falhou."
      );
    }
  }, [onError, onMessage, runtime, tabId]);

  const handleMigration = useCallback(async () => {
    try {
      const result = await copyLegacyNotesToV2(runtime);
      setMigrationResult(result);
      onMessage(
        `Migração local idempotente: ${result.copied} registro(s) copiado(s); v1 permanece disponível para rollback.`
      );
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "A migração local falhou."
      );
    }
  }, [onError, onMessage, runtime]);

  return (
    <section aria-label="Dados persistidos" className="offline-lab-panel">
      <h2>Dados locais</h2>
      {v1Query.isError ? (
        <p className="offline-lab-error" role="alert">
          A coleção v1 retornou erro: {String(v1Query.status)}
        </p>
      ) : null}
      <p>
        OPFS database: <code>{OFFLINE_POC_DATABASE_FILE}</code>
      </p>
      <p>
        Coleção v1 (schemaVersion 1):{" "}
        <strong data-testid="v1-count">{v1Notes.length}</strong> registro(s)
      </p>
      <ul className="offline-lab-list">
        {v1Notes.map((note) => (
          <li
            data-note-id={note.id}
            data-testid={
              note.id === SHARED_RECORD_ID ? "shared-record-v1" : undefined
            }
            key={note.id}
          >
            {note.title} <span className="offline-lab-muted">({note.id})</span>
          </li>
        ))}
      </ul>
      <button onClick={handleSharedWrite} type="button">
        Editar registro compartilhado pela aba {tabId}
      </button>
      {release === 2 && runtime.notesV2 ? (
        <VersionTwoPanel
          collection={runtime.notesV2}
          migrationResult={migrationResult}
          onMigrate={handleMigration}
          runtime={runtime}
          sourceCount={v1Notes.length}
        />
      ) : null}
    </section>
  );
}

interface VersionTwoPanelProps {
  collection: NonNullable<OfflinePocRuntime["notesV2"]>;
  migrationResult: OfflinePocMigrationResult | null;
  onMigrate: () => void;
  runtime: OfflinePocRuntime;
  sourceCount: number;
}

function VersionTwoPanel({
  collection,
  migrationResult,
  onMigrate,
  runtime,
  sourceCount,
}: VersionTwoPanelProps) {
  const query = useLiveQuery({ query: (q) => q.from({ note: collection }) });
  const notes = query.data ?? [];

  return (
    <div className="offline-lab-subpanel">
      <h3>Release v2 (schemaVersion 2)</h3>
      <p>
        Registros atuais: <strong data-testid="v2-count">{notes.length}</strong>
      </p>
      <ul className="offline-lab-list">
        {notes.map((note) => (
          <li
            data-note-id={note.id}
            data-testid={
              note.id === SHARED_RECORD_ID ? "shared-record-v2" : undefined
            }
            key={note.id}
          >
            {note.title} · {note.category} ·{" "}
            <span className="offline-lab-muted">{note.origin}</span>
          </li>
        ))}
      </ul>
      <button
        disabled={!runtime.executor.isOfflineEnabled || sourceCount === 0}
        onClick={onMigrate}
        type="button"
      >
        Copiar v1→v2 (idempotente; preserva v1)
      </button>
      <p className="offline-lab-muted">
        {migrationResult
          ? `Última cópia: ${migrationResult.copied} registro(s).`
          : "A migração usa IDs de coleção versionados; o pacote não transforma dados automaticamente ao mudar schemaVersion."}
      </p>
    </div>
  );
}

interface ResiliencePanelProps {
  onError: Feedback;
  release: 1 | 2;
  runtime: OfflinePocRuntime;
  snapshot: LabSnapshot;
}

function ResiliencePanel({
  onError,
  release,
  runtime,
  snapshot,
}: ResiliencePanelProps) {
  const handleEviction = useCallback(async () => {
    if (snapshot.outbox.length === 0) {
      onError("Crie primeiro uma mutation pendente para testar a recuperação.");
      return;
    }
    try {
      sessionStorage.setItem(EVICTION_RECOVERY_KEY, "awaiting");
      await removeOfflinePocDatabaseFile(runtime);
      window.location.reload();
    } catch (error) {
      sessionStorage.removeItem(EVICTION_RECOVERY_KEY);
      onError(
        error instanceof Error
          ? error.message
          : "A simulação de eviction falhou."
      );
    }
  }, [onError, runtime, snapshot.outbox.length]);

  const handleReset = useCallback(async () => {
    try {
      await clearOfflinePocStorage(runtime);
      sessionStorage.removeItem(EVICTION_RECOVERY_KEY);
      window.location.reload();
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Não foi possível limpar os dados sintéticos."
      );
    }
  }, [onError, runtime]);

  return (
    <section aria-label="Resiliência" className="offline-lab-panel">
      <h2>Resiliência e limitações observáveis</h2>
      <p>
        Após criar uma mutation pendente, encerre o navegador pelo sistema e
        reabra este endereço para provar recuperação dos registros e do outbox.
      </p>
      <p>
        A simulação de eviction remove somente o arquivo OPFS do laboratório;
        preserva a outbox IndexedDB para verificar se mutations pendentes
        reconstroem registros locais.
      </p>
      <p className="offline-lab-muted">
        As operações alteram apenas dados sintéticos do laboratório. Feche
        outras abas antes de limpar ou simular eviction.
      </p>
      <div className="offline-lab-actions">
        <button
          disabled={release !== 1 || snapshot.outbox.length === 0}
          onClick={handleEviction}
          type="button"
        >
          Simular eviction do arquivo OPFS
        </button>
        <button
          className="offline-lab-danger"
          onClick={handleReset}
          type="button"
        >
          Limpar dados sintéticos
        </button>
      </div>
      {snapshot.storageFailure ? (
        <p className="offline-lab-error" role="alert">
          Falha do outbox: {snapshot.storageFailure}
        </p>
      ) : null}
      {snapshot.unknownMutation ? (
        <p className="offline-lab-error" role="alert">
          Mutation antiga sem handler: {snapshot.unknownMutation}
        </p>
      ) : null}
    </section>
  );
}

function LabFeedback({
  actionError,
  actionMessage,
  lifecycleMessage,
  refreshFailure,
}: {
  actionError: string;
  actionMessage: string;
  lifecycleMessage: string;
  refreshFailure: string | null;
}) {
  return (
    <>
      {lifecycleMessage ? (
        <p className="offline-lab-status" role="status">
          {lifecycleMessage}
        </p>
      ) : null}
      {actionMessage ? (
        <p className="offline-lab-status" role="status">
          {actionMessage}
        </p>
      ) : null}
      {actionError ? (
        <p className="offline-lab-error" role="alert">
          {actionError}
        </p>
      ) : null}
      {refreshFailure ? (
        <p className="offline-lab-error" role="alert">
          {refreshFailure}
        </p>
      ) : null}
    </>
  );
}

function StatusValue({
  label,
  testId,
  value,
}: {
  label: string;
  testId?: string;
  value: boolean;
}) {
  return (
    <div className="offline-lab-status-value">
      <dt>{label}</dt>
      <dd
        className={value ? "is-available" : "is-unavailable"}
        data-testid={testId}
      >
        {value ? "Disponível" : "Indisponível"}
      </dd>
    </div>
  );
}
