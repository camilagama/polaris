import type { CategoryReadModel } from "@polaris/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { canManageBilling } from "../../lib/billing-access";
import { browserConnection } from "../../lib/browser-connection";
import { useCurrentOrganization } from "../../lib/current-organization";
import { calendarDayInTimezone } from "../../lib/dates";
import { orpcClient } from "../../lib/orpc";
import { readErrorMessage } from "../../lib/rpc-error";
import { useHoldSwap } from "../../lib/unsent-work";
import type { OfflineRuntime } from "../../offline/runtime/offline-runtime";
import { useOfflineRuntime } from "../../offline/runtime/runtime-context";
import { waitingOperations } from "../../offline/runtime/sync-status";
import {
  type LimitHelpView,
  limitHelpFor,
} from "../../subscription/limit-help-model";
import {
  IMPORT_FILE_PROBLEM_MESSAGES,
  previewImport,
} from "../product-import-rows";
import {
  announceEnteredProduct,
  createImportRun,
  type ImportRun,
  runImport,
  skipStuckRow,
} from "../product-import-send";
import {
  type ImportPlan,
  type ImportStep,
  planImport,
  planRoom,
  readImportFile,
  stepAfter,
  tillIsFailing,
} from "./import-model";

/**
 * The state of one import in the dialog: the file chosen, its plan (read and checked here, nothing sent), and the run
 * that sends it. Everything lives in memory while the dialog's page is open (AC-7): closing the dialog keeps it,
 * leaving the page drops it. A stop that may have left rows on their way (no answer, the connection gone) keeps the
 * run, so "Continuar de onde parou" sends the same rows with the same IDs (AC-5, AC-10). A cut of the platform never
 * stops it: the run pauses (`paused_busy`) and goes on by itself, and it pauses the same way while the tab's own
 * sales are failing to go or its reads are dying (`tillFailing`).
 */

export type { ImportPause, ImportStep } from "./import-model";

/** A run that stops with no answer while the connection holds is continued by the screen this many times in a row. */
const AUTO_CONTINUES = 2;

interface Pace {
  /** The answered rows when the run (or its continuation) started. */
  fromIndex: number;
  startedAt: number;
}

export interface ProductImportState {
  file: File | null;
  /** The problem of the whole file, or of reading the store's names: said on the step of the file. */
  fileProblem: string | null;
  /** What goes with the notice of the plan's limit (corte 1.6), from the same read of the plan. */
  limitHelp: LimitHelpView | null;
  pace: Pace | null;
  plan: ImportPlan | null;
  reading: boolean;
  run: ImportRun | null;
  /** The day of the store on this device when the import was confirmed: the result says the date of the stock. */
  startedOn: string | null;
  step: ImportStep;
}

export interface ProductImportActions {
  back: () => void;
  chooseFile: (file: File | null) => void;
  confirm: () => void;
  continueRun: () => void;
  finish: () => void;
  readFile: () => void;
  reset: () => void;
  /** "Pular a linha N": leaves out the row the server never answered (not confirmed) and goes on from the next. */
  skip: () => void;
  stop: () => void;
}

function tillFailing(runtime: OfflineRuntime | null): boolean {
  const snapshot = runtime?.getSnapshot() ?? null;
  return tillIsFailing({
    quietRetries: runtime?.retriesQuietly() ?? false,
    reason: snapshot?.reason ?? null,
    serverFailing: browserConnection.isServerFailing(),
    waiting: snapshot ? waitingOperations(snapshot) : 0,
  });
}

interface Options {
  categories: readonly CategoryReadModel[];
  /** The run stopped (or ended) with rows answered: the screen reads its products again. */
  onEntered: () => void;
  online: boolean;
}

