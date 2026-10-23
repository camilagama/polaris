import type {
  PaymentFeeConfigurationReadModel,
  PaymentProfileReadModel,
} from "@polaris/contracts";
import CircleAlertIcon from "lucide-react/dist/esm/icons/circle-alert";
import { type ReactNode, useCallback } from "react";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription } from "@/ui/alert";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";
import { Checkbox } from "@/ui/checkbox";
import { Field, FieldLabel } from "@/ui/field";
import { formatFeePercentage } from "./payment-fee-model";
import { methods } from "./payment-profile-form";

/* The list of the profiles on the components of src/ui (ADR 0103): one card, one row per profile, and in each row
   a block per rule. A fee that is not known is never shown as zero: italic, dashed and in the warning color. */

const LIST_TITLE_ID = "payment-list-title";

interface FeeText {
  text: string;
  unknown: boolean;
}

function feeText(fee: PaymentFeeConfigurationReadModel): FeeText {
  if (fee.mode === "unknown") {
    return { text: "desconhecida (não é zero)", unknown: true };
  }
  if (fee.mode === "none") {
    return { text: "nenhuma", unknown: false };
  }
  return {
    text: [
      fee.fixedAmount === null ? null : `R$ ${fee.fixedAmount}`,
      fee.percentage === null ? null : formatFeePercentage(fee.percentage),
    ]
      .filter(Boolean)
      .join(" + "),
    unknown: false,
  };
}

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
  const { text, unknown } = feeText(fee);
  return (
    <Figure label={label}>
      <span
        className={cn(
          "tabular-nums",
          unknown &&
            "rounded-sm border border-warning/50 border-dashed px-1 text-warning italic"
        )}
      >
        {text}
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

interface ProfileRowProps {
  onChangeLifecycle: (profile: PaymentProfileReadModel) => void;
  onEdit: (profile: PaymentProfileReadModel) => void;
  pending: boolean;
  profile: PaymentProfileReadModel;
}

function ProfileRow({
  onChangeLifecycle,
  onEdit,
  pending,
  profile,
}: ProfileRowProps) {
  const handleEdit = useCallback(() => onEdit(profile), [onEdit, profile]);
  const handleLifecycle = useCallback(
    () => onChangeLifecycle(profile),
    [onChangeLifecycle, profile]
  );
  const active = profile.status === "active";
  const count = `${profile.rules.length} ${profile.rules.length === 1 ? "regra" : "regras"}`;
  return (
    <li className="grid gap-3 p-(--card-spacing)" data-profile-id={profile.id}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium [overflow-wrap:anywhere]">
            {profile.name}
            <Badge variant={active ? "outline" : "warning"}>
              {active ? "Ativo" : "Arquivado"}
            </Badge>
          </p>
          <p className="text-muted-foreground text-support">{count}</p>
        </div>
        <div className="flex gap-2">
          {active ? (
            <Button
              aria-label={`Editar perfil ${profile.name}`}
              data-profile-edit=""
              disabled={pending}
              onClick={handleEdit}
              size="sm"
              type="button"
              variant="outline"
            >
              Editar
            </Button>
          ) : null}
          <Button
            aria-label={`${active ? "Arquivar" : "Restaurar"} perfil ${profile.name}`}
            disabled={pending}
            onClick={handleLifecycle}
            size="sm"
            type="button"
            variant="outline"
          >
            {active ? "Arquivar" : "Restaurar"}
          </Button>
        </div>
      </div>
      <ul className="grid gap-2">
        {profile.rules.map((rule) => (
          <li className="grid gap-2 rounded-lg border p-3" key={rule.id}>
            <p className="font-medium">{ruleTitle(rule)}</p>
            <dl className="grid gap-x-3 gap-y-2 text-support min-[30rem]:grid-cols-3">
              <Figure label="Recebimento">
                {rule.expectedSettlementDays === null
                  ? "não informado"
                  : `${rule.expectedSettlementDays} dias`}
              </Figure>
              <FeeFigure fee={rule.processingFee} label="Processamento" />
              <FeeFigure fee={rule.anticipationFee} label="Antecipação" />
            </dl>
          </li>
        ))}
      </ul>
    </li>
  );
}

interface ListBodyProps extends Omit<ProfileRowProps, "profile"> {
  loadError: string | null;
  loading: boolean;
  onRetry: () => void;
  /** Some profile exists, archived or not: an empty list then means the filter, not an empty organization. */
  hasAnyProfile: boolean;
  profiles: PaymentProfileReadModel[];
}

function ListBody({
  loadError,
  loading,
  onChangeLifecycle,
  onEdit,
  hasAnyProfile,
  onRetry,
  pending,
  profiles,
}: ListBodyProps) {
  if (loading) {
    return (
      <CardContent>
        <p className="text-muted-foreground" role="status">
          Carregando perfis…
        </p>
      </CardContent>
    );
  }
  if (loadError) {
    // a list that could not be read is not an empty list: it says so, and offers to read again
    return (
      <CardContent>
        <Alert variant="destructive">
          <CircleAlertIcon aria-hidden="true" />
          <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {loadError}
            <Button onClick={onRetry} size="sm" type="button" variant="link">
              Tentar novamente
            </Button>
          </AlertDescription>
        </Alert>
      </CardContent>
    );
  }
  if (profiles.length === 0) {
    return (
      <CardContent className="grid gap-0.5">
        <p className="font-medium">
          {hasAnyProfile ? "Nenhum perfil ativo" : "Nenhum perfil cadastrado"}
        </p>
        <p className="text-muted-foreground text-support">
          {hasAnyProfile
            ? "Os perfis arquivados aparecem com “Incluir arquivados”."
            : "Adicione um perfil para registrar métodos e taxas de pagamento."}
        </p>
      </CardContent>
    );
  }
  return (
    <ul className="divide-y border-t">
      {profiles.map((profile) => (
        <ProfileRow
          key={profile.id}
          onChangeLifecycle={onChangeLifecycle}
          onEdit={onEdit}
          pending={pending}
          profile={profile}
        />
      ))}
    </ul>
  );
}

interface PaymentProfileListProps extends ListBodyProps {
  includeArchived: boolean;
  onIncludeArchivedChange: (checked: boolean) => void;
}

/** The profiles of the organization, with the choice of showing the archived ones. */
export function PaymentProfileList({
  includeArchived,
  onIncludeArchivedChange,
  ...body
}: PaymentProfileListProps) {
  return (
    <Card aria-labelledby={LIST_TITLE_ID} role="region">
      <CardHeader className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <CardTitle aria-level={2} id={LIST_TITLE_ID} role="heading">
          Perfis cadastrados
        </CardTitle>
        <Field className="min-h-ctl-md w-auto" orientation="horizontal">
          <Checkbox
            checked={includeArchived}
            id="payment-archived"
            onCheckedChange={onIncludeArchivedChange}
          />
          <FieldLabel htmlFor="payment-archived">Incluir arquivados</FieldLabel>
        </Field>
      </CardHeader>
      <ListBody {...body} />
    </Card>
  );
}
