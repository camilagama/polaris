import type { CustomerReadModel } from "@polaris/contracts";
import MoreHorizontalIcon from "lucide-react/dist/esm/icons/ellipsis";
import PlusIcon from "lucide-react/dist/esm/icons/plus";
import UsersIcon from "lucide-react/dist/esm/icons/users";
import { type MouseEvent, useCallback, useState } from "react";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { productInitials } from "../catalog/product-search-model";
import {
  ListNotice,
  OPENABLE_ROW_CLASS,
  RowOpenButton,
} from "../catalog/screen-parts";
import type { PendingCustomer } from "../offline/customer-create";
import type { PendingCustomerUpdate } from "../offline/customer-update";
import {
  type CustomerAction,
  type CustomerListStatus,
  customerStatusLabel,
  formatCustomerPhone,
  lockedReasonFor,
  syncStateLabel,
} from "./customers-model";

interface RowActions {
  onAnonymize: (customer: CustomerReadModel) => void;
  onArchive: (customer: CustomerReadModel) => void;
  onEdit: (customer: CustomerReadModel) => void;
  onRestore: (customer: CustomerReadModel) => void;
}

interface CustomerMenuProps extends Omit<RowActions, "onAnonymize" | "onEdit"> {
  customer: CustomerReadModel;
  /** Archive, restore and anonymize wait for the server: not confirmed yet, or no connection. */
  lifecycleLocked: boolean;
  onAskAnonymize: () => void;
  pending: boolean;
}