export function useProductImport({
  categories,
  onEntered,
  online,
}: Options): [ProductImportState, ProductImportActions] {
  const { billingSelfService, organization, organizationId } =
    useCurrentOrganization();
  const [state, setState] = useState<ProductImportState>({
    file: null,
    fileProblem: null,
    limitHelp: null,
    pace: null,
    plan: null,
    reading: false,
    run: null,
    startedOn: null,
    step: { kind: "file" },
  });
  // the run's own progress re-renders the step: the run is mutated in place by `runImport`
  const [, setTick] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  const abortedForRef = useRef<"offline" | "stopped" | null>(null);
  const onlineRef = useRef(online);
  onlineRef.current = online;
  const enteredRef = useRef(onEntered);
  enteredRef.current = onEntered;
  const runtimeRef = useRef<OfflineRuntime | null>(null);
  runtimeRef.current = useOfflineRuntime();
  // a read of the file answered after another file was chosen, or after the dialog started over, is dropped
  const readingRef = useRef(0);

  const chooseFile = useCallback((file: File | null) => {
    readingRef.current += 1;
    setState((current) => ({
      ...current,
      file,
      fileProblem: null,
      plan: null,
      reading: false,
    }));
  }, []);

  const readFile = useCallback(() => {
    const { file } = state;
    if (file === null) {
      return;
    }
    readingRef.current += 1;
    const ask = readingRef.current;
    setState((current) => ({ ...current, fileProblem: null, reading: true }));
    const done = (next: Partial<ProductImportState>) => {
      if (ask === readingRef.current) {
        setState((current) => ({ ...current, reading: false, ...next }));
      }
    };
    readPlan({
      billingSelfService,
      categories,
      file,
      organizationId,
      role: organization.role,
    })
      .then((read) =>
        "problem" in read
          ? done({ fileProblem: read.problem })
          : done({
              limitHelp: read.limitHelp,
              plan: read.plan,
              step: { kind: "preview" },
            })
      )
      .catch((cause: unknown) =>
        done({ fileProblem: readErrorMessage(cause, "os produtos da loja") })
      );
  }, [
    billingSelfService,
    categories,
    organization.role,
    organizationId,
    state,
  ]);

  const start = useCallback(
    async (run: ImportRun) => {
      if (controllerRef.current !== null) {
        return; // the run is on its way already: a second start would send its rows twice
      }
      let continues = 0;
      for (;;) {
        const controller = new AbortController();
        controllerRef.current = controller;
        abortedForRef.current = null;
        const fromIndex = run.nextIndex;
        setState((current) => ({
          ...current,
          pace: { fromIndex: run.nextIndex, startedAt: Date.now() },
          step: { kind: "running" },
        }));
        // biome-ignore lint/performance/noAwaitInLoops: one run at a time; a stop with no answer continues it
        const stop = await runImport(run, {
          busy: () => tillFailing(runtimeRef.current),
          onPause: (resumeAt) => {
            if (controllerRef.current === controller) {
              setState((current) => ({
                ...current,
                step:
                  resumeAt === null
                    ? { kind: "running" }
                    : { kind: "paused_busy", resumeAt },
              }));
            }
          },
          onProgress: () => {
            announceEnteredProduct(run, organizationId);
            setTick((count) => count + 1);
          },
          organizationId,
          retryAfterMs: browserConnection.takeRetryAfterMs,
          send: (input) => orpcClient.product.importBatch(input),
          signal: controller.signal,
        });
        if (controllerRef.current !== controller) {
          return; // the dialog started over, or the page left
        }
        controllerRef.current = null;
        const next = stepAfter(stop, abortedForRef.current, onlineRef.current);
        // a row that kept failing alone while the connection holds: the same row again, a few times, then the pause
        continues = run.nextIndex > fromIndex ? 1 : continues + 1;
        if (next === "continue" && continues <= AUTO_CONTINUES) {
          continue;
        }
        setState((current) => ({
          ...current,
          step:
            next === "continue"
              ? { kind: "paused", pause: { kind: "interrupted" } }
              : next,
        }));
        enteredRef.current();
        return;
      }
    },
    [organizationId]
  );

  const confirm = useCallback(() => {
    if (state.plan === null || state.plan.toSend.length === 0) {
      return;
    }
    const run = createImportRun(state.plan.toSend);
    const startedOn = calendarDayInTimezone(new Date(), organization.timezone);
    setState((current) => ({ ...current, run, startedOn }));
    start(run).catch(() => undefined);
  }, [organization.timezone, start, state.plan]);

  const continueRun = useCallback(() => {
    if (state.run !== null) {
      start(state.run).catch(() => undefined);
    }
  }, [start, state.run]);

  const skip = useCallback(() => {
    // only a paused run: the row on its way is never left out
    if (state.run === null || controllerRef.current !== null) {
      return;
    }
    skipStuckRow(state.run);
    start(state.run).catch(() => undefined);
  }, [start, state.run]);

  const stop = useCallback(() => {
    abortedForRef.current = "stopped";
    controllerRef.current?.abort();
  }, []);

  // the connection went during the run: it stops after the row on its way, and waits for "Continuar de onde parou"
  const running =
    state.step.kind === "running" || state.step.kind === "paused_busy";
  useEffect(() => {
    if (running && !online) {
      abortedForRef.current = "offline";
      controllerRef.current?.abort();
    }
  }, [online, running]);

  // the page left: nothing goes on sending without a screen to say it
  useEffect(
    () => () => {
      const controller = controllerRef.current;
      controllerRef.current = null;
      controller?.abort();
    },
    []
  );

  const reset = useCallback(() => {
    readingRef.current += 1;
    const controller = controllerRef.current;
    controllerRef.current = null;
    controller?.abort();
    setState({
      file: null,
      fileProblem: null,
      limitHelp: null,
      pace: null,
      plan: null,
      reading: false,
      run: null,
      startedOn: null,
      step: { kind: "file" },
    });
  }, []);

  const back = useCallback(
    () => setState((current) => ({ ...current, step: { kind: "file" } })),
    []
  );
  const finish = useCallback(
    () =>
      setState((current) => ({
        ...current,
        step: { kind: "result", limit: false },
      })),
    []
  );

  // a file chosen, read and not imported, or an import on its way (or paused) is work the page would lose
  useHoldSwap(
    (state.step.kind === "file" && state.file !== null) ||
      state.step.kind === "preview" ||
      state.step.kind === "running" ||
      state.step.kind === "paused_busy" ||
      state.step.kind === "paused"
  );

  const actions = useMemo(
    () => ({
      back,
      chooseFile,
      confirm,
      continueRun,
      finish,
      readFile,
      reset,
      skip,
      stop,
    }),
    [
      back,
      chooseFile,
      confirm,
      continueRun,
      finish,
      readFile,
      reset,
      skip,
      stop,
    ]
  );
  return [state, actions];
}

