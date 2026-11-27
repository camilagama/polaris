import type {
  PaymentFeeConfigurationReadModel,
  PaymentProfileReadModel,
} from "@polaris/contracts";
import BanknoteIcon from "lucide-react/dist/esm/icons/banknote";
import CircleAlertIcon from "lucide-react/dist/esm/icons/circle-alert";
import CircleEllipsisIcon from "lucide-react/dist/esm/icons/circle-ellipsis";
import CreditCardIcon from "lucide-react/dist/esm/icons/credit-card";
import MoreHorizontalIcon from "lucide-react/dist/esm/icons/ellipsis";
import LandmarkIcon from "lucide-react/dist/esm/icons/landmark";
import QrCodeIcon from "lucide-react/dist/esm/icons/qr-code";
import WalletIcon from "lucide-react/dist/esm/icons/wallet";
import { type ReactNode, useCallback } from "react";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription } from "@/ui/alert";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Checkbox } from "@/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { EmptyState } from "@/ui/empty-state";
import { Field, FieldLabel } from "@/ui/field";
import { MoneyText } from "@/ui/hidden-values";
import { InsetBlock } from "@/ui/inset-block";
import { ListBlock } from "@/ui/list-block";
import { RetryButton } from "@/ui/retry-button";
import { Skeleton } from "@/ui/skeleton";
import { connectionControlProps } from "../app-shell/connection-required-notice";
import { describeFee, settlementText } from "./payment-fee-model";
import { methods } from "./payment-profile-form";

/* The list of the profiles on the `ListBlock` (ADR 0103): one row per profile, and in each row a block per rule. A fee
   that is not known is never shown as zero: italic, underlined with a dashed line and in the warning color. */

const LIST_TITLE = "Perfis cadastrados";
/** The list was not read (no connection): it is not an empty list (U-60). */
const PROFILES_NOT_LOADED =
  "Os perfis não carregaram. Eles aparecem quando a conexão voltar.";

function Figure({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="grid min-w-0 content-start gap-0.5">
      <dt className="text-muted-foreground text-support">{label}</dt>
      <dd className="[overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function FeeFigure({
  fee,
  label,
}: {
  fee: PaymentFeeConfigurationReadModel;
  label: string;
}) {
  const { text, unknown } = describeFee(fee);
  return (
    <Figure label={label}>
      <span
        className={cn(
          "tabular-nums",
          unknown &&
            "border-warning/50 border-b border-dashed text-warning italic"
        )}
      >
        <MoneyText text={text} />
      </span>
    </Figure>
  );
}

function ruleTitle(rule: PaymentProfileReadModel["rules"][number]): string {
  const method = methods.find(([id]) => id === rule.method)?.[1] ?? "";
  if (rule.method !== "credit_card") {
    return method;
  }
  const plan =
    rule.installmentPlan === "issuer" ? "emissor" : "estabelecimento";
  return `${method} · ${rule.installments}x · ${plan}`;
}

const METHOD_ICON: Readonly<
  Record<PaymentProfileReadModel["rules"][number]["method"], typeof WalletIcon>
> = {
  bank_transfer: LandmarkIcon,
  cash: BanknoteIcon,
  credit_card: CreditCardIcon,
  debit_card: CreditCardIcon,
  other: CircleEllipsisIcon,
  pix: QrCodeIcon,
};

/** One method on every rule draws that method; several (or none yet) draw the wallet that holds them all. */
function ProfileIcon({ profile }: { profile: PaymentProfileReadModel }) {
  const used = new Set(profile.rules.map((rule) => rule.method));
  const [only] = used;
  const Icon = used.size === 1 && only ? METHOD_ICON[only] : WalletIcon;
  return <Icon />;
}

interface ProfileRowProps {
  onChangeLifecycle: (profile: PaymentProfileReadModel) => void;
  onEdit: (profile: PaymentProfileReadModel) => void;
  /** Offline the lifecycle action says why and sends nothing. */
  online: boolean;
  pending: boolean;
  profile: PaymentProfileReadModel;
}

/**
 * The actions of an active profile (two: edit and archive) are the "…" menu, archive last and apart as the destructive
 * item. The trigger carries `data-profile-edit`: it is where the focus returns when the form that "Editar" opened
 * closes. Offline "Arquivar" stays open on click so the reason it points at is still read beside it.
 */
