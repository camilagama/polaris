import type {
  InventoryBalanceEntryReadModel,
  PaymentProfileReadModel,
} from "@polaris/contracts";
import { hasCapabilityForRole } from "@polaris/domain/authorization/capabilities";
import RefreshCwIcon from "lucide-react/dist/esm/icons/refresh-cw";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";
import { deviceSaleKept } from "../app-shell/first-steps";
import { useCurrentOrganization } from "../lib/current-organization";
import { browserStorage } from "../lib/current-organization-model";
import { focusLater } from "../lib/focus";
import { isSigningOut } from "../lib/sign-out";
import { useHoldSwap } from "../lib/unsent-work";
import { useNow } from "../lib/use-now";
import {
  filterLocalStockEntries,
  localStockEntries,
  readLocalCatalog,
} from "../offline/local-stock-entries";
import type { NamespaceKey } from "../offline/namespace";
import type {
  OfflineRuntime,
  RuntimeContext,
} from "../offline/runtime/offline-runtime";
import { useOfflineRuntime } from "../offline/runtime/runtime-context";
import { isSessionOver } from "../offline/runtime/session-ended";
import { useLocalWorkspace } from "../offline/runtime/use-local-workspace";
import { REDO_DONE_NOTICE, REDO_OPENED_NOTICE } from "../offline/sale-redo";
import {
  finishSaleRedo,
  isOpenRedoDraft,
  readSaleRedos,
} from "../offline/sale-redo-storage";
import { confirmOnServer } from "./confirm-on-server";
import { type ConfirmationOutcome, confirmOnDevice } from "./confirm-outcome";
import { firstSaleIdOf } from "./first-sale-id";
import {
  paymentOfSentForm,
  type RememberedPayment,
  readLastPayment,
  salePresetFrom,
  writeLastPayment,
} from "./last-payment-model";
import {
  mergeLastPrices,
  type RememberedPrices,
  readLastPrices,
  suggestionHint,
  suggestPrices,
  withSuggestedPrices,
  writeLastPrices,
} from "./last-prices-model";
import { OfflineSaleNotice, SavedSalesCard } from "./offline-sale-panels";
import {
  readSaleAttemptState,
  sessionStorageOrNull,
  writeSaleAttempt,
} from "./sale-attempt-storage";
import { ConfirmedSalePanel } from "./sale-confirmed-panel";
import { SaleDraftBar } from "./sale-draft-bar";
import {
  chosenItemCount,
  DRAFT_EXPIRED_MESSAGE,
  DRAFT_RECORDED_MESSAGE,
  DRAFT_UNREADABLE_MESSAGE,
  draftVariantIds,
  refreshedDraftMessage,
  refreshRestoredItems,
} from "./sale-draft-restore";
import {
  announceSaleSettled,
  readSaleDraft,
  type SaleDraftRead,
  subscribeSaleSettled,
  writeSaleDraft,
} from "./sale-draft-storage";
import {
  type AdjustmentDraft,
  acknowledgeProfileReview,
  applySalePreset,
  addAdjustment,
  addItem,
  type CatalogView,
  type ChoiceOption,
  cancelDiscard,
  canKeepLockedSaleOnDevice,
  canStartSubmission,
  createBlankSaleForm,
  describeStockRefusal,
  discardLockedSale,
  editSaleDate,
  editSaleForm,
  evaluateSaleForm,
  formForOfflineSale,
  type ItemDraft,
  idleSubmission,
  type Loadable,
  isFormLocked,
  isSaleFormDirty,
  type PreparedConfirmation,
  prepareConfirmation,
  profilesView,
  reconcileProfileReload,
  rejectSubmission,
  removeAdjustment,
  removeItem,
  requestDiscard,
  type SaleAttempt,
  type SaleFormState,
  type SaleMethod,
  type SalePreset,
  type SubmissionState,
  saleModeIsOffline,
  selectPaymentMethod,
  selectProfileChoice,
  startSubmission,
  updateAdjustment,
  updateItem,
  updatePayment,
  withdrawSalePreset,
} from "./sale-form-model";
import { AddItemButton, ItemEditor, ItemsCount } from "./sale-item-editor";
import { PaymentSection } from "./sale-payment-section";
import { SubmitBar, SummaryPanel } from "./sale-summary-panel";
import {
  coversOfStock,
  itemChangesForEntry,
  PICKER_RESULT_LIMIT,
} from "./sale-variant-picker-model";
import { useSaleCatalog } from "./use-sale-catalog";

