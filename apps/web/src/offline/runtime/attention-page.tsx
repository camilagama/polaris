import type { InventoryBalanceEntryReadModel } from "@polaris/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { navigateInApp } from "../../app-shell/address";
import { PageLoading } from "../../app-shell/page-loading";
import { canManageBilling } from "../../lib/billing-access";
import { useCurrentOrganization } from "../../lib/current-organization";
import { browserStorage } from "../../lib/current-organization-model";
import { orpcClient } from "../../lib/orpc";
import { readWithRetry } from "../../lib/read-with-retry";
import { signInPath } from "../../lib/sign-in-path";
import { sessionStorageOrNull } from "../../sales/sale-attempt-storage";
import { readSaleDraft, writeSaleDraft } from "../../sales/sale-draft-storage";
import {
  chunkIds,
  lineBalancesRequest,
} from "../../sales/sale-variant-picker-model";
import {
  type AttentionItem,
  type AttentionSummary,
  buildAttention,
  discardAttentionItem,
  resubmitAttentionItem,
} from "../attention";
import {
  type AttentionError,
  AttentionFrame,
  AttentionPanel,
  AttentionStateCard,
  AttentionUnavailable,
  type RedoProblem,
  signInAgainButtonId,
} from "../attention-panel";
import type { NamespaceKey } from "../namespace";
import type { Outbox } from "../outbox/outbox";
import {
  buildRedoDraft,
  REDO_ALREADY_MESSAGE,
  REDO_BLOCKED_MESSAGE,
  REDO_BUSY_MESSAGE,
  REDO_FAILED_MESSAGE,
  REDO_OFFLINE_MESSAGE,
  REDO_UNREADABLE_MESSAGE,
  variantIdsOf,
} from "../sale-redo";
import {
  pruneSaleRedos,
  readSaleRedos,
  redoneCommandIds,
  startSaleRedo,
} from "../sale-redo-storage";
import { LogoutNotices, useLogout } from "./logout-control";
import { PLAN_REFUSED_REASON } from "./offline-runtime";
import { useOfflineRuntime, useRuntimeSnapshot } from "./runtime-context";

/**
 * The page of operations that need attention (ADR 0038), over the runtime's real
 * outbox. It re-reads the queue whenever the runtime's figures change, so a sync
 * that clears or refuses something is reflected at once.
 */
const EMPTY: AttentionSummary = { items: [], waitingBehind: 0 };
const SALE_PATH = "/sales";
const newId = () => crypto.randomUUID();

/** The catalog and balance of each variant of the refused sale, as the server has them now. */
async function readLineEntries(
  organizationId: string,
  variantIds: readonly string[]
): Promise<InventoryBalanceEntryReadModel[]> {
  const pages = await Promise.all(
    chunkIds(variantIds).map((chunk) =>
      readWithRetry(() =>
        orpcClient.inventory.listBalances(
          lineBalancesRequest(organizationId, chunk)
        )
      )
    )
  );
  return pages.flatMap((page) => page.entries);
}

/** What the tab already holds in Vender: nothing, the redo of this refused sale, or another sale in progress. */
function openDraftOf(
  refusedCommandId: string,
  organizationId: string,
  namespaceKey: NamespaceKey,
  timezone: string | null
): "mine" | "none" | "other" {
  const draft = readSaleDraft(
    sessionStorageOrNull(),
    organizationId,
    new Date(),
    timezone
  );
  if (draft.kind !== "restored") {
    return "none";
  }
  const mine = readSaleRedos(browserStorage(), namespaceKey).some(
    (redo) =>
      redo.refusedCommandId === refusedCommandId &&
      redo.redoneCommandId === null &&
      redo.startedAt === draft.draft.startedAt
  );
  return mine ? "mine" : "other";
}

type RedoOutcome = "opened" | { lines?: RedoProblem["lines"]; message: string };

/**
 * Fills the draft of Vender with a refused sale, once the server confirms that every line can be sold as it was.
 * Nothing is removed from the queue; "opened" says Vender may be shown.
 */
async function redoSale(
  refusedCommandId: string,
  outbox: Outbox,
  organizationId: string,
  namespaceKey: NamespaceKey,
  timezone: string | null
): Promise<RedoOutcome> {
  const { commands } = await outbox.snapshot();
  const command = commands.find(
    (candidate) => candidate.commandId === refusedCommandId
  );
  if (!command) {
    return { message: REDO_FAILED_MESSAGE };
  }
  const open = openDraftOf(
    refusedCommandId,
    organizationId,
    namespaceKey,
    timezone
  );
  if (open !== "none") {
    return open === "mine" ? "opened" : { message: REDO_BUSY_MESSAGE };
  }
  let entries: InventoryBalanceEntryReadModel[];
  try {
    entries = await readLineEntries(organizationId, variantIdsOf(command));
  } catch {
    return { message: REDO_OFFLINE_MESSAGE };
  }
  const built = buildRedoDraft(command, entries, newId);
  if (built.kind === "unreadable") {
    return { message: REDO_UNREADABLE_MESSAGE };
  }
  if (built.kind === "blocked") {
    return { lines: built.problems, message: REDO_BLOCKED_MESSAGE };
  }
  const startedAt = new Date().toISOString();
  if (
    !startSaleRedo(browserStorage(), namespaceKey, refusedCommandId, startedAt)
  ) {
    return { message: REDO_ALREADY_MESSAGE };
  }
  writeSaleDraft(sessionStorageOrNull(), organizationId, {
    form: built.form,
    startedAt,
  });
  const written = readSaleDraft(
    sessionStorageOrNull(),
    organizationId,
    new Date(),
    timezone
  );
  return written.kind === "restored"
    ? "opened"
    : { message: REDO_FAILED_MESSAGE };
}

