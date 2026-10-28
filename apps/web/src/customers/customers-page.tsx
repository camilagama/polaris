import type {
  CustomerDuplicateMatchReadModel,
  CustomerReadModel,
} from "@polaris/contracts";
import {
  type FormEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActionFeedback,
  LoadErrorNotice,
} from "../catalog/products-page-parts";
import { StatusNav } from "../catalog/screen-parts";
import { focusLater } from "../lib/focus";
import { useCurrentOrganization } from "../lib/current-organization";
import { orpcClient } from "../lib/orpc";
import { readWithRetry } from "../lib/read-with-retry";
import { useHoldSwap } from "../lib/unsent-work";
import {
  createOfflineCustomer,
  type PendingCustomer,
  pendingCustomers,
} from "../offline/customer-create";
import {
  overlayPendingCustomerEdits,
  type PendingCustomerUpdate,
  pendingCustomerUpdates,
  updateOfflineCustomer,
} from "../offline/customer-update";
import { useLocalWorkspace } from "../offline/runtime/use-local-workspace";
import {
  type CustomerDraft,
  draftOfCustomer,
  emptyCustomerDraft,
  isCustomerDraftChanged,
} from "./customer-draft";
import { CustomerForm } from "./customer-form";
import { CustomerList } from "./customer-list";
import {
  CONTACT_REQUIRED_TEXT,
  type CustomerAction,
  type CustomerListStatus,
  customerErrorMessage,
  hasCustomerContact,
  lockedReasonFor,
  STATUS_OPTIONS,
} from "./customers-model";
import {
  findLocalDuplicates,
  listLocalCustomers,
  toLocalCustomerRow,
} from "./local-customers";
import { CustomersHeader, OfflineNotice } from "./customers-page-parts";

/**
 * After the server changed a customer, the same row goes into the local
 * collection (when the runtime is on), so the list read from the device shows
 * it at once instead of waiting for the next pull; the pull later writes the
 * same version again.
 */
async function keepLocalRow(
  workspace: ReturnType<typeof useLocalWorkspace>,
  customer: CustomerReadModel
): Promise<void> {
  if (workspace) {
    await workspace.stores.writer.upsert("customers", [
      toLocalCustomerRow(customer),
    ]);
  }
}