const newId = () => crypto.randomUUID();

type PreparedOk = Extract<PreparedConfirmation, { ok: true }>;

const itemLabels = (items: readonly ItemDraft[]) =>
  new Map(items.map((item) => [item.variantId, item.label]));

type LocalSearch = (query: string) => Promise<{
  entries: readonly InventoryBalanceEntryReadModel[];
  more: boolean;
}>;

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

function optionsOf(view: CatalogView | null): readonly ChoiceOption[] {
  return view?.kind === "ready" ? view.options : [];
}

function activeCount(
  profiles: Loadable<readonly PaymentProfileReadModel[]>
): number | null {
  return profiles.status === "ready"
    ? profiles.value.filter((profile) => profile.status === "active").length
    : null;
}

/** Under the methods: the single payment, and that the method came from the last sale while it is unchanged. */
function methodHint(
  remembered: RememberedPayment | null,
  form: SaleFormState,
  preset: SalePreset
): string {
  const same =
    remembered !== null &&
    form.payment.method !== "" &&
    form.payment.method === preset.method;
  return same
    ? `Igual à última venda neste aparelho. ${SINGLE_PAYMENT_TEXT}`
    : SINGLE_PAYMENT_TEXT;
}

/** The single payment of the sale, said under the methods. */
const SINGLE_PAYMENT_TEXT =
  "Um pagamento só, no valor total. O método não comprova o recebimento.";

/** Focuses the first invalid control; a group of choice cards gives the focus to its first card. */
function focusFirstInvalidField() {
  window.requestAnimationFrame(() => {
    const invalid = document.querySelector<HTMLElement>(
      '[data-sale-form] [aria-invalid="true"]'
    );
    const target =
      invalid?.getAttribute("role") === "radiogroup"
        ? invalid.querySelector<HTMLElement>('[role="radio"]')
        : invalid;
    target?.focus();
  });
}

/** Re-evaluating the form every minute keeps "now" honest on a form left open. */
const CLOCK_TICK_MS = 60_000;

function draftReadMessage(read: SaleDraftRead): string | null {
  if (read.kind === "expired") {
    return DRAFT_EXPIRED_MESSAGE;
  }
  return read.kind === "unreadable" ? DRAFT_UNREADABLE_MESSAGE : null;
}

function openRedoNotice(
  redoKey: NamespaceKey | null,
  draft: { startedAt: string | null } | null
): string | null {
  return redoKey !== null &&
    isOpenRedoDraft(
      readSaleRedos(browserStorage(), redoKey),
      draft?.startedAt ?? null
    )
    ? REDO_OPENED_NOTICE
    : null;
}