type PlanRead =
  | { problem: string }
  | { limitHelp: LimitHelpView | null; plan: ImportPlan };

/** Reads the file here, asks the store which names it has and the plan for its room: nothing is written. */
async function readPlan(input: {
  billingSelfService: boolean;
  categories: readonly CategoryReadModel[];
  file: File;
  organizationId: string;
  role: string;
}): Promise<PlanRead> {
  const read = await readImportFile(input.file);
  if (read.kind === "too_large") {
    return { problem: IMPORT_FILE_PROBLEM_MESSAGES.too_large };
  }
  const preview = previewImport(read.bytes, input.categories);
  if (preview.kind === "problem") {
    return { problem: IMPORT_FILE_PROBLEM_MESSAGES[preview.problem] };
  }
  const names = preview.ready.map((row) => row.name);
  const canManage = canManageBilling(input.billingSelfService, input.role);
  const [existing, plan] = await Promise.all([
    names.length === 0
      ? Promise.resolve({ names: [] })
      : orpcClient.product.namesExisting({
          names,
          organizationId: input.organizationId,
        }),
    // only who may see the plan reads it; the others meet the limit on the server, which stops there
    canManage
      ? orpcClient.billing
          .readPlan({ organizationId: input.organizationId })
          .catch(() => null)
      : Promise.resolve(null),
  ]);
  return {
    limitHelp: limitHelpFor({
      billingSelfService: input.billingSelfService,
      canManageBilling: canManage,
      plan,
      subject: "variants",
    }),
    plan: planImport(preview, existing.names, planRoom(plan)),
  };
}
