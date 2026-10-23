import type {
  CustomerDuplicateMatchReadModel,
  CustomerReadModel,
} from "@polaris/contracts";
import {
  type FormEvent,
  useCallback,
  useEffect,
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
import { useReportUnsentWork } from "../lib/unsent-work";
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
  const customerLoadSequence = useRef(0);
  const feedbackRef = useRef<HTMLDivElement>(null);
  useReportUnsentWork(isCustomerDraftChanged(draft, editingCustomer));
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
        const result = await orpcClient.customer.list({
          organizationId: targetOrganizationId,
          status: targetStatus,
        });
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
      setEditingCustomer(null);
      setDraft(emptyCustomerDraft);
      setDuplicateMatches([]);
      setNotice(null);
    },
    [status]
  );

  const handleEdit = useCallback((customer: CustomerReadModel) => {
    setEditingCustomer(customer);
    setDraft(draftOfCustomer(customer));
    setDuplicateMatches([]);
    setError(null);
    setNotice(null);
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
    },
    [focusFeedback, syncStates, updateStates]
  );

  const handleCancelEdit = useCallback(() => {
    setEditingCustomer(null);
    setDraft(emptyCustomerDraft);
    setDuplicateMatches([]);
    setError(null);
    setNotice(null);
  }, []);

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
        return "Cliente cadastrado.";
      }
      return "Cliente salvo neste aparelho. Ele será enviado quando a conexão voltar.";
    }
    await orpcClient.customer.create(profile);
    return "Cliente cadastrado.";
  }, [draft, editingCustomer, organizationId, workspace]);

  /**
   * Where the focus goes when a save ends. A new customer leaves the form empty and the cursor in the name, for the
   * next one (the notice is a status, read where it is); an edit or a failure takes the person to the notice, since
   * the form they were in no longer says what happened; a panel of possible duplicates keeps the focus where it was.
   */
  const settleFocus = useCallback(
    (outcome: "created" | "duplicates" | "other") => {
      if (outcome === "created") {
        focusLater(() => document.getElementById("customer-name")?.focus());
      } else if (outcome === "other") {
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
      let outcome: "created" | "duplicates" | "other" = "other";
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
        setEditingCustomer(null);
        setDraft(emptyCustomerDraft);
        await refreshList();
        outcome = editingCustomer ? "other" : "created";
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

  const isOffline = workspace !== null && !workspace.online;
  const showForm = status === "active" || editingCustomer !== null;

  return (
    <div
      className="grid gap-4 font-sans text-foreground text-sm antialiased"
    >
      <CustomersHeader />
      {isOffline ? <OfflineNotice /> : null}
      <ActionFeedback error={error} notice={notice} regionRef={feedbackRef} />
      {showForm ? (
        <CustomerForm
          contactError={contactError}
          draft={draft}
          duplicateMatches={duplicateMatches}
          editingCustomer={editingCustomer}
          isPending={pendingAction !== null}
          onCancel={handleCancelEdit}
          onChange={handleDraftChange}
          onCreateAnyway={handleCreateAnyway}
          onSubmit={handleSubmit}
          onUseExisting={handleUseExisting}
        />
      ) : null}
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