export function SalePage() {
  const { organization, organizationId } = useCurrentOrganization();
  const workspace = useLocalWorkspace(organizationId);
  const runtime = useOfflineRuntime();
  const redoKey = runtime?.namespaceKey(organizationId) ?? null;
  // the namespace closes and opens again while the runtime restarts; the page keeps the key it had for this store
  const knownRedoKey = useRef<{
    key: NamespaceKey;
    organizationId: string;
  } | null>(null);
  if (redoKey) {
    knownRedoKey.current = { key: redoKey, organizationId };
  }
  const redoKeyRef = useRef(redoKey);
  redoKeyRef.current =
    redoKey ??
    (knownRedoKey.current?.organizationId === organizationId
      ? knownRedoKey.current.key
      : null);
  const canAdjustStock = hasCapabilityForRole(
    organization.role,
    "inventory:adjust"
  );
  const now = useNow(CLOCK_TICK_MS);
  const [lastPrices, setLastPrices] = useState<RememberedPrices>(() =>
    readLastPrices(browserStorage(), organizationId)
  );
  const [lastPayment, setLastPayment] = useState<RememberedPayment | null>(() =>
    readLastPayment(browserStorage(), organizationId)
  );
  const [draftRead] = useState<SaleDraftRead>(() =>
    readSaleDraft(
      sessionStorageOrNull(),
      organizationId,
      new Date(),
      organization.timezone
    )
  );
  const restoredDraft = draftRead.kind === "restored" ? draftRead.draft : null;
  const draftStartedAt = useRef<string | null>(
    restoredDraft?.startedAt ?? null
  );
  const [draftNotice, setDraftNotice] = useState<string | null>(null);
  const [firstSaleId, setFirstSaleId] = useState<string | null>(null);
  const [form, setForm] = useState<SaleFormState>(
    () =>
      restoredDraft?.form ??
      applySalePreset(
        createBlankSaleForm(newId),
        salePresetFrom(lastPayment, null)
      )
  );
  const [submission, setSubmission] = useState<SubmissionState>(idleSubmission);
  const submissionRef = useRef(submission);
  submissionRef.current = submission;
  const formRef = useRef(form);
  formRef.current = form;
  // what the screen chose for the person (last sale's payment, "Sem perfil" without profiles): not work
  const presetRef = useRef<SalePreset>(salePresetFrom(lastPayment, null));
  const lastPaymentRef = useRef(lastPayment);
  lastPaymentRef.current = lastPayment;
  const activeProfileCountRef = useRef<number | null>(null);
  /** The payment of the sale just recorded becomes the start of the next one; returns that start. */
  const rememberSentPayment = useCallback((): SalePreset => {
    // the form is still the one that was sent (locked while in flight)
    const sent = paymentOfSentForm(formRef.current);
    if (sent) {
      writeLastPayment(browserStorage(), organizationId, sent);
      setLastPayment(sent);
    }
    const next = salePresetFrom(
      sent ?? lastPaymentRef.current,
      activeProfileCountRef.current
    );
    presetRef.current = next;
    return next;
  }, [organizationId]);
  const blankForm = useCallback(
    (start: SalePreset = presetRef.current) =>
      applySalePreset(createBlankSaleForm(newId), start),
    []
  );
  // the cart is work the session notice warns about, until the sale is confirmed or queued
  useHoldSwap(
    isSaleFormDirty(form, presetRef.current) &&
      submission.phase !== "confirmed" &&
      submission.phase !== "queued"
  );
  // Money and stock go to the server whenever it is reachable; only without a
  // connection is the sale kept on this device. The mode is FROZEN while a sale
  // is in flight or locked (outcome unknown): the connection dropping during the
  // request must not swap the catalog, the profiles or the form under a sale
  // that may already be on the server. It follows the connection again once the
  // sale settles.
  const connectionIsDown = workspace !== null && !workspace.online;
  const modeRef = useRef(connectionIsDown);
  modeRef.current = saleModeIsOffline(
    modeRef.current,
    connectionIsDown,
    submission
  );
  const offlineWorkspace =
    modeRef.current && workspace !== null ? workspace : null;
  const offline = offlineWorkspace !== null;
  const [showRequired, setShowRequired] = useState(false);
  const [restoredAttempt] = useState(() =>
    readSaleAttemptState(
      sessionStorageOrNull(),
      organizationId,
      new Date(),
      restoredDraft?.startedAt ?? null
    )
  );
  const attemptRef = useRef<SaleAttempt | null>(
    restoredAttempt?.attempt ?? null
  );
  const rememberAttempt = useCallback(
    (attempt: SaleAttempt | null, unsettled = false, sending = false) => {
      attemptRef.current = attempt;
      // an answer that arrives after "Sair" or a refused session must not put back the copy that was dropped
      if (isSigningOut() || isSessionOver()) {
        return;
      }
      writeSaleAttempt(
        sessionStorageOrNull(),
        organizationId,
        attempt,
        unsettled,
        sending
      );
    },
    [organizationId]
  );
  const readAttemptState = useCallback(
    () =>
      readSaleAttemptState(
        sessionStorageOrNull(),
        organizationId,
        new Date(),
        draftStartedAt.current
      ),
    [organizationId]
  );
  const attemptOutcomeUnknown = useCallback(
    () => readAttemptState()?.outcomeUnknown === true,
    [readAttemptState]
  );
  const attemptUnsettled = useCallback(
    () => readAttemptState()?.unsettled === true,
    [readAttemptState]
  );
  const inFlightRef = useRef<boolean>(false);
  const confirmedRef = useRef<HTMLElement | null>(null);

  const forgetDraft = useCallback(() => {
    draftStartedAt.current = null;
    writeSaleDraft(sessionStorageOrNull(), organizationId, null);
  }, [organizationId]);
  useEffect(() => {
    // after "Sair" or a session refused, the copies were dropped and must not be written again
    if (isSigningOut() || isSessionOver()) {
      return;
    }
    if (!isSaleFormDirty(form, presetRef.current)) {
      forgetDraft();
      return;
    }
    draftStartedAt.current ??= new Date().toISOString();
    writeSaleDraft(sessionStorageOrNull(), organizationId, {
      form,
      startedAt: draftStartedAt.current,
    });
  }, [forgetDraft, form, organizationId]);

  const handleProfilesLoaded = useCallback(
    (profiles: PaymentProfileReadModel[]) => {
      const outcomeUnknown = attemptOutcomeUnknown();
      setForm((current) =>
        reconcileProfileReload(current, profiles, outcomeUnknown)
      );
    },
    [attemptOutcomeUnknown]
  );
  const openVariantIds = useCallback(
    () =>
      formRef.current.items
        .map((item) => item.variantId)
        .filter((variantId) => variantId !== ""),
    []
  );
  const catalog = useSaleCatalog(
    organizationId,
    handleProfilesLoaded,
    offlineWorkspace,
    openVariantIds
  );
  const refreshRef = useRef(catalog.refresh);
  refreshRef.current = catalog.refresh;
  const modeApplied = useRef<boolean>(false);
  useEffect(() => {
    // Going offline fills in what the offline sale uses (no profile, dated now);
    // coming back online undoes the "no profile" choice made for the person.
    // The mode never changes while a sale is in flight or locked (see above).
    if (offline) {
      const outcomeUnknown = attemptOutcomeUnknown();
      setForm((current) => formForOfflineSale(current, outcomeUnknown));
    }
    if (modeApplied.current) {
      // the lines on the sale keep the balances of the OTHER source otherwise
      refreshRef.current(
        formRef.current.items
          .map((item) => item.variantId)
          .filter((variantId) => variantId !== "")
      );
    }
    modeApplied.current = true;
  }, [attemptOutcomeUnknown, offline]);
  const localWriter = offlineWorkspace?.stores.writer;
  const localOutbox = offlineWorkspace?.stores.outbox;
  const localSearch = useMemo<LocalSearch | undefined>(() => {
    if (!(localWriter && localOutbox)) {
      return;
    }
    return async (query) => {
      const rows = await readLocalCatalog(localWriter, localOutbox);
      return filterLocalStockEntries(localStockEntries(rows), {
        limit: PICKER_RESULT_LIMIT,
        productStatus: "active",
        query,
      });
    };
  }, [localOutbox, localWriter]);
  const { readLines, refresh, resetStock, seedStock } = catalog;
  const covers = useMemo(() => coversOfStock(catalog.stock), [catalog.stock]);

  useEffect(
    () =>
      subscribeSaleSettled((settledOrganization, commandId) => {
        if (
          settledOrganization !== organizationId ||
          inFlightRef.current ||
          attemptRef.current?.commandId !== commandId
        ) {
          return;
        }
        // this screen gave back, from the tab, a cart that another Vender of the page has just recorded
        attemptRef.current = null;
        const blank = blankForm();
        setForm(modeRef.current ? formForOfflineSale(blank) : blank);
        setShowRequired(false);
        setDraftNotice(DRAFT_RECORDED_MESSAGE);
        resetStock();
      }),
    [organizationId, resetStock]
  );

  useEffect(() => {
    // set after the mount, so the live region is in the tree before the notice arrives and it is announced
    const redoNotice = openRedoNotice(redoKeyRef.current, restoredDraft);
    setDraftNotice(draftReadMessage(draftRead) ?? redoNotice);
    const readIds = restoredDraft ? draftVariantIds(restoredDraft.form) : [];
    if (readIds.length === 0) {
      return;
    }
    let mounted = true;
    readLines(readIds)
      .then((entries) => {
        if (!(mounted && entries)) {
          return;
        }
        if (isFormLocked(submissionRef.current)) {
          // confirmed during the read: the cart on its way is not changed under it
          return;
        }
        const spareId = newId();
        const outcomeUnknown = restoredAttempt?.outcomeUnknown === true;
        const refreshed = refreshRestoredItems(
          formRef.current,
          readIds,
          entries,
          () => spareId,
          outcomeUnknown
        );
        const message = refreshedDraftMessage(refreshed);
        if (message === null) {
          return;
        }
        setForm(
          (current) =>
            refreshRestoredItems(
              current,
              readIds,
              entries,
              () => spareId,
              outcomeUnknown
            ).form
        );
        const redoNoticeNow = openRedoNotice(redoKeyRef.current, restoredDraft);
        setDraftNotice(redoNoticeNow ? `${redoNoticeNow} ${message}` : message);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
    // once, for the cart that came back with the mount
  }, [draftRead, organizationId, readLines, restoredAttempt, restoredDraft]);

  useEffect(() => {
    // the queue namespace may open after the page did: the redo it names is only known from then on
    const redoNotice = openRedoNotice(redoKey, {
      startedAt: draftStartedAt.current,
    });
    if (redoNotice) {
      setDraftNotice((current) => current ?? redoNotice);
    }
  }, [redoKey]);

  const activeProfiles = useMemo(
    () => (catalog.profiles.status === "ready" ? catalog.profiles.value : []),
    [catalog.profiles]
  );
  const profilesState = profilesView(catalog.profiles);
  const activeProfileCount = activeCount(catalog.profiles);
  activeProfileCountRef.current = activeProfileCount;
  const preset = useMemo(
    () => salePresetFrom(lastPayment, activeProfileCount),
    [activeProfileCount, lastPayment]
  );
  presetRef.current = preset;
  const evaluation = useMemo(
    () =>
      evaluateSaleForm(
        form,
        { profiles: activeProfiles, stock: catalog.stock },
        { now, showRequired }
      ),
    [activeProfiles, catalog.stock, form, now, showRequired]
  );

  useEffect(() => {
    if (submission.phase === "confirmed" || submission.phase === "queued") {
      confirmedRef.current?.focus();
    }
  }, [submission.phase]);

  const handleRefresh = useCallback(() => {
    refresh(
      form.items
        .map((item) => item.variantId)
        .filter((variantId) => variantId !== "")
    );
  }, [form.items, refresh]);

  const editForm = useCallback(
    (edit: (current: SaleFormState) => SaleFormState) =>
      setForm((current) => editSaleForm(submission, current, edit)),
    [submission]
  );
  const appliedPresetRef = useRef<SalePreset | null>(null);
  useEffect(() => {
    // the profiles were read: a store without an active one starts on "Sem perfil"; only empty choices are filled,
    // and what an earlier preset filled in is taken back when this one no longer offers it
    const previous = appliedPresetRef.current ?? preset;
    appliedPresetRef.current = preset;
    editForm((current) =>
      applySalePreset(withdrawSalePreset(current, previous, preset), preset)
    );
  }, [editForm, preset]);
  const handleItemChange = useCallback(
    (draftId: string, changes: Partial<ItemDraft>) =>
      editForm((current) => updateItem(current, draftId, changes)),
    [editForm]
  );
  const handlePickVariant = useCallback(
    (draftId: string, entry: InventoryBalanceEntryReadModel) => {
      seedStock([entry]);
      const suggestion = suggestPrices(
        lastPrices,
        entry.variantId,
        entry.listPrice
      );
      editForm((current) => {
        const item = current.items.find(
          (candidate) => candidate.draftId === draftId
        );
        const prices = item ? withSuggestedPrices(item, suggestion) : null;
        return updateItem(current, draftId, {
          ...itemChangesForEntry(entry),
          ...(prices
            ? {
                chargedUnitPrice: prices.chargedUnitPrice,
                listedUnitPrice: prices.listedUnitPrice,
              }
            : {}),
        });
      });
      focusLater(() =>
        document.getElementById(`sale-item-${draftId}-quantity`)?.focus()
      );
    },
    [editForm, lastPrices, seedStock]
  );
  const handleAddItem = useCallback(
    () => editForm((current) => addItem(current, newId())),
    [editForm]
  );
  const handleRemoveItem = useCallback(
    (draftId: string) => editForm((current) => removeItem(current, draftId)),
    [editForm]
  );
  const handleAddAdjustment = useCallback(
    () => editForm((current) => addAdjustment(current, newId())),
    [editForm]
  );
  const handleAdjustmentChange = useCallback(
    (draftId: string, changes: Partial<Omit<AdjustmentDraft, "draftId">>) =>
      editForm((current) => updateAdjustment(current, draftId, changes)),
    [editForm]
  );
  const handleRemoveAdjustment = useCallback(
    (draftId: string) =>
      editForm((current) => removeAdjustment(current, draftId)),
    [editForm]
  );
  const handleDateChange = useCallback(
    (value: string) => editForm((current) => editSaleDate(current, value)),
    [editForm]
  );
  const handleMethodChange = useCallback(
    (value: string) =>
      editForm((current) =>
        selectPaymentMethod(current, value as SaleMethod | "")
      ),
    [editForm]
  );
  const handleInstallmentsChange = useCallback(
    (value: string) =>
      editForm((current) => updatePayment(current, { installments: value })),
    [editForm]
  );
  const handlePlanChange = useCallback(
    (value: string) =>
      editForm((current) =>
        updatePayment(current, {
          installmentPlan: value as "" | "issuer" | "merchant",
        })
      ),
    [editForm]
  );
  const handleAnticipationChange = useCallback(
    (checked: boolean) =>
      editForm((current) =>
        updatePayment(current, { anticipationRequested: checked })
      ),
    [editForm]
  );
  const handleProfileChange = useCallback(
    (value: string) =>
      editForm((current) =>
        selectProfileChoice(current, value, activeProfiles)
      ),
    [activeProfiles, editForm]
  );
  const handleAcknowledgeReview = useCallback(
    () =>
      editForm((current) => acknowledgeProfileReview(current, activeProfiles)),
    [activeProfiles, editForm]
  );

  /** What the page does once a confirmation settled, on the server or on the device. */
  const applyOutcome = useCallback(
    (
      outcome: ConfirmationOutcome,
      device: { runtime: OfflineRuntime; stores: RuntimeContext } | null
    ) => {
      const sentCommandId = attemptRef.current?.commandId ?? null;
      const sentDraftStartedAt = draftStartedAt.current;
      rememberAttempt(outcome.attempt, outcome.submission.phase === "locked");
      if (outcome.prices) {
        const remembered = mergeLastPrices(
          lastPrices,
          outcome.prices.lines,
          outcome.prices.day
        );
        setLastPrices(remembered);
        writeLastPrices(browserStorage(), organizationId, remembered);
      }
      if (outcome.completed) {
        // also when the person left Vender while it was sent: a recorded sale never comes back as a draft
        forgetDraft();
        const redone =
          sentCommandId !== null &&
          redoKeyRef.current !== null &&
          finishSaleRedo(
            browserStorage(),
            redoKeyRef.current,
            sentDraftStartedAt,
            sentCommandId
          );
        setDraftNotice(redone ? REDO_DONE_NOTICE : null);
        if (sentCommandId) {
          announceSaleSettled(organizationId, sentCommandId);
        }
        if (device === null) {
          setFirstSaleId(firstSaleIdOf(organizationId, outcome.submission));
        } else {
          deviceSaleKept(organizationId);
        }
      }
      setSubmission(outcome.submission);
      if (!outcome.completed) {
        return;
      }
      const blank = blankForm(rememberSentPayment());
      // by the mode the screen is in now
      setForm(offline ? formForOfflineSale(blank) : blank);
      setShowRequired(false);
      resetStock();
      if (device) {
        device.runtime.localDataChanged();
        device.runtime.refreshCounts().catch(() => undefined);
        // sends it now when the connection came back since the render
        device.runtime.syncNow().catch(() => undefined);
      }
    },
    [
      blankForm,
      rememberSentPayment,
      forgetDraft,
      lastPrices,
      offline,
      organizationId,
      rememberAttempt,
      resetStock,
    ]
  );

  /** Tries the confirmation (on the server, or on the device when offline) and applies its outcome. */
  const settleConfirmation = useCallback(
    async (prepared: PreparedOk) => {
      // Read again at the click: the connection may have changed since the render.
      const stores = offlineWorkspace?.runtime.context() ?? null;
      if (offlineWorkspace && stores) {
        applyOutcome(
          await confirmOnDevice(prepared, stores, itemLabels(form.items)),
          { runtime: offlineWorkspace.runtime, stores }
        );
        return;
      }
      const outcome = await confirmOnServer(prepared);
      applyOutcome(
        {
          ...outcome,
          submission: describeStockRefusal(outcome.submission, {
            canAdjustStock,
            items: prepared.request.items,
            labels: itemLabels(form.items),
            stock: catalog.stock,
          }),
        },
        null
      );
    },
    [applyOutcome, canAdjustStock, catalog.stock, form.items, offlineWorkspace]
  );

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (inFlightRef.current) {
        return;
      }
      setShowRequired(true);
      // The clock is read at the click, not taken from the last render.
      const submittedAt = new Date();
      const fresh = evaluateSaleForm(
        form,
        { profiles: activeProfiles, stock: catalog.stock },
        { now: submittedAt, showRequired: true }
      );
      const { body } = fresh;
      if (body === null || !canStartSubmission(submission, fresh)) {
        focusFirstInvalidField();
        return;
      }
      const prepared = prepareConfirmation({
        attemptUnsettled: attemptUnsettled(),
        body,
        createId: newId,
        now: submittedAt,
        occurredAtOverride: fresh.occurredAtOverride,
        organizationId,
        previousAttempt: attemptRef.current,
      });
      if (!prepared.ok) {
        setSubmission(rejectSubmission(prepared.message));
        return;
      }
      rememberAttempt(prepared.attempt, true, true);
      inFlightRef.current = true;
      setSubmission(startSubmission(submission));
      try {
        await settleConfirmation(prepared);
      } finally {
        inFlightRef.current = false;
      }
    },
    [
      activeProfiles,
      attemptUnsettled,
      catalog.stock,
      form,
      organizationId,
      rememberAttempt,
      settleConfirmation,
      submission,
    ]
  );
  const keepLockedAllowed =
    workspace !== null &&
    canKeepLockedSaleOnDevice(submission, attemptRef.current, evaluation);
  /**
   * An unknown outcome on the server, moved to the device as the SAME sale
   * (same command ID and payload). If the device cannot keep it, the sale stays
   * locked as it was: it is never unlocked for editing, which could record it twice.
   */
  const handleKeepLocked = useCallback(async () => {
    const stores = workspace?.runtime.context() ?? null;
    if (!(workspace && stores) || inFlightRef.current) {
      return;
    }
    const clickedAt = new Date();
    const fresh = evaluateSaleForm(
      form,
      { profiles: activeProfiles, stock: catalog.stock },
      { now: clickedAt, showRequired: true }
    );
    const { body } = fresh;
    if (
      body === null ||
      !canKeepLockedSaleOnDevice(submission, attemptRef.current, fresh)
    ) {
      return;
    }
    const prepared = prepareConfirmation({
      attemptUnsettled: attemptUnsettled(),
      body,
      createId: newId,
      now: clickedAt,
      occurredAtOverride: null,
      organizationId,
      previousAttempt: attemptRef.current,
    });
    if (!prepared.ok || prepared.attempt !== attemptRef.current) {
      return;
    }
    const before = submission;
    inFlightRef.current = true;
    setSubmission(startSubmission(before));
    try {
      const outcome = await confirmOnDevice(
        prepared,
        stores,
        itemLabels(form.items)
      );
      if (outcome.completed) {
        applyOutcome(outcome, { runtime: workspace.runtime, stores });
      } else if (before.phase === "locked") {
        // still locked, never unlocked for editing; the reason it could not be kept is said
        const reason =
          outcome.submission.phase === "failed"
            ? `${outcome.submission.failure.message} `
            : "";
        setSubmission({
          ...before,
          failure: {
            ...before.failure,
            message: `${reason}${before.failure.message}`,
          },
        });
      } else {
        setSubmission(before);
      }
    } finally {
      inFlightRef.current = false;
    }
  }, [
    activeProfiles,
    applyOutcome,
    attemptUnsettled,
    catalog.stock,
    form,
    organizationId,
    submission,
    workspace,
  ]);
  const handleKeepLockedEvent = useCallback(() => {
    handleKeepLocked().catch(() => undefined);
  }, [handleKeepLocked]);

  const handleDiscardRequest = useCallback(
    () => setSubmission((current) => requestDiscard(current)),
    []
  );
  const handleDiscardCancel = useCallback(
    () => setSubmission((current) => cancelDiscard(current)),
    []
  );
  const handleDiscardConfirm = useCallback(() => {
    const discarded = discardLockedSale(submission, newId);
    if (discarded === null) {
      return;
    }
    rememberAttempt(discarded.attempt);
    setForm(applySalePreset(discarded.form, presetRef.current));
    setSubmission(discarded.submission);
    setShowRequired(false);
    resetStock();
  }, [rememberAttempt, resetStock, submission]);
  const handleClearSale = useCallback(() => {
    if (isFormLocked(submission)) {
      return;
    }
    const blank = blankForm();
    const next = offline ? formForOfflineSale(blank) : blank;
    // the attempt stays: after a lost answer the same cart typed again must reach the sale the server may have
    forgetDraft();
    setForm(next);
    setSubmission((current) =>
      current.phase === "failed" ? idleSubmission : current
    );
    setShowRequired(false);
    setDraftNotice(null);
    resetStock();
    focusLater(() =>
      document
        .getElementById(`sale-item-${next.items[0]?.draftId}-search`)
        ?.focus()
    );
  }, [forgetDraft, offline, resetStock, submission]);
  const handleSubmitEvent = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      handleSubmit(event).catch(() => undefined);
    },
    [handleSubmit]
  );

  const locked = isFormLocked(submission);
  const profileOptions = optionsOf(profilesState);
  const { summary } = evaluation;
  const summaryLines = new Map(
    (summary?.lines ?? []).map((line) => [line.draftId, line])
  );
  const itemCount = form.items.length;
  const chosenCount = chosenItemCount(form);
  return (
    <div className="grid gap-4 font-sans text-foreground text-sm antialiased">
      <h1 className="text-title">Nova venda</h1>
      <SaleDraftBar
        canClear={!locked}
        itemCount={chosenCount}
        notice={draftNotice}
        onClear={handleClearSale}
        open={isSaleFormDirty(form, preset)}
      />
      {offline ? <OfflineSaleNotice /> : null}
      <SavedSalesCard
        justSaved={submission.phase === "queued" ? submission.sale : null}
        panelRef={submission.phase === "queued" ? confirmedRef : undefined}
        workspace={workspace}
      />
      {submission.phase === "confirmed" ? (
        <ConfirmedSalePanel
          firstSale={firstSaleId === submission.sale.saleId}
          key={submission.sale.saleId}
          organizationId={organizationId}
          panelRef={confirmedRef}
          sale={submission.sale}
        />
      ) : null}
      <form
        aria-label="Nova venda"
        className="flex flex-col gap-4 min-[56.25rem]:grid min-[56.25rem]:grid-cols-[minmax(0,1fr)_minmax(19rem,22rem)] min-[56.25rem]:items-start"
        data-sale-form=""
        noValidate
        onSubmit={handleSubmitEvent}
      >
        <div className="grid min-w-0 gap-4">
          <Card>
            <fieldset
              aria-labelledby="sale-items-title"
              className="grid min-w-0 gap-4"
              disabled={locked}
            >
              <CardHeader className="grid-cols-[minmax(0,1fr)_auto] items-center">
                <CardTitle aria-level={2} id="sale-items-title" role="heading">
                  Itens
                </CardTitle>
                <Button
                  className="row-span-2"
                  onClick={handleRefresh}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <RefreshCwIcon aria-hidden="true" data-icon="inline-start" />
                  Atualizar estoque e perfis
                </Button>
                <ItemsCount chosen={chosenCount} />
              </CardHeader>
              <CardContent className="grid gap-4">
                {form.items.map((item, index) => (
                  <ItemEditor
                    canAdjustStock={canAdjustStock}
                    canRemove={form.items.length > 1}
                    cover={covers[item.variantId]}
                    errors={evaluation.errors}
                    index={index}
                    item={item}
                    key={item.draftId}
                    localSearch={localSearch}
                    onChange={handleItemChange}
                    onPick={handlePickVariant}
                    onRemove={handleRemoveItem}
                    organizationId={organizationId}
                    priceHint={suggestionHint(lastPrices, item)}
                    stock={catalog.stock}
                    stockWarning={evaluation.stockWarnings[item.draftId]}
                    summaryLine={summaryLines.get(item.draftId)}
                  />
                ))}
                <AddItemButton
                  chosen={chosenCount}
                  onAdd={handleAddItem}
                  total={itemCount}
                />
              </CardContent>
            </fieldset>
          </Card>
          <PaymentSection
            disabled={locked}
            errors={evaluation.errors}
            form={form}
            offline={offline}
            onAcknowledgeReview={handleAcknowledgeReview}
            onAddAdjustment={handleAddAdjustment}
            onAdjustmentChange={handleAdjustmentChange}
            onAnticipationChange={handleAnticipationChange}
            onDateChange={handleDateChange}
            onInstallmentPlanChange={handlePlanChange}
            onInstallmentsChange={handleInstallmentsChange}
            onMethodChange={handleMethodChange}
            onProfileChange={handleProfileChange}
            onRemoveAdjustment={handleRemoveAdjustment}
            onRetry={handleRefresh}
            profileOptions={profileOptions}
            profilesView={profilesState}
            singlePaymentText={methodHint(lastPayment, form, preset)}
            timezone={organization.timezone}
          />
        </div>
        <SummaryPanel
          errors={evaluation.errors}
          evaluation={evaluation}
          offline={offline}
          onDiscardCancel={handleDiscardCancel}
          onDiscardConfirm={handleDiscardConfirm}
          onDiscardRequest={handleDiscardRequest}
          onKeepOnDevice={keepLockedAllowed ? handleKeepLockedEvent : undefined}
          onRefresh={handleRefresh}
          showRequired={showRequired}
          submission={submission}
          summary={summary}
        />
        <SubmitBar
          offline={offline}
          submission={submission}
          summary={summary}
        />
      </form>
    </div>
  );
}