function ProfileMenu({
  onChangeLifecycle,
  onEdit,
  online,
  pending,
  profile,
}: ProfileRowProps) {
  const handleEdit = useCallback(() => onEdit(profile), [onEdit, profile]);
  const handleLifecycle = useCallback(
    () => onChangeLifecycle(profile),
    [onChangeLifecycle, profile]
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={`Mais ações para ${profile.name}`}
            data-profile-edit=""
            disabled={pending}
            size="icon"
            variant="ghost"
          />
        }
      >
        <MoreHorizontalIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuItem
          aria-label={`Editar perfil ${profile.name}`}
          onClick={handleEdit}
        >
          Editar
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          {...connectionControlProps(online)}
          aria-label={`Arquivar perfil ${profile.name}`}
          className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
          closeOnClick={online}
          onClick={handleLifecycle}
          variant="destructive"
        >
          Arquivar
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** An archived profile has one action, restore: a button on the row, not a menu. */
function RestoreButton({
  onChangeLifecycle,
  online,
  pending,
  profile,
}: ProfileRowProps) {
  const handleLifecycle = useCallback(
    () => onChangeLifecycle(profile),
    [onChangeLifecycle, profile]
  );
  return (
    <Button
      {...connectionControlProps(online)}
      aria-label={`Restaurar perfil ${profile.name}`}
      disabled={pending}
      onClick={handleLifecycle}
      size="sm"
      type="button"
      variant="outline"
    >
      Restaurar
    </Button>
  );
}

function ProfileRow(props: ProfileRowProps) {
  const { profile } = props;
  const active = profile.status === "active";
  const count = `${profile.rules.length} ${profile.rules.length === 1 ? "regra" : "regras"}`;
  return (
    <ListBlock.Row
      className="items-start"
      data-profile-id={profile.id}
      tile={<ProfileIcon profile={profile} />}
    >
      <div className="grid min-w-0 flex-1 gap-3">
        <div className="flex min-w-0 items-start justify-between gap-x-3 gap-y-2">
          <div className="flex min-w-0 flex-1 flex-col items-start gap-1 min-[40rem]:flex-row min-[40rem]:gap-3">
            <div className="grid min-w-0 gap-0.5 self-stretch min-[40rem]:flex-1">
              <p className="font-medium [overflow-wrap:anywhere]">
                {profile.name}
              </p>
              <p className="text-muted-foreground text-support">{count}</p>
            </div>
            <Badge variant={active ? "outline" : "warning"}>
              {active ? "Ativo" : "Arquivado"}
            </Badge>
          </div>
          <div className="flex shrink-0 justify-end min-[40rem]:w-24">
            {active ? <ProfileMenu {...props} /> : <RestoreButton {...props} />}
          </div>
        </div>
        <ul className="grid gap-2">
          {profile.rules.map((rule) => (
            <li className="min-w-0" key={rule.id}>
              <InsetBlock className="grid gap-2 p-3">
                <p className="font-medium [overflow-wrap:anywhere]">
                  {ruleTitle(rule)}
                </p>
                <dl className="grid gap-x-3 gap-y-2 text-support min-[30rem]:grid-cols-3">
                  <Figure label="Recebimento">
                    {settlementText(rule.expectedSettlementDays)}
                  </Figure>
                  <FeeFigure fee={rule.processingFee} label="Processamento" />
                  <FeeFigure fee={rule.anticipationFee} label="Antecipação" />
                </dl>
              </InsetBlock>
            </li>
          ))}
        </ul>
      </div>
    </ListBlock.Row>
  );
}

interface ListBodyProps extends Omit<ProfileRowProps, "profile"> {
  /** Some profile exists, archived or not: an empty list then means the filter, not an empty organization. */
  hasAnyProfile: boolean;
  loadError: string | null;
  loading: boolean;
  /** The list could not be read for lack of a connection: never shown as "no profile". */
  notLoaded: boolean;
  onRetry: () => void;
  profiles: PaymentProfileReadModel[];
}

function RowShape() {
  return (
    <div className="flex items-start gap-3">
      <Skeleton className="size-9 shrink-0 rounded-md" />
      <div className="grid flex-1 gap-1.5 pt-1">
        <Skeleton className="h-3.5 w-2/3" />
        <Skeleton className="h-3 w-1/4" />
      </div>
    </div>
  );
}

function ListBody({
  loadError,
  loading,
  notLoaded,
  onChangeLifecycle,
  onEdit,
  hasAnyProfile,
  online,
  onRetry,
  pending,
  profiles,
}: ListBodyProps) {
  if (loading) {
    return (
      <ListBlock
        count=""
        skeleton={<RowShape />}
        state="loading"
        title={LIST_TITLE}
      />
    );
  }
  if (notLoaded) {
    return (
      <p className="text-muted-foreground" role="status">
        {PROFILES_NOT_LOADED}
      </p>
    );
  }
  if (loadError) {
    // a list that could not be read is not an empty list: it says so, and offers to read again
    return (
      <Alert variant="destructive">
        <CircleAlertIcon aria-hidden="true" />
        <AlertDescription className="grid justify-items-start gap-2">
          {loadError}
          <RetryButton onClick={onRetry} />
        </AlertDescription>
      </Alert>
    );
  }
  if (profiles.length === 0 && !hasAnyProfile) {
    return (
      <EmptyState
        afterRead
        icon={CreditCardIcon}
        support="Adicione um perfil para registrar métodos e taxas de pagamento."
        title="Nenhum perfil cadastrado"
      />
    );
  }
  if (profiles.length === 0) {
    return (
      <ListBlock
        count=""
        emptyNotice={
          <>
            <p className="font-medium">Nenhum perfil ativo</p>
            <p className="text-muted-foreground text-support">
              Os perfis arquivados aparecem com “Incluir arquivados”.
            </p>
          </>
        }
        state="filtered-empty"
        title={LIST_TITLE}
      />
    );
  }
  return (
    <ListBlock state="rows" title={LIST_TITLE}>
      {profiles.map((profile) => (
        <ProfileRow
          key={profile.id}
          onChangeLifecycle={onChangeLifecycle}
          onEdit={onEdit}
          online={online}
          pending={pending}
          profile={profile}
        />
      ))}
    </ListBlock>
  );
}

interface PaymentProfileListProps extends ListBodyProps {
  includeArchived: boolean;
  onIncludeArchivedChange: (checked: boolean) => void;
}

/** The profiles of the organization, with the choice of showing the archived ones above the frame. */
export function PaymentProfileList({
  includeArchived,
  onIncludeArchivedChange,
  ...body
}: PaymentProfileListProps) {
  return (
    <div className="grid gap-4">
      <div className="flex justify-end">
        <Field className="min-h-ctl-md w-auto" orientation="horizontal">
          <Checkbox
            checked={includeArchived}
            id="payment-archived"
            onCheckedChange={onIncludeArchivedChange}
          />
          <FieldLabel htmlFor="payment-archived">Incluir arquivados</FieldLabel>
        </Field>
      </div>
      <ListBody {...body} />
    </div>
  );
}