export function CustomersPage() {
  const { organizationId } = useCurrentOrganization();
  const workspace = useLocalWorkspace(organizationId);
  const [syncStates, setSyncStates] = useState<
    ReadonlyMap<string, PendingCustomer>
  >(new Map());
  const [updateStates, setUpdateStates] = useState<
    ReadonlyMap<string, PendingCustomerUpdate>
  >(new Map());
  const [status, setStatus] = useState<CustomerListStatus>("active");
  const [customers, setCustomers] = useState<CustomerReadModel[]>([]);
  const [draft, setDraft] = useState<CustomerDraft>(emptyCustomerDraft);
  const [editingCustomer, setEditingCustomer] =
    useState<CustomerReadModel | null>(null);
  const [duplicateMatches, setDuplicateMatches] = useState<
    CustomerDuplicateMatchReadModel[]
  >([]);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [contactError, setContactError] = useState<string | null>(null);
  // the form is a dialog: it opens for a new customer or for an edit, and the draft is only cleared once it has closed
  const [formOpen, setFormOpen] = useState(false);
  const customerLoadSequence = useRef(0);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const newButtonRef = useRef<HTMLButtonElement>(null);
  // where the focus goes back to when the form closes without a message to read: what opened it
  const originRef = useRef<() => HTMLElement | null>(() => null);
  // the draft kept when the form was closed by Esc or "Fechar": "new", or the id of the customer being edited
  const keptRef = useRef<string | null>(null);
  const noticeRef = useRef<string | null>(null);
  // a customer was just made: the notice offers "Cadastrar outro"
  const [justCreated, setJustCreated] = useState(false);
  useHoldSwap(isCustomerDraftChanged(draft, editingCustomer));
  // any change of the form (typing, picking another customer, clearing) takes the contact error away
  useEffect(() => setContactError(null), [draft]);

  /**
   * What an action ended with is said at the top of the screen, and the focus goes there: the form, the menu or the
   * confirmation the person was in is gone or far away. The effect runs after the render that draws the message.
   */
  const [feedbackFocus, setFeedbackFocus] = useState(0);
  const focusFeedback = useCallback(
    () => setFeedbackFocus((count) => count + 1),
    []
  );
  useEffect(() => {
    if (feedbackFocus > 0) {
      feedbackRef.current?.focus();
    }
  }, [feedbackFocus]);

  const loadCustomers = useCallback(
    async (targetOrganizationId: string, targetStatus: CustomerListStatus) => {
      customerLoadSequence.current += 1;
      const requestSequence = customerLoadSequence.current;
      setIsLoading(true);
      setLoadError(null);
      setCustomers([]);
      try {
        const result = await readWithRetry(
          (signal) =>
            orpcClient.customer.list(
              { organizationId: targetOrganizationId, status: targetStatus },
              { signal }
            ),
          { isCurrent: () => requestSequence === customerLoadSequence.current }
        );
        if (requestSequence !== customerLoadSequence.current) {
          return;
        }
        setCustomers(result.customers);
      } catch (caughtError) {
        if (requestSequence === customerLoadSequence.current) {
          setLoadError(customerErrorMessage(caughtError, "load"));
        }
      } finally {
        if (requestSequence === customerLoadSequence.current) {
          setIsLoading(false);
        }
      }
    },
    []
  );

  const usesLocalRows = workspace !== null;
  useEffect(() => {
    if (usesLocalRows) {
      return;
    }
    loadCustomers(organizationId, status);
    return () => {
      customerLoadSequence.current += 1;
    };
  }, [loadCustomers, organizationId, status, usesLocalRows]);

  // With the offline runtime ready the list comes from this device, and is read
  // again whenever the runtime says the local rows may have changed.
  useEffect(() => {
    if (!workspace) {
      return;
    }
    let cancelled = false;
    const { outbox, writer } = workspace.stores;
    Promise.all([
      writer.rows("customers"),
      pendingCustomers(outbox),
      pendingCustomerUpdates(outbox),
      outbox.snapshot(),
    ])
      .then(([rows, pending, updates, snapshot]) => {
        if (cancelled) {
          return;
        }
        // an edit still waiting is shown over the server's row (never written into it)
        setCustomers(
          listLocalCustomers(
            overlayPendingCustomerEdits(rows, snapshot.commands),
            organizationId,
            status
          )
        );
        setSyncStates(new Map(pending.map((item) => [item.customerId, item])));
        setUpdateStates(
          new Map(updates.map((item) => [item.customerId, item]))
        );
        setLoadError(null);
        setIsLoading(false);
      })
      .catch((caughtError) => {
        if (!cancelled) {
          setLoadError(customerErrorMessage(caughtError, "load"));
          setIsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workspace, organizationId, status]);

  /** Shows the change: the local rows are read again, or the server's list is. */
  const refreshList = useCallback(async () => {
    if (workspace) {
      await workspace.runtime.refreshCounts();
      workspace.runtime.localDataChanged();
      return;
    }
    await loadCustomers(organizationId, status);
  }, [loadCustomers, organizationId, status, workspace]);

  const handleDraftChange = useCallback(
    (field: keyof CustomerDraft, value: string) => {
      setDraft((current) => ({ ...current, [field]: value }));
      setDuplicateMatches([]);
      setError(null);
      setNotice(null);
    },
    []
  );

  const handleStatus = useCallback(
    (nextStatus: CustomerListStatus) => {
      if (nextStatus === status) {
        return;
      }
      customerLoadSequence.current += 1;
      setCustomers([]);
      setIsLoading(true);
      setError(null);
      setLoadError(null);
      setStatus(nextStatus);
      keptRef.current = null;
      setEditingCustomer(null);
      setDraft(emptyCustomerDraft);
      setDuplicateMatches([]);
      setNotice(null);
    },
    [status]
  );

  const handleNew = useCallback((event?: MouseEvent<HTMLElement>) => {
    // what was pressed (the header button, the one of the empty list, or "Cadastrar outro" in the notice)
    const pressed = event?.currentTarget;
    originRef.current = () =>
      pressed?.isConnected ? pressed : newButtonRef.current;
    if (keptRef.current !== "new") {
      setEditingCustomer(null);
      setDraft(emptyCustomerDraft);
    }
    keptRef.current = null;
    setDuplicateMatches([]);
    setError(null);
    setNotice(null);
    setJustCreated(false);
    setFormOpen(true);
  }, []);

  const handleEdit = useCallback((customer: CustomerReadModel) => {
    // the row's menu button that opened the edit (the menu itself is gone by the time the form closes)
    const label = `Mais ações para ${customer.name}`;
    originRef.current = () =>
      Array.from(document.querySelectorAll<HTMLElement>("button")).find(
        (button) => button.getAttribute("aria-label") === label
      ) ?? null;
    if (keptRef.current !== customer.id) {
      setEditingCustomer(customer);
      setDraft(draftOfCustomer(customer));
    }
    keptRef.current = null;
    setDuplicateMatches([]);
    setError(null);
    setNotice(null);
    setJustCreated(false);
    setFormOpen(true);
  }, []);

  const handleUseExisting = useCallback(
    (customer: CustomerReadModel) => {
      const locked = lockedReasonFor(
        syncStates.get(customer.id),
        updateStates.get(customer.id)
      );
      if (locked) {
        // the same lock as the card: nothing is edited on top of an unconfirmed change
        setError(locked);
        setNotice(null);
        setDuplicateMatches([]);
        focusFeedback();
        return;
      }
      setStatus(customer.status);
      setEditingCustomer(customer);
      setDraft(draftOfCustomer(customer));
      setDuplicateMatches([]);
      setError(null);
      setNotice(
        customer.status === "archived"
          ? "Cadastro existente selecionado. Ele continua arquivado até você restaurá-lo."
          : "Cadastro existente selecionado para revisão. Nenhum dado foi mesclado."
      );
      // the button that was pressed is gone with the panel: the notice, in the form, is where the focus goes
      focusFeedback();
    },
    [focusFeedback, syncStates, updateStates]
  );

  /** "Cancelar": the form closes and what was typed is thrown away. */
  const handleCancelEdit = useCallback(() => {
    keptRef.current = null;
    setFormOpen(false);
    setDuplicateMatches([]);
    setError(null);
    setNotice(null);
  }, []);

  /** Esc and "Fechar": the form closes and the draft stays, in memory, for the next opening of the same form. */
  const handleDismiss = useCallback(() => {
    keptRef.current = editingCustomer?.id ?? "new";
    setFormOpen(false);
    setDuplicateMatches([]);
    setError(null);
    setNotice(null);
  }, [editingCustomer]);

  /** The form is empty again only once it has finished closing (and only when nothing was kept). */
  const handleFormClosed = useCallback(() => {
    setContactError(null);
    if (keptRef.current === null) {
      setEditingCustomer(null);
      setDraft(emptyCustomerDraft);
    }
    // what the save said takes the focus, on the notice itself (not on the button inside it)
    if (noticeRef.current) {
      focusLater(() => feedbackRef.current?.focus());
    }
  }, []);

  /** With a message to read the focus goes to it once the form is gone; without one, back to what opened the form. */
  const finalFocus = useCallback(
    () => (noticeRef.current ? false : (originRef.current() ?? true)),
    []
  );

  const findDraftDuplicates = useCallback(async () => {
    if (workspace) {
      const [rows, snapshot] = await Promise.all([
        workspace.stores.writer.rows("customers"),
        workspace.stores.outbox.snapshot(),
      ]);
      return findLocalDuplicates(
        // a phone or e-mail changed by an edit that is still waiting counts
        overlayPendingCustomerEdits(rows, snapshot.commands),
        organizationId,
        { email: draft.email, phone: draft.phone }
      );
    }
    const result = await orpcClient.customer.findPossibleDuplicates({
      email: draft.email,
      organizationId,
      phone: draft.phone,
    });
    return result.matches;
  }, [draft.email, draft.phone, organizationId, workspace]);

  const persistCustomer = useCallback(async () => {
    const madeName = draft.name.trim();
    const profile = {
      email: draft.email,
      name: draft.name,
      notes: draft.notes,
      organizationId,
      phone: draft.phone,
    };
    if (editingCustomer && workspace && !workspace.online) {
      // Queued on this device (from the version the person edited) and shown at once.
      const stores = workspace.runtime.context();
      if (!stores || stores.organizationId !== organizationId) {
        throw new Error("offline_runtime_unavailable");
      }
      await updateOfflineCustomer({
        current: editingCustomer,
        deviceId: stores.deviceId,
        input: profile,
        lease: stores.lease,
        organizationId,
        outbox: stores.outbox,
      });
      return "Alteração salva neste aparelho. Ela será enviada quando a conexão voltar.";
    }
    if (editingCustomer) {
      const updated = await orpcClient.customer.update({
        ...profile,
        expectedVersion: editingCustomer.version,
        id: editingCustomer.id,
      });
      await keepLocalRow(workspace, updated.customer);
      return "Dados do cliente atualizados.";
    }
    if (workspace) {
      // Queued on this device and shown at once; sent now when there is a connection.
      const stores = workspace.runtime.context();
      if (!stores || stores.organizationId !== organizationId) {
        // not ready, or the organization changed under the screen: nothing is queued
        throw new Error("offline_runtime_unavailable");
      }
      await createOfflineCustomer({
        deviceId: stores.deviceId,
        input: profile,
        lease: stores.lease,
        organizationId,
        outbox: stores.outbox,
        writer: stores.writer,
      });
      if (workspace.online) {
        workspace.runtime.syncNow().catch(() => undefined);
        return `Cliente “${madeName}” cadastrado.`;
      }
      return `Cliente “${madeName}” salvo neste aparelho. Ele será enviado quando a conexão voltar.`;
    }
    await orpcClient.customer.create(profile);
    return `Cliente “${madeName}” cadastrado.`;
  }, [draft, editingCustomer, organizationId, workspace]);

  /**
   * Where the focus goes when a save ends. A failure is said in the form, which is still open, and takes the person to
   * the alert; a save closes the form, and the focus goes to the notice when it has closed (`finalFocus`); a panel of
   * possible duplicates keeps the focus where it was.
   */
  const settleFocus = useCallback(
    (outcome: "duplicates" | "failed" | "saved") => {
      if (outcome === "failed") {
        focusFeedback();
      }
    },
    [focusFeedback]
  );

  const saveCustomer = useCallback(
    async (allowPossibleDuplicates = false) => {
      if (!hasCustomerContact(draft)) {
        // beside the button and on the fields, not at the top of the page (U-24)
        setContactError(CONTACT_REQUIRED_TEXT);
        setError(null);
        setNotice(null);
        focusLater(() => document.getElementById("customer-phone")?.focus());
        return;
      }
      setContactError(null);

      const needsDuplicateCheck = !(editingCustomer || allowPossibleDuplicates);
      if (editingCustomer) {
        setPendingAction(`update:${editingCustomer.id}`);
      } else if (allowPossibleDuplicates) {
        setPendingAction("create");
      } else {
        setPendingAction("duplicate-check");
      }
      setError(null);
      setNotice(null);
      setDuplicateMatches([]);
      let failureAction: "duplicate-check" | "save" = "save";
      if (needsDuplicateCheck) {
        failureAction = "duplicate-check";
      }
      // the panel of the possible duplicates is read by its own live region and the focus stays where it was (U-25)
      let outcome: "duplicates" | "failed" | "saved" = "failed";
      try {
        if (needsDuplicateCheck) {
          const matches = await findDraftDuplicates();
          if (matches.length > 0) {
            outcome = "duplicates";
            setDuplicateMatches(matches);
            return;
          }
          failureAction = "save";
        }
        setNotice(await persistCustomer());
        setJustCreated(!editingCustomer);
        keptRef.current = null;
        setFormOpen(false);
        await refreshList();
        outcome = "saved";
      } catch (caughtError) {
        setError(customerErrorMessage(caughtError, failureAction));
      } finally {
        setPendingAction(null);
        settleFocus(outcome);
      }
    },
    [
      draft,
      editingCustomer,
      findDraftDuplicates,
      persistCustomer,
      refreshList,
      settleFocus,
    ]
  );

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      await saveCustomer();
    },
    [saveCustomer]
  );

  const handleCreateAnyway = useCallback(
    () => saveCustomer(true),
    [saveCustomer]
  );

  const handleLifecycle = useCallback(
    async (customer: CustomerReadModel, action: CustomerAction) => {
      setPendingAction(`${action}:${customer.id}`);
      setError(null);
      setNotice(null);
      try {
        const input = {
          expectedVersion: customer.version,
          id: customer.id,
          organizationId,
        };
        if (action === "anonymize") {
          const anonymized =
            await orpcClient.customer.anonymizeForPrivacy(input);
          await keepLocalRow(workspace, anonymized.customer);
          setNotice(
            "Cliente anonimizado. Os dados pessoais foram removidos; as vendas ligadas a ele mantêm seus valores."
          );
        } else if (action === "archive") {
          const archived = await orpcClient.customer.archive(input);
          await keepLocalRow(workspace, archived.customer);
          setNotice("Cliente arquivado.");
        } else {
          const restored = await orpcClient.customer.restore(input);
          await keepLocalRow(workspace, restored.customer);
          setNotice("Cliente restaurado.");
        }
        if (editingCustomer?.id === customer.id) {
          setEditingCustomer(null);
          setDraft(emptyCustomerDraft);
        }
        await refreshList();
      } catch (caughtError) {
        setError(customerErrorMessage(caughtError, action));
      } finally {
        setPendingAction(null);
        focusFeedback();
      }
    },
    [editingCustomer, focusFeedback, organizationId, refreshList, workspace]
  );

  const handleRetry = useCallback(() => {
    refreshList().catch(() => undefined);
  }, [refreshList]);

  const handleAnonymize = useCallback(
    (customer: CustomerReadModel) => handleLifecycle(customer, "anonymize"),
    [handleLifecycle]
  );
  const handleArchive = useCallback(
    (customer: CustomerReadModel) => handleLifecycle(customer, "archive"),
    [handleLifecycle]
  );
  const handleRestore = useCallback(
    (customer: CustomerReadModel) => handleLifecycle(customer, "restore"),
    [handleLifecycle]
  );

  noticeRef.current = notice;
  const isOffline = workspace !== null && !workspace.online;
  const isPending = pendingAction !== null;
  // the empty list has the button itself: not two of them
  const emptyList =
    status === "active" &&
    !isLoading &&
    loadError === null &&
    customers.length === 0;
  const newButton = useMemo(
    () =>
      status === "active" && !emptyList
        ? { disabled: isPending, onClick: handleNew, ref: newButtonRef }
        : null,
    [emptyList, handleNew, isPending, status]
  );
  const noticeAction = useMemo(
    () =>
      justCreated
        ? { label: "Cadastrar outro", onClick: handleNew }
        : undefined,
    [handleNew, justCreated]
  );

  return (
    <div className="grid gap-4 font-sans text-foreground text-sm antialiased">
      <CustomersHeader newButton={newButton} />
      {isOffline ? <OfflineNotice /> : null}
      {/* while the form is open it covers this part of the screen: what the actions say is said inside it */}
      <ActionFeedback
        error={formOpen ? null : error}
        notice={formOpen ? null : notice}
        noticeAction={formOpen ? undefined : noticeAction}
        regionRef={feedbackRef}
      />
      <CustomerForm
        contactError={contactError}
        draft={draft}
        duplicateMatches={duplicateMatches}
        editingCustomer={editingCustomer}
        error={formOpen ? error : null}
        feedbackRef={feedbackRef}
        finalFocus={finalFocus}
        isPending={isPending}
        notice={formOpen ? notice : null}
        onCancel={handleCancelEdit}
        onChange={handleDraftChange}
        onClosed={handleFormClosed}
        onCreateAnyway={handleCreateAnyway}
        onDismiss={handleDismiss}
        onSubmit={handleSubmit}
        onUseExisting={handleUseExisting}
        open={formOpen}
      />
      <StatusNav
        disabled={pendingAction !== null}
        label="Estado dos clientes"
        onSelect={handleStatus}
        options={STATUS_OPTIONS}
        value={status}
      />
      {loadError ? (
        <LoadErrorNotice message={loadError} onRetry={handleRetry} />
      ) : (
        <CustomerList
          customers={customers}
          isLoading={isLoading}
          isOffline={isOffline}
          onAnonymize={handleAnonymize}
          onNew={handleNew}
          onArchive={handleArchive}
          onEdit={handleEdit}
          onRestore={handleRestore}
          pendingAction={pendingAction}
          status={status}
          syncStates={syncStates}
          updateStates={updateStates}
        />
      )}
    </div>
  );
}
