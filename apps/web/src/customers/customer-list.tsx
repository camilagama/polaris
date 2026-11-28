import type { CustomerReadModel } from "@polaris/contracts";
import MoreHorizontalIcon from "lucide-react/dist/esm/icons/ellipsis";
import UsersIcon from "lucide-react/dist/esm/icons/users";
import { type ReactNode, useCallback, useState } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { EmptyState } from "@/ui/empty-state";
import { InlineConfirm } from "@/ui/inline-confirm";
import { ListBlock } from "@/ui/list-block";
import { RowInitials } from "@/ui/row-tile";
import { Skeleton } from "@/ui/skeleton";
import { TextLink } from "@/ui/text-link";
import { productInitials } from "../catalog/product-search-model";
import {
  OPENABLE_ROW_CLASS,
  ROW_BODY_CLASS,
  ROW_TEXT_CLASS,
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
import { lastPurchaseRowText } from "./last-purchase";

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
            data-customer-menu=""
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

function AnonymizeConfirm({
  customer,
  disabled,
  onCancel,
  onConfirm,
}: AnonymizeConfirmProps) {
  const opener = useCallback(
    () =>
      document.querySelector<HTMLElement>(
        `[data-customer-id="${customer.id}"] [data-customer-menu]`
      ),
    [customer.id]
  );
  return (
    <InlineConfirm
      action="a anonimização"
      busy={disabled}
      className="mb-2.5"
      confirmLabel="Anonimizar definitivamente"
      keepLabel="Manter cliente"
      object={customer.name}
      onConfirm={onConfirm}
      onKeep={onCancel}
      opener={opener}
    >
      Anonimizar remove o nome, o telefone, o e-mail e as observações deste
      cliente. Não dá para desfazer. As vendas ligadas a ele continuam com os
      mesmos valores.
    </InlineConfirm>
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

interface Contacts {
  email: string | null;
  phone: string | null;
}

/**
 * Each contact is an atom of the line: an inline box is as wide as the line allows (never wider), so one that does
 * not fit beside the other goes down to a line of its own before anything breaks, and only a contact wider than the
 * whole line breaks, at any character (an e-mail wider than the line breaks before the "@" first, see `EmailText`,
 * and anywhere only if a part still does not fit). The line takes no clamp: it would hide the second line, which is
 * where the last digit and the e-mail go.
 */
const CONTACT_CLASS = "inline-block max-w-full [overflow-wrap:anywhere]";

/**
 * A break opportunity before the "@" makes a too-wide address break between user and domain; `overflow-wrap:anywhere`
 * stays as the net for a part that is longer than the line. The `<wbr>` adds no character, so the text, the accessible
 * name and what is copied stay the exact address.
 */
function EmailText({ email }: { email: string }) {
  const at = email.indexOf("@");
  if (at <= 0) {
    return email;
  }
  return (
    <>
      {email.slice(0, at)}
      <wbr />
      {email.slice(at)}
    </>
  );
}

interface ContactsLineProps {
  contacts: Contacts;
  /** The row's button describes itself by this line, so the line is out of the tree of the screen reader. */
  hidden: boolean;
  id: string;
}

interface RowTrailingProps {
  badge: ReactNode;
  /** The purchase text leaves the reading tree unless the row is only text (the customer was anonymized). */
  hidden: boolean;
  purchase: string | null;
  purchaseId: string;
}

/** The state badge and the last purchase: under the contacts on a narrow window, at the right corner from 40 rem. */
function RowTrailing({
  badge,
  hidden,
  purchase,
  purchaseId,
}: RowTrailingProps) {
  return (
    <span className="flex min-w-0 flex-col items-start gap-1 min-[40rem]:items-end">
      {badge}
      {purchase ? (
        <span
          aria-hidden={hidden ? true : undefined}
          className="text-muted-foreground text-support"
          data-last-purchase=""
          id={purchaseId}
        >
          {purchase}
        </span>
      ) : null}
    </span>
  );
}

function ContactsLine({ contacts, hidden, id }: ContactsLineProps) {
  return (
    <span
      aria-hidden={hidden ? true : undefined}
      className="text-muted-foreground text-support"
      id={id}
    >
      {contacts.phone ? (
        <span className={CONTACT_CLASS}>{contacts.phone}</span>
      ) : null}
      {contacts.phone && contacts.email ? " · " : null}
      {contacts.email ? (
        <span className={CONTACT_CLASS}>
          <EmailText email={contacts.email} />
        </span>
      ) : null}
    </span>
  );
}

interface CustomerMainProps {
  /** The phone, already formatted, and the e-mail: what the row writes under the name. */
  contacts: Contacts;
  customer: CustomerReadModel;
  locked: boolean;
  lockedReasonId: string | undefined;
  onEdit: (customer: CustomerReadModel) => void;
  pendingLabelId: string | undefined;
  /** The store's today: what "Última compra" counts from. */
  today: string;
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
  pendingLabelId,
  today,
}: CustomerMainProps) {
  const handleOpen = useCallback(() => onEdit(customer), [customer, onEdit]);
  const isAnonymized = customer.anonymizedAt !== null;
  const supportId = `customer-support-${customer.id}`;
  const stateId = `customer-state-${customer.id}`;
  const purchaseId = `customer-purchase-${customer.id}`;
  const purchaseText = lastPurchaseRowText(customer.lastPurchaseOn, today);
  // the active tab already says "Ativo": the badge is for the other states
  const hasStateBadge = customer.status !== "active" || isAnonymized;
  const hasContacts = Boolean(contacts.phone || contacts.email);
  const content = (
    <>
      <RowInitials className="self-start">
        {productInitials(customer.name)}
      </RowInitials>
      <span className={ROW_BODY_CLASS}>
        <span className={ROW_TEXT_CLASS}>
          <span className="font-medium [overflow-wrap:anywhere]">
            {isAnonymized ? null : <span className="sr-only">Editar </span>}
            {customer.name}
          </span>
          {hasContacts ? (
            <ContactsLine
              contacts={contacts}
              hidden={!isAnonymized}
              id={supportId}
            />
          ) : null}
        </span>
        {hasStateBadge || purchaseText ? (
          <RowTrailing
            badge={
              hasStateBadge ? (
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
              ) : null
            }
            hidden={!isAnonymized}
            purchase={purchaseText}
            purchaseId={purchaseId}
          />
        ) : null}
      </span>
    </>
  );
  if (isAnonymized) {
    return (
      <>
        <div className="flex min-w-0 flex-1 items-center gap-3 py-2.5">
          {content}
        </div>
        <span aria-hidden="true" className="size-ctl-md shrink-0" />
      </>
    );
  }
  return (
    <RowOpenButton
      describedBy={
        [
          hasContacts ? supportId : undefined,
          hasStateBadge ? stateId : undefined,
          purchaseText ? purchaseId : undefined,
          lockedReasonId,
          pendingLabelId,
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
  pendingLabelId: string;
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
  pendingLabelId,
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
            <TextLink className="w-fit text-support" href="/attention">
              Resolver em Pendências
            </TextLink>
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
        <p
          className="text-muted-foreground text-support"
          id={pendingLabelId}
          role="status"
        >
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
  /** The store's today, in its own time zone. */
  today: string;
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
  today,
  updateState,
}: CustomerRowProps) {
  const [confirming, setConfirming] = useState(false);
  const isAnonymized = customer.anonymizedAt !== null;
  const shownState = syncState ?? updateState;
  const lockedReason = lockedReasonFor(syncState, updateState);
  const pendingLabel = pendingLabelFor(pendingAction, customer.id);
  const contacts = {
    email: customer.email,
    phone: customer.phone ? formatCustomerPhone(customer.phone) : null,
  };

  const reasonId = `customer-locked-${customer.id}`;
  const pendingLabelId = `customer-pending-${customer.id}`;
  const handleAsk = useCallback(() => setConfirming(true), []);
  const handleCancel = useCallback(() => setConfirming(false), []);
  const handleConfirm = useCallback(() => {
    setConfirming(false);
    onAnonymize(customer);
  }, [customer, onAnonymize]);

  return (
    <ListBlock.Row
      className={cn("grid gap-0 py-0", isAnonymized ? "" : OPENABLE_ROW_CLASS)}
      data-customer-id={customer.id}
    >
      <div className="flex items-center gap-3">
        <CustomerMain
          contacts={contacts}
          customer={customer}
          locked={lockedReason !== null || isPending}
          lockedReasonId={lockedReason ? reasonId : undefined}
          onEdit={onEdit}
          pendingLabelId={pendingLabel ? pendingLabelId : undefined}
          today={today}
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
        pendingLabelId={pendingLabelId}
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
    </ListBlock.Row>
  );
}

interface CustomerListProps extends RowActions {
  /** "5 clientes" or "2 de 5 clientes": the support text beside the title; empty while the list loads or finds nothing. */
  count: string;
  /** The customers that match the search. */
  customers: CustomerReadModel[];
  isLoading: boolean;
  /** Working from this device's collections while the connection is down. */
  isOffline: boolean;
  pendingAction: string | null;
  /** The typed search; empty when none. */
  query: string;
  status: CustomerListStatus;
  /** Customers created on this device that the server has not confirmed yet. */
  syncStates: ReadonlyMap<string, PendingCustomer>;
  /** The store's today, in its own time zone. */
  today: string;
  /** How many customers the status has, before the search. */
  total: number;
  /** Edits made on this device that the server has not confirmed yet. */
  updateStates: ReadonlyMap<string, PendingCustomerUpdate>;
}

/** The shape of a row, drawn while the list loads: the circle and two lines. */
function CustomerRowSkeleton() {
  return (
    <div className="flex items-center gap-3">
      <Skeleton className="size-9 shrink-0 rounded-full" />
      <div className="grid min-w-0 flex-1 gap-1.5">
        <Skeleton className="h-4 w-40 max-w-full" />
        <Skeleton className="h-3.5 w-56 max-w-full" />
      </div>
    </div>
  );
}

const LIST_TITLE = "Clientes cadastrados";

export function CustomerList({
  count,
  customers,
  isLoading,
  isOffline,
  pendingAction,
  query,
  status,
  syncStates,
  today,
  total,
  updateStates,
  ...actions
}: CustomerListProps) {
  if (isLoading) {
    return (
      <ListBlock
        count=""
        skeleton={<CustomerRowSkeleton />}
        state="loading"
        title={LIST_TITLE}
      />
    );
  }
  if (total === 0) {
    if (status !== "active") {
      return (
        <EmptyState
          afterRead
          icon={UsersIcon}
          title="Nenhum cliente arquivado."
        />
      );
    }
    return (
      <EmptyState afterRead icon={UsersIcon} title="Nenhum cliente ainda." />
    );
  }
  if (customers.length === 0) {
    return (
      <ListBlock
        count={count}
        emptyNotice={
          <p className="text-muted-foreground" role="status">
            Nenhum cliente com “{query.trim()}”.
          </p>
        }
        state="filtered-empty"
        title={LIST_TITLE}
      />
    );
  }
  return (
    <ListBlock count={count} state="rows" title={LIST_TITLE}>
      {customers.map((customer) => (
        <CustomerRow
          {...actions}
          customer={customer}
          isOffline={isOffline}
          isPending={pendingAction !== null}
          key={customer.id}
          pendingAction={pendingAction}
          syncState={syncStates.get(customer.id)}
          today={today}
          updateState={updateStates.get(customer.id)}
        />
      ))}
    </ListBlock>
  );
}