/** "Sair e entrar de novo": the queue is protected first, then the sign-in screen brings the person back here. */
const SIGN_IN_AGAIN = signInPath({ reason: "saiu", returnTo: "/attention" });

export function AttentionPage() {
  const runtime = useOfflineRuntime();
  const snapshot = useRuntimeSnapshot();
  const { billingSelfService, organization, organizationId } =
    useCurrentOrganization();
  const subscriptionAvailable = canManageBilling(
    billingSelfService,
    organization.role
  );
  const [redoProblem, setRedoProblem] = useState<RedoProblem | null>(null);
  const [summary, setSummary] = useState<AttentionSummary>(EMPTY);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<AttentionError | null>(null);
  const logout = useLogout(SIGN_IN_AGAIN);

  const counts = snapshot?.counts;
  useEffect(() => {
    const context = runtime?.context();
    const namespaceKey = runtime?.namespaceKey(organizationId) ?? null;
    if (!(context && namespaceKey)) {
      setSummary(EMPTY);
      return;
    }
    let current = true;
    context.outbox
      .snapshot()
      .then((queue) => {
        if (current) {
          pruneSaleRedos(
            browserStorage(),
            namespaceKey,
            new Set(queue.commands.map((command) => command.commandId))
          );
          setSummary(
            buildAttention(
              queue,
              redoneCommandIds(
                readSaleRedos(browserStorage(), namespaceKey),
                queue.commands
              ),
              { subscriptionAvailable }
            )
          );
        }
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
    // the figures change whenever the queue does
  }, [runtime, counts, organizationId, subscriptionAvailable]);

  const resolve = useCallback(
    async (item: AttentionItem, work: () => Promise<void>, message: string) => {
      setBusy(item.commandId);
      setError(null);
      try {
        await work();
        await runtime?.refreshCounts();
        runtime?.syncNow().catch(() => undefined);
      } catch {
        setError({ commandId: item.commandId, message });
      } finally {
        setBusy(null);
      }
    },
    [runtime]
  );

  const handleDiscard = useCallback(
    (item: AttentionItem) => {
      const context = runtime?.context();
      if (context) {
        resolve(
          item,
          () => discardAttentionItem(item, context),
          "Não foi possível descartar. Tente de novo."
        ).catch(() => undefined);
      }
    },
    [resolve, runtime]
  );
  const handleResubmit = useCallback(
    (item: AttentionItem) => {
      const context = runtime?.context();
      if (context) {
        resolve(
          item,
          () => resubmitAttentionItem(item, context),
          "Não foi possível reenviar. Tente de novo."
        ).catch(() => undefined);
      }
    },
    [resolve, runtime]
  );
  const handleRedo = useCallback(
    (item: AttentionItem) => {
      const context = runtime?.context();
      const namespaceKey = runtime?.namespaceKey(organizationId) ?? null;
      if (!(context && namespaceKey)) {
        return;
      }
      setRedoProblem(null);
      setError(null);
      setBusy(item.commandId);
      redoSale(
        item.commandId,
        context.outbox,
        organizationId,
        namespaceKey,
        organization.timezone
      )
        .catch((): RedoOutcome => ({ message: REDO_FAILED_MESSAGE }))
        .then((outcome) => {
          if (outcome === "opened") {
            navigateInApp(SALE_PATH);
          } else {
            setRedoProblem({
              commandId: item.commandId,
              lines: outcome.lines ?? [],
              message: outcome.message,
            });
          }
        })
        .finally(() => setBusy(null));
    },
    [organization.timezone, organizationId, runtime]
  );
  const { blocked, start: startLogout } = logout;
  const signInFrom = useRef<string | null>(null);
  const wasBlocked = useRef<boolean>(false);
  const handleSignInAgain = useCallback(
    (item: AttentionItem) => {
      signInFrom.current = item.commandId;
      setError(null);
      startLogout();
    },
    [startLogout]
  );
  // the panel that said what the sign-out would lose is gone once the person keeps the session: the focus goes back to
  // the button that asked
  useEffect(() => {
    if (blocked) {
      wasBlocked.current = true;
    } else if (wasBlocked.current && signInFrom.current) {
      wasBlocked.current = false;
      document.getElementById(signInAgainButtonId(signInFrom.current))?.focus();
    }
  }, [blocked]);

  if (!(runtime && snapshot)) {
    return (
      <AttentionFrame>
        <AttentionStateCard>
          O modo offline não está ativo neste aparelho.
        </AttentionStateCard>
      </AttentionFrame>
    );
  }
  if (snapshot.phase === "unavailable") {
    return (
      <AttentionUnavailable
        planRefused={snapshot.reason === PLAN_REFUSED_REASON}
      />
    );
  }
  if (snapshot.phase !== "ready") {
    return <PageLoading label="Preparando o modo offline…" />;
  }
  return (
    <AttentionPanel
      busyCommandId={busy}
      error={error}
      notices={<LogoutNotices inAttentionPage logout={logout} />}
      onDiscard={handleDiscard}
      onRedo={handleRedo}
      onResubmit={handleResubmit}
      onSignInAgain={handleSignInAgain}
      redoProblem={redoProblem}
      signingOut={logout.busy}
      summary={summary}
    />
  );
}