/** The actions of one customer that was not anonymized, besides editing it (the row itself opens it). */
function CustomerMenu({
  customer,
  lifecycleLocked,
  onArchive,
  onAskAnonymize,
  onRestore,
  pending,
}: CustomerMenuProps) {
  const handleArchive = useCallback(
    () => onArchive(customer),
    [customer, onArchive]
  );
  const handleRestore = useCallback(
    () => onRestore(customer),
    [customer, onRestore]
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={`Mais ações para ${customer.name}`}
            disabled={pending}
            size="icon"
            variant="ghost"
          />
        }
      >
        <MoreHorizontalIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {customer.status === "active" ? (
          <DropdownMenuItem disabled={lifecycleLocked} onClick={handleArchive}>
            Arquivar
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem disabled={lifecycleLocked} onClick={handleRestore}>
            Restaurar
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={lifecycleLocked} onClick={onAskAnonymize}>
          Anonimizar
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface AnonymizeConfirmProps {
  customer: CustomerReadModel;
  disabled: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Anonymizing cannot be undone: the row asks again, and says what stays. */
function AnonymizeConfirm({
  customer,
  disabled,
  onCancel,
  onConfirm,
}: AnonymizeConfirmProps) {
  return (
    <fieldset className="mb-2.5 grid min-w-0 gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3">
      <legend className="sr-only">
        Confirmar a anonimização de {customer.name}
      </legend>
      <p className="text-support">
        Anonimizar remove o nome, o telefone, o email e as observações deste
        cliente. <strong>Não dá para desfazer.</strong> As vendas ligadas a ele
        continuam com os mesmos valores.
      </p>
      <div className="flex flex-wrap gap-3">
        <Button
          disabled={disabled}
          onClick={onCancel}
          type="button"
          variant="outline"
        >
          Cancelar
        </Button>
        <Button
          disabled={disabled}
          onClick={onConfirm}
          type="button"
          variant="destructive"
        >
          Anonimizar definitivamente
        </Button>
      </div>
    </fieldset>
  );
}

function pendingLabelFor(
  pendingAction: string | null,
  customerId: string
): string | null {
  const labels: Record<CustomerAction, string> = {
    anonymize: "Anonimizando…",
    archive: "Arquivando…",
    restore: "Restaurando…",
  };
  for (const [action, label] of Object.entries(labels)) {
    if (pendingAction === `${action}:${customerId}`) {
      return label;
    }
  }
  return null;
}

interface CustomerMainProps {
  /** The phone and the e-mail, as the row writes them. */
  contacts: string;
  customer: CustomerReadModel;
  locked: boolean;
  lockedReasonId: string | undefined;
  onEdit: (customer: CustomerReadModel) => void;
}

/**
 * The circle, the name with its state and the contacts. They open the customer's form, as one button; an
 * anonymized customer cannot be edited, so they are only text.
 */
function CustomerMain({
  contacts,
  customer,
  locked,
  lockedReasonId,
  onEdit,
}: CustomerMainProps) {
  const handleOpen = useCallback(() => onEdit(customer), [customer, onEdit]);
  const isAnonymized = customer.anonymizedAt !== null;
  const supportId = `customer-support-${customer.id}`;
  const stateId = `customer-state-${customer.id}`;
  // the active tab already says "Ativo": the badge is for the other states
  const hasStateBadge = customer.status !== "active" || isAnonymized;
  const content = (
    <>
      <span
        aria-hidden="true"
        className="grid size-9 shrink-0 place-items-center self-start rounded-full bg-muted font-medium text-muted-foreground text-xs"
      >
        {productInitials(customer.name)}
      </span>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium [overflow-wrap:anywhere]">
            {isAnonymized ? null : <span className="sr-only">Editar </span>}
            {customer.name}
          </span>
          {hasStateBadge ? (
            <Badge
              aria-hidden={isAnonymized ? undefined : true}
              id={stateId}
              variant={
                customer.status === "archived" && !isAnonymized
                  ? "warning"
                  : "outline"
              }
            >
              {customerStatusLabel(customer)}
            </Badge>
          ) : null}
        </span>
        {contacts ? (
          <span
            aria-hidden={isAnonymized ? undefined : true}
            className="line-clamp-1 text-muted-foreground text-support [overflow-wrap:anywhere]"
            id={supportId}
          >
            {contacts}
          </span>
        ) : null}
      </span>
    </>
  );
  if (isAnonymized) {
    return (
      <div className="flex min-w-0 flex-1 items-center gap-3 py-2.5">
        {content}
      </div>
    );
  }
  return (
    <RowOpenButton
      describedBy={
        [
          hasStateBadge ? stateId : undefined,
          contacts ? supportId : undefined,
          lockedReasonId,
        ]
          .filter(Boolean)
          .join(" ") || undefined
      }
      locked={locked}
      onOpen={handleOpen}
    >
      {content}
    </RowOpenButton>
  );
}

interface CustomerRowNotesProps {
  isAnonymized: boolean;
  lockedReason: string | null;
  pendingLabel: string | null;
  reasonId: string;
  shownState: PendingCustomer | PendingCustomerUpdate | undefined;
  /** The waiting command is the creation (not an edit): it names the badge. */
  unconfirmedCreation: boolean;
}

/** Under the row, out of its button: the state of the send, the way to Pendências, the reasons and what runs. */
function CustomerRowNotes({
  isAnonymized,
  lockedReason,
  pendingLabel,
  reasonId,
  shownState,
  unconfirmedCreation,
}: CustomerRowNotesProps) {
  if (!(shownState || lockedReason || isAnonymized || pendingLabel)) {
    return null;
  }
  return (
    <div className="grid gap-0.5 pb-2.5 pl-12">
      {shownState ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Badge
            data-sync-state={shownState.state}
            role="status"
            variant={
              shownState.state === "rejected" ? "destructive" : "outline"
            }
          >
            {syncStateLabel(shownState, !unconfirmedCreation)}
          </Badge>
          {shownState.state === "rejected" ? (
            <a
              className="focus-ring touch-hit w-fit rounded-sm text-support underline decoration-input underline-offset-4 hover:decoration-foreground"
              href="/attention"
            >
              Resolver em Pendências
            </a>
          ) : null}
        </div>
      ) : null}
      {lockedReason ? (
        <p className="text-muted-foreground text-support" id={reasonId}>
          {lockedReason}
        </p>
      ) : null}
      {isAnonymized ? (
        <p className="text-muted-foreground text-support">
          Dados pessoais removidos: não dá para editar nem restaurar; as vendas
          dele não mudam.
        </p>
      ) : null}
      {pendingLabel ? (
        <p className="text-muted-foreground text-support" role="status">
          {pendingLabel}
        </p>
      ) : null}
    </div>
  );
}

interface CustomerRowProps extends RowActions {
  customer: CustomerReadModel;
  /** The server cannot be reached: the actions that need it are off, and the notice at the top says why. */
  isOffline: boolean;
  /** Any action is running: the menus wait. */
  isPending: boolean;
  pendingAction: string | null;
  /** The customer was created on this device and the server has not confirmed it yet. */
  syncState: PendingCustomer | undefined;
  /** An edit made on this device that the server has not confirmed yet. */
  updateState: PendingCustomerUpdate | undefined;
}

function CustomerRow({
  customer,
  isOffline,
  isPending,
  onAnonymize,
  onArchive,
  onEdit,
  onRestore,
  pendingAction,
  syncState,
  updateState,
}: CustomerRowProps) {
  const [confirming, setConfirming] = useState(false);
  const isAnonymized = customer.anonymizedAt !== null;
  const shownState = syncState ?? updateState;
  const lockedReason = lockedReasonFor(syncState, updateState);
  const pendingLabel = pendingLabelFor(pendingAction, customer.id);
  const contacts = [
    customer.phone ? formatCustomerPhone(customer.phone) : null,
    customer.email,
  ]
    .filter(Boolean)
    .join(" · ");

  const reasonId = `customer-locked-${customer.id}`;
  const handleAsk = useCallback(() => setConfirming(true), []);
  const handleCancel = useCallback(() => setConfirming(false), []);
  const handleConfirm = useCallback(() => {
    setConfirming(false);
    onAnonymize(customer);
  }, [customer, onAnonymize]);

  return (
    <li
      className={`grid px-3 md:px-4 ${isAnonymized ? "" : OPENABLE_ROW_CLASS}`}
      data-customer-id={customer.id}
    >
      <div className="flex items-center gap-3">
        <CustomerMain
          contacts={contacts}
          customer={customer}
          locked={lockedReason !== null || isPending}
          lockedReasonId={lockedReason ? reasonId : undefined}
          onEdit={onEdit}
        />
        {isAnonymized ? null : (
          <CustomerMenu
            customer={customer}
            lifecycleLocked={isOffline || lockedReason !== null}
            onArchive={onArchive}
            onAskAnonymize={handleAsk}
            onRestore={onRestore}
            pending={isPending}
          />
        )}
      </div>
      <CustomerRowNotes
        isAnonymized={isAnonymized}
        lockedReason={lockedReason}
        pendingLabel={pendingLabel}
        reasonId={reasonId}
        shownState={shownState}
        unconfirmedCreation={Boolean(syncState)}
      />
      {confirming ? (
        <AnonymizeConfirm
          customer={customer}
          disabled={isPending}
          onCancel={handleCancel}
          onConfirm={handleConfirm}
        />
      ) : null}
    </li>
  );
}

interface CustomerListProps extends RowActions {
  /** The customers that match the search. */
  customers: CustomerReadModel[];
  isLoading: boolean;
  /** Working from this device's collections while the connection is down. */
  isOffline: boolean;
  /** The button of the empty list: the form is not on the page, it opens from here. */
  onNew: (event: MouseEvent<HTMLButtonElement>) => void;
  pendingAction: string | null;
  /** The typed search; empty when none. */
  query: string;
  status: CustomerListStatus;
  /** Customers created on this device that the server has not confirmed yet. */
  syncStates: ReadonlyMap<string, PendingCustomer>;
  /** How many customers the status has, before the search. */
  total: number;
  /** Edits made on this device that the server has not confirmed yet. */
  updateStates: ReadonlyMap<string, PendingCustomerUpdate>;
}

export function CustomerList({
  customers,
  isLoading,
  isOffline,
  onNew,
  pendingAction,
  query,
  status,
  syncStates,
  total,
  updateStates,
  ...actions
}: CustomerListProps) {
  if (isLoading) {
    return (
      <ListNotice>
        <p className="text-muted-foreground" role="status">
          Carregando clientes…
        </p>
      </ListNotice>
    );
  }
  if (total === 0) {
    return (
      <ListNotice>
        {status === "active" ? (
          <>
            <UsersIcon
              aria-hidden="true"
              className="size-6 text-muted-foreground"
            />
            <p className="text-muted-foreground">
              Nenhum cliente ainda. Cadastre o primeiro em “Novo cliente”.
            </p>
            <Button
              disabled={pendingAction !== null}
              onClick={onNew}
              type="button"
            >
              <PlusIcon aria-hidden="true" data-icon="inline-start" />
              Novo cliente
            </Button>
          </>
        ) : (
          <p className="text-muted-foreground">Nenhum cliente arquivado.</p>
        )}
      </ListNotice>
    );
  }
  if (customers.length === 0) {
    return (
      <ListNotice>
        <p className="text-muted-foreground" role="status">
          Nenhum cliente com “{query.trim()}”.
        </p>
      </ListNotice>
    );
  }
  return (
    <Card className="gap-0 py-0">
      <ul aria-label="Clientes" className="divide-y divide-border">
        {customers.map((customer) => (
          <CustomerRow
            {...actions}
            customer={customer}
            isOffline={isOffline}
            isPending={pendingAction !== null}
            key={customer.id}
            pendingAction={pendingAction}
            syncState={syncStates.get(customer.id)}
            updateState={updateStates.get(customer.id)}
          />
        ))}
      </ul>
    </Card>
  );
}
