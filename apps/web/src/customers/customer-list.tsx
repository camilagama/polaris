import type { CustomerReadModel } from "@polaris/contracts";
import MoreHorizontalIcon from "lucide-react/dist/esm/icons/ellipsis";
import UsersIcon from "lucide-react/dist/esm/icons/users";
import { useCallback, useState } from "react";
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
import { formatDate, ListNotice } from "../catalog/screen-parts";
import type { PendingCustomer } from "../offline/customer-create";
import type { PendingCustomerUpdate } from "../offline/customer-update";
import {
  type CustomerAction,
  type CustomerListStatus,
  customerStatusLabel,
  lockedReasonFor,
  syncStateLabel,
} from "./customers-model";

interface RowActions {
  onAnonymize: (customer: CustomerReadModel) => void;
  onArchive: (customer: CustomerReadModel) => void;
  onEdit: (customer: CustomerReadModel) => void;
  onRestore: (customer: CustomerReadModel) => void;
}

interface CustomerMenuProps extends Omit<RowActions, "onAnonymize"> {
  customer: CustomerReadModel;
  /** Archive, restore and anonymize wait for the server: not confirmed yet, or no connection. */
  lifecycleLocked: boolean;
  /** Editing waits only for the server to confirm what is already waiting. */
  locked: boolean;
  onAskAnonymize: () => void;
  pending: boolean;
}

/** The actions of one customer that was not anonymized. */
function CustomerMenu({
  customer,
  lifecycleLocked,
  locked,
  onArchive,
  onAskAnonymize,
  onEdit,
  onRestore,
  pending,
}: CustomerMenuProps) {
  const handleEdit = useCallback(() => onEdit(customer), [customer, onEdit]);
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
        <DropdownMenuItem disabled={locked} onClick={handleEdit}>
          Editar
        </DropdownMenuItem>
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
    <fieldset className="grid min-w-0 gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3">
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
  const contacts = [customer.phone, customer.email].filter(Boolean).join(" · ");

  const handleAsk = useCallback(() => setConfirming(true), []);
  const handleCancel = useCallback(() => setConfirming(false), []);
  const handleConfirm = useCallback(() => {
    setConfirming(false);
    onAnonymize(customer);
  }, [customer, onAnonymize]);

  let badgeVariant: "outline" | "warning" = "outline";
  if (customer.status === "archived" && !isAnonymized) {
    badgeVariant = "warning";
  }
  return (
    <li
      className="grid gap-3 px-3 py-2.5 md:px-4"
      data-customer-id={customer.id}
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="grid size-9 shrink-0 place-items-center self-start rounded-full bg-muted font-medium text-muted-foreground text-xs"
        >
          {productInitials(customer.name)}
        </span>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="font-medium [overflow-wrap:anywhere]">
              {customer.name}
            </p>
            <Badge variant={badgeVariant}>
              {customerStatusLabel(customer)}
            </Badge>
            {shownState ? (
              <Badge
                data-sync-state={shownState.state}
                role="status"
                variant={
                  shownState.state === "rejected" ? "destructive" : "outline"
                }
              >
                {syncStateLabel(shownState, !syncState)}
              </Badge>
            ) : null}
          </div>
          {contacts ? (
            <p className="text-muted-foreground text-support [overflow-wrap:anywhere]">
              {contacts}
            </p>
          ) : null}
          {customer.notes ? (
            <p className="line-clamp-2 whitespace-pre-line text-muted-foreground text-support [overflow-wrap:anywhere]">
              {customer.notes}
            </p>
          ) : null}
          <p className="text-muted-foreground text-support">
            Atualizado em {formatDate(customer.updatedAt)}
          </p>
          {shownState?.state === "rejected" ? (
            <a
              className="focus-ring touch-hit w-fit rounded-sm text-support underline decoration-input underline-offset-4 hover:decoration-foreground"
              href="/attention"
            >
              Resolver em Pendências
            </a>
          ) : null}
          {lockedReason ? (
            <p className="text-muted-foreground text-support">{lockedReason}</p>
          ) : null}
          {isAnonymized ? (
            <p className="text-muted-foreground text-support">
              Dados pessoais removidos. Este cadastro não pode ser editado nem
              restaurado; as vendas ligadas a ele mantêm seus valores.
            </p>
          ) : null}
          {pendingLabel ? (
            <p className="text-muted-foreground text-support" role="status">
              {pendingLabel}
            </p>
          ) : null}
        </div>
        {isAnonymized ? null : (
          <CustomerMenu
            customer={customer}
            lifecycleLocked={isOffline || lockedReason !== null}
            locked={lockedReason !== null}
            onArchive={onArchive}
            onAskAnonymize={handleAsk}
            onEdit={onEdit}
            onRestore={onRestore}
            pending={isPending}
          />
        )}
      </div>
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
  customers: CustomerReadModel[];
  isLoading: boolean;
  /** Working from this device's collections while the connection is down. */
  isOffline: boolean;
  pendingAction: string | null;
  status: CustomerListStatus;
  /** Customers created on this device that the server has not confirmed yet. */
  syncStates: ReadonlyMap<string, PendingCustomer>;
  /** Edits made on this device that the server has not confirmed yet. */
  updateStates: ReadonlyMap<string, PendingCustomerUpdate>;
}

export function CustomerList({
  customers,
  isLoading,
  isOffline,
  pendingAction,
  status,
  syncStates,
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
  if (customers.length === 0) {
    return (
      <ListNotice>
        {status === "active" ? (
          <>
            <UsersIcon
              aria-hidden="true"
              className="size-6 text-muted-foreground"
            />
            <p className="text-muted-foreground">
              Nenhum cliente cadastrado. Use o formulário para adicionar o
              primeiro.
            </p>
          </>
        ) : (
          <p className="text-muted-foreground">Nenhum cliente arquivado.</p>
        )}
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
