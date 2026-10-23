import type {
  PaymentFeeConfigurationReadModel,
  PaymentProfileReadModel,
  PaymentProfileRuleInput,
} from "@polaris/contracts";
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { connectionControlProps } from "../app-shell/connection-required-notice";
import { useConnectionOnline } from "../lib/browser-connection";
import { useCurrentOrganization } from "../lib/current-organization";
import { focusLater } from "../lib/focus";
import { orpcClient } from "../lib/orpc";
import {
  isConnectionFailure,
  legalAcceptanceMessage,
} from "../lib/rpc-error";
import { useReportUnsentWork } from "../lib/unsent-work";
import {
  formatFeePercentage,
  percentageFieldText,
  percentageProblem,
} from "./payment-fee-model";
import "./payment-profiles-page.css";

const methods = [
  ["pix", "Pix"],
  ["cash", "Dinheiro"],
  ["credit_card", "Cartão de crédito"],
  ["debit_card", "Cartão de débito"],
  ["bank_transfer", "Transferência bancária"],
  ["other", "Outro"],
] as const;
const feeModes = [
  ["unknown", "Desconhecida"],
  ["none", "Nenhuma"],
  ["fixed", "Valor fixo"],
  ["percentage", "Percentual"],
  ["fixed_and_percentage", "Fixo e percentual"],
] as const;
type FeeMode = PaymentFeeConfigurationReadModel["mode"];
interface FeeDraft {
  fixedAmount: string;
  mode: FeeMode;
  percentage: string;
}
interface RuleDraft {
  anticipationFee: FeeDraft;
  draftId: string;
  expectedSettlementDays: string;
  installmentPlan: "merchant" | "issuer";
  installments: string;
  method: PaymentProfileRuleInput["method"];
  processingFee: FeeDraft;
}
interface ProfileDraft {
  name: string;
  rules: RuleDraft[];
}
interface FeeFieldsProps {
  /** The text under the percentage field when it cannot be saved (U-29). */
  error: string | undefined;
  id: string;
  label: string;
  onChange: (value: FeeDraft) => void;
  value: FeeDraft;
}
interface RuleEditorProps {
  canRemove: boolean;
  /** The problems of the fields of the form, by the id of the field. */
  errors: Readonly<Record<string, string>>;
  index: number;
  onRemove: (draftId: string) => void;
  onUpdate: (draftId: string, changes: Partial<RuleDraft>) => void;
  rule: RuleDraft;
}
const blankFee = (): FeeDraft => ({
  fixedAmount: "",
  mode: "unknown",
  percentage: "",
});
const blankRule = (): RuleDraft => ({
  anticipationFee: blankFee(),
  draftId: crypto.randomUUID(),
  expectedSettlementDays: "",
  installmentPlan: "merchant",
  installments: "1",
  method: "pix",
  processingFee: blankFee(),
});
const blankDraft = (): ProfileDraft => ({ name: "", rules: [blankRule()] });

function decimalInputValue(value: string): string {
  if (value.includes(",") && value.includes(".")) {
    return value;
  }
  return value.replace(",", ".");
}
function feeDraft(fee: PaymentFeeConfigurationReadModel): FeeDraft {
  return {
    fixedAmount: fee.fixedAmount ?? "",
    mode: fee.mode,
    percentage: percentageFieldText(fee.percentage),
  };
}
function profileDraft(profile: PaymentProfileReadModel): ProfileDraft {
  return {
    name: profile.name,
    rules: profile.rules.map((rule) => ({
      anticipationFee: feeDraft(rule.anticipationFee),
      draftId: crypto.randomUUID(),
      expectedSettlementDays: rule.expectedSettlementDays?.toString() ?? "",
      installmentPlan: rule.installmentPlan ?? "merchant",
      installments: rule.installments?.toString() ?? "1",
      method: rule.method,
      processingFee: feeDraft(rule.processingFee),
    })),
  };
}
/** The draft without the ids the form makes up for its rows, to tell whether it was changed. */
function profileDraftKey(draft: ProfileDraft): string {
  return JSON.stringify({
    name: draft.name,
    rules: draft.rules.map(({ draftId: _draftId, ...rule }) => rule),
  });
}
function feeInput(fee: FeeDraft): PaymentFeeConfigurationReadModel {
  const fixed = fee.mode === "fixed" || fee.mode === "fixed_and_percentage";
  const percentage =
    fee.mode === "percentage" || fee.mode === "fixed_and_percentage";
  return {
    fixedAmount:
      fixed && fee.fixedAmount.trim() ? fee.fixedAmount.trim() : null,
    mode: fee.mode,
    percentage:
      percentage && fee.percentage.trim() ? fee.percentage.trim() : null,
  };
}
function ruleInput(rule: RuleDraft): PaymentProfileRuleInput {
  const credit = rule.method === "credit_card";
  return {
    anticipationFee: feeInput(rule.anticipationFee),
    expectedSettlementDays:
      rule.expectedSettlementDays === ""
        ? null
        : Number(rule.expectedSettlementDays),
    installmentPlan: credit ? rule.installmentPlan : null,
    installments: credit ? Number(rule.installments) : null,
    method: rule.method,
    processingFee: feeInput(rule.processingFee),
  };
}
/** The id of each percentage field of the form that cannot be saved, with what to say there (U-29). */
function percentageProblems(rules: RuleDraft[]): Record<string, string> {
  const problems: Record<string, string> = {};
  for (const rule of rules) {
    for (const [part, fee] of [
      ["processing", rule.processingFee],
      ["anticipation", rule.anticipationFee],
    ] as const) {
      const percentage =
        fee.mode === "percentage" || fee.mode === "fixed_and_percentage";
      const problem = percentage ? percentageProblem(fee.percentage) : null;
      if (problem) {
        problems[`payment-rule-${rule.draftId}-${part}-percentage`] = problem;
      }
    }
  }
  return problems;
}
/** The list was not read (no connection): it is not an empty list (U-60). */
export const PROFILES_NOT_LOADED =
  "Os perfis não carregaram. Eles aparecem quando a conexão voltar.";
/** A save whose answer the connection cut: it may have been saved, so the text never says it was not. */
export const SAVE_OUTCOME_UNKNOWN =
  "A conexão caiu antes da resposta. Não sabemos se o perfil foi salvo. Quando a internet voltar, a lista é atualizada: confira antes de salvar de novo.";
const LIFECYCLE_OUTCOME_UNKNOWN =
  "A conexão caiu antes da resposta. Não sabemos se o perfil foi alterado. Quando a internet voltar, a lista é atualizada: confira antes de tentar de novo.";

function errorText(error: unknown, subject?: string): string {
  if (
    error instanceof Error &&
    error.message === "duplicate_payment_profile_rule"
  ) {
    return "Remova regras repetidas para o mesmo método e combinação de parcelas.";
  }
  const unaccepted = legalAcceptanceMessage(error, subject);
  if (unaccepted !== undefined) {
    return unaccepted;
  }
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  if (code === "UNAUTHORIZED") {
    return "Não foi possível concluir a operação com o perfil de pagamento.";
  }
  if (code === "FORBIDDEN") {
    return "Sua conta não tem acesso a esta organização ou ação.";
  }
  if (code === "BAD_REQUEST") {
    return "Revise o método, as parcelas, o prazo e os valores das taxas.";
  }
  if (code === "CONFLICT") {
    return "Este perfil foi alterado em outra solicitação. Atualize a lista e tente novamente.";
  }
  if (code === "NOT_FOUND") {
    return "Este perfil não existe mais nesta organização.";
  }
  return "Não foi possível concluir a operação. Revise os dados e tente novamente.";
}
function feeSummary(fee: PaymentFeeConfigurationReadModel): string {
  if (fee.mode === "unknown") {
    return "desconhecida (não é zero)";
  }
  if (fee.mode === "none") {
    return "nenhuma";
  }
  return [
    fee.fixedAmount === null ? null : `R$ ${fee.fixedAmount}`,
    fee.percentage === null ? null : formatFeePercentage(fee.percentage),
  ]
    .filter(Boolean)
    .join(" + ");
}
function saveButtonLabel(pending: boolean, editing: boolean): string {
  if (pending) {
    return "Salvando…";
  }
  if (editing) {
    return "Salvar alterações";
  }
  return "Criar perfil";
}

function FeeFields({ error, id, label, value, onChange }: FeeFieldsProps) {
  const fixed = value.mode === "fixed" || value.mode === "fixed_and_percentage";
  const percentage =
    value.mode === "percentage" || value.mode === "fixed_and_percentage";
  const handleModeChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      onChange({ ...value, mode: event.target.value as FeeMode });
    },
    [onChange, value]
  );
  const handleFixedAmountChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onChange({
        ...value,
        fixedAmount: decimalInputValue(event.target.value),
      });
    },
    [onChange, value]
  );
  const handlePercentageChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onChange({ ...value, percentage: decimalInputValue(event.target.value) });
    },
    [onChange, value]
  );
  return (
    <fieldset className="payment-fee-fields">
      <legend>{label}</legend>
      <label htmlFor={`${id}-mode`}>Como a taxa é informada</label>
      <select id={`${id}-mode`} onChange={handleModeChange} value={value.mode}>
        {feeModes.map(([mode, text]) => (
          <option key={mode} value={mode}>
            {text}
          </option>
        ))}
      </select>
      {value.mode === "unknown" && (
        <p className="payment-help">
          Desconhecida significa que o valor ainda não foi informado; não
          equivale a zero.
        </p>
      )}
      {fixed && (
        <div>
          <label htmlFor={`${id}-fixed`}>Valor fixo em BRL por pagamento</label>
          <input
            id={`${id}-fixed`}
            inputMode="decimal"
            onChange={handleFixedAmountChange}
            placeholder="Ex.: 0,50"
            required
            value={value.fixedAmount}
          />
        </div>
      )}
      {percentage && (
        <div>
          <label htmlFor={`${id}-percentage`}>
            Percentual efetivo sobre o total devido
          </label>
          <input
            aria-describedby={error ? `${id}-percentage-error` : undefined}
            aria-invalid={error ? true : undefined}
            id={`${id}-percentage`}
            inputMode="decimal"
            onChange={handlePercentageChange}
            placeholder="Ex.: 2,99"
            value={value.percentage}
          />
          {error ? (
            <p className="field-error" id={`${id}-percentage-error`}>
              {error}
            </p>
          ) : null}
        </div>
      )}
    </fieldset>
  );
}

function RuleEditor({
  canRemove,
  errors,
  index,
  onRemove,
  onUpdate,
  rule,
}: RuleEditorProps) {
  const prefix = `payment-rule-${rule.draftId}`;
  const handleMethodChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      onUpdate(rule.draftId, {
        method: event.target.value as RuleDraft["method"],
      });
    },
    [onUpdate, rule.draftId]
  );
  const handleInstallmentsChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onUpdate(rule.draftId, { installments: event.target.value });
    },
    [onUpdate, rule.draftId]
  );
  const handlePlanChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      onUpdate(rule.draftId, {
        installmentPlan: event.target.value as RuleDraft["installmentPlan"],
      });
    },
    [onUpdate, rule.draftId]
  );
  const handleSettlementChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onUpdate(rule.draftId, { expectedSettlementDays: event.target.value });
    },
    [onUpdate, rule.draftId]
  );
  const handleProcessingFeeChange = useCallback(
    (processingFee: FeeDraft) => onUpdate(rule.draftId, { processingFee }),
    [onUpdate, rule.draftId]
  );
  const handleAnticipationFeeChange = useCallback(
    (anticipationFee: FeeDraft) => onUpdate(rule.draftId, { anticipationFee }),
    [onUpdate, rule.draftId]
  );
  const handleRemove = useCallback(
    () => onRemove(rule.draftId),
    [onRemove, rule.draftId]
  );

  return (
    <fieldset className="payment-rule">
      <legend>Regra {index + 1}</legend>
      <div className="payment-rule-grid">
        <div>
          <label htmlFor={`${prefix}-method`}>Método</label>
          <select
            id={`${prefix}-method`}
            onChange={handleMethodChange}
            value={rule.method}
          >
            {methods.map(([method, label]) => (
              <option key={method} value={method}>
                {label}
              </option>
            ))}
          </select>
        </div>
        {rule.method === "credit_card" && (
          <>
            <div>
              <label htmlFor={`${prefix}-installments`}>
                Número de parcelas
              </label>
              <input
                id={`${prefix}-installments`}
                max="2147483647"
                min="1"
                onChange={handleInstallmentsChange}
                required
                step="1"
                type="number"
                value={rule.installments}
              />
            </div>
            <div>
              <label htmlFor={`${prefix}-plan`}>
                Responsável pelo parcelamento
              </label>
              <select
                id={`${prefix}-plan`}
                onChange={handlePlanChange}
                value={rule.installmentPlan}
              >
                <option value="merchant">Estabelecimento</option>
                <option value="issuer">Emissor</option>
              </select>
            </div>
          </>
        )}
        <div>
          <label htmlFor={`${prefix}-settlement`}>
            Prazo esperado de recebimento (dias)
          </label>
          <input
            id={`${prefix}-settlement`}
            max="2147483647"
            min="0"
            onChange={handleSettlementChange}
            placeholder="Não informado"
            step="1"
            type="number"
            value={rule.expectedSettlementDays}
          />
          <span className="payment-help">
            É uma estimativa em dias; não representa uma confirmação de
            liquidação.
          </span>
        </div>
      </div>
      <div className="payment-fee-grid">
        <FeeFields
          error={errors[`${prefix}-processing-percentage`]}
          id={`${prefix}-processing`}
          label="Taxa de processamento"
          onChange={handleProcessingFeeChange}
          value={rule.processingFee}
        />
        <FeeFields
          error={errors[`${prefix}-anticipation-percentage`]}
          id={`${prefix}-anticipation`}
          label="Taxa de antecipação"
          onChange={handleAnticipationFeeChange}
          value={rule.anticipationFee}
        />
      </div>
      {canRemove && (
        <button
          className="payment-remove-rule"
          onClick={handleRemove}
          type="button"
        >
          Remover regra {index + 1}
        </button>
      )}
    </fieldset>
  );
}

interface ProfileCardProps {
  onChangeLifecycle: (profile: PaymentProfileReadModel) => Promise<void>;
  onEdit: (profile: PaymentProfileReadModel) => void;
  online: boolean;
  pending: boolean;
  profile: PaymentProfileReadModel;
}

function ProfileCard({
  onChangeLifecycle,
  onEdit,
  online,
  pending,
  profile,
}: ProfileCardProps) {
  const handleEdit = useCallback(() => onEdit(profile), [onEdit, profile]);
  const handleLifecycle = useCallback(() => {
    // offline nothing leaves: the button says why (aria-describedby on the notice)
    if (online) {
      onChangeLifecycle(profile).catch(() => undefined);
    }
  }, [onChangeLifecycle, online, profile]);
  const statusLabel = profile.status === "active" ? "Ativo" : "Arquivado";
  const lifecycleLabel = profile.status === "active" ? "Arquivar" : "Restaurar";
  return (
    <li className="payment-profile-card">
      <div className="payment-profile-title">
        <h3>{profile.name}</h3>
        <span
          className={
            profile.status === "active"
              ? "payment-status is-active"
              : "payment-status is-archived"
          }
        >
          {statusLabel}
        </span>
      </div>
      <p>
        {profile.rules.length} {profile.rules.length === 1 ? "regra" : "regras"}
      </p>
      <ul>
        {profile.rules.map((rule) => (
          <li key={rule.id}>
            {methods.find(([method]) => method === rule.method)?.[1]}
            {rule.method === "credit_card" &&
              ` · ${rule.installments}x · ${rule.installmentPlan === "issuer" ? "emissor" : "estabelecimento"}`}
            {" · Liquidação: "}
            {rule.expectedSettlementDays === null
              ? "não informada"
              : `${rule.expectedSettlementDays} dias`}
            <br />
            <span>
              Processamento: {feeSummary(rule.processingFee)} · Antecipação:{" "}
              {feeSummary(rule.anticipationFee)}
            </span>
          </li>
        ))}
      </ul>
      <div className="payment-card-actions">
        {profile.status === "active" && (
          <button
            className="category-button"
            disabled={pending}
            onClick={handleEdit}
            type="button"
          >
            Editar
          </button>
        )}
        <button
          {...connectionControlProps(online)}
          className="category-button"
          disabled={pending}
          onClick={handleLifecycle}
          type="button"
        >
          {lifecycleLabel}
        </button>
      </div>
    </li>
  );
}

interface ProfileListContentProps {
  loading: boolean;
  /** The list could not be read for lack of a connection: never shown as "no profile". */
  notLoaded: boolean;
  onChangeLifecycle: (profile: PaymentProfileReadModel) => Promise<void>;
  onEdit: (profile: PaymentProfileReadModel) => void;
  online: boolean;
  pending: boolean;
  profiles: PaymentProfileReadModel[];
}

function ProfileListContent({
  loading,
  notLoaded,
  onChangeLifecycle,
  onEdit,
  online,
  pending,
  profiles,
}: ProfileListContentProps) {
  if (loading) {
    return <p role="status">Carregando perfis…</p>;
  }
  if (notLoaded) {
    return (
      <p className="payment-empty" role="status">
        {PROFILES_NOT_LOADED}
      </p>
    );
  }
  if (profiles.length === 0) {
    return (
      <div className="payment-empty">
        <h3>Nenhum perfil cadastrado</h3>
        <p>Adicione um perfil para registrar métodos e taxas de pagamento.</p>
      </div>
    );
  }
  return (
    <ul className="payment-profile-list">
      {profiles.map((profile) => (
        <ProfileCard
          key={profile.id}
          onChangeLifecycle={onChangeLifecycle}
          onEdit={onEdit}
          online={online}
          pending={pending}
          profile={profile}
        />
      ))}
    </ul>
  );
}

export function PaymentProfilesPage() {
  const { organizationId } = useCurrentOrganization();
  const [profiles, setProfiles] = useState<PaymentProfileReadModel[]>([]);
  const [draft, setDraft] = useState<ProfileDraft>(blankDraft);
  const [editing, setEditing] = useState<PaymentProfileReadModel | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // only a failed read can be tried again; a refused save is fixed in the form
  const [canRetry, setCanRetry] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const online = useConnectionOnline();
  // the list was not read for lack of a connection (not an empty list); read again when it returns
  const [notLoaded, setNotLoaded] = useState(false);
  // a save the connection cut: amber, the form stays; `name` is looked for in the list read on the return
  const [uncertain, setUncertain] = useState<{
    message: string;
    name: string | null;
  } | null>(null);
  const uncertainRef = useRef(uncertain);
  uncertainRef.current = uncertain;
  useReportUnsentWork(
    !pending &&
      profileDraftKey(draft) !==
        profileDraftKey(editing ? profileDraft(editing) : blankDraft())
  );
  // only a read: a save whose answer was cut is never sent again from here
  const loadProfiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    setCanRetry(false);
    try {
      const result = await orpcClient.paymentProfile.list({
        organizationId,
        status: "all",
      });
      setProfiles(result.profiles);
      setNotLoaded(false);
      const cut = uncertainRef.current;
      if (cut) {
        const saved =
          cut.name !== null &&
          result.profiles.some((profile) => profile.name === cut.name);
        setUncertain(null);
        if (saved) {
          setNotice(`O perfil “${cut.name}” foi salvo.`);
          setDraft(blankDraft());
        }
      }
    } catch (loadError) {
      if (isConnectionFailure(loadError)) {
        setNotLoaded(true);
      } else {
        setError(errorText(loadError, "os perfis de pagamento"));
        setCanRetry(true);
      }
    } finally {
      setLoading(false);
    }
  }, [organizationId]);
  useEffect(() => {
    loadProfiles().catch(() => undefined);
  }, [loadProfiles]);
  // the connection came back: the list that did not load, or that a cut save may have changed, is read again
  const wasOnline = useRef(online);
  useEffect(() => {
    const cameBack = online && !wasOnline.current;
    wasOnline.current = online;
    if (cameBack && (notLoaded || uncertainRef.current)) {
      loadProfiles().catch(() => undefined);
    }
  }, [loadProfiles, notLoaded, online]);
  const handleRetry = useCallback(() => {
    loadProfiles().catch(() => undefined);
  }, [loadProfiles]);
  const updateRule = useCallback(
    (draftId: string, changes: Partial<RuleDraft>) => {
      setFieldErrors({});
      setDraft((current) => ({
        ...current,
        rules: current.rules.map((rule) =>
          rule.draftId === draftId ? { ...rule, ...changes } : rule
        ),
      }));
    },
    []
  );
  const handleNameChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setFieldErrors({});
      setDraft((current) => ({ ...current, name: event.target.value }));
    },
    []
  );
  const handleAddRule = useCallback(() => {
    setDraft((current) => ({
      ...current,
      rules: [...current.rules, blankRule()],
    }));
  }, []);
  const handleRemoveRule = useCallback((draftId: string) => {
    setDraft((current) => ({
      ...current,
      rules: current.rules.filter((rule) => rule.draftId !== draftId),
    }));
  }, []);
  const handleCancelEdit = useCallback(() => {
    setEditing(null);
    setDraft(blankDraft());
  }, []);
  const handleArchivedChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setShowArchived(event.target.checked);
    },
    []
  );
  const saveProfile = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      // offline nothing leaves and nothing typed is touched: the button says why
      if (!(online && draft.rules.length)) {
        return;
      }
      const problems = percentageProblems(draft.rules);
      setFieldErrors(problems);
      const [firstProblem] = Object.keys(problems);
      if (firstProblem) {
        // said at the field, with the limit; nothing goes to the server and nothing typed is touched (U-29)
        setError(null);
        setNotice(null);
        focusLater(() => document.getElementById(firstProblem)?.focus());
        return;
      }
      setPending(true);
      setError(null);
      setCanRetry(false);
      setNotice(null);
      setUncertain(null);
      try {
        const ruleKeys = draft.rules.map((rule) =>
          [
            rule.method,
            rule.method === "credit_card" ? rule.installmentPlan : "",
            rule.method === "credit_card"
              ? String(Number(rule.installments))
              : "",
          ].join("|")
        );
        if (new Set(ruleKeys).size !== ruleKeys.length) {
          throw new Error("duplicate_payment_profile_rule");
        }
        const rules = draft.rules.map(ruleInput);
        if (editing) {
          await orpcClient.paymentProfile.update({
            expectedVersion: editing.version,
            id: editing.id,
            name: draft.name.trim(),
            organizationId,
            rules,
          });
          setNotice(`Perfil “${draft.name.trim()}” atualizado.`);
        } else {
          await orpcClient.paymentProfile.create({
            name: draft.name.trim(),
            organizationId,
            rules,
          });
          setNotice(`Perfil “${draft.name.trim()}” criado.`);
        }
        setEditing(null);
        setDraft(blankDraft());
        await loadProfiles();
      } catch (saveError) {
        if (isConnectionFailure(saveError)) {
          const name = draft.name.trim();
          // a name already on the list before would prove nothing on the return
          const provable =
            !editing && !profiles.some((profile) => profile.name === name);
          setUncertain({
            message: SAVE_OUTCOME_UNKNOWN,
            name: provable ? name : null,
          });
        } else {
          setError(errorText(saveError));
        }
      } finally {
        setPending(false);
      }
    },
    [draft, editing, loadProfiles, online, organizationId, profiles]
  );
  const editProfile = useCallback((profile: PaymentProfileReadModel) => {
    setEditing(profile);
    setDraft(profileDraft(profile));
    setError(null);
    setNotice(null);
    document.getElementById("payment-profile-name")?.focus();
  }, []);
  const changeLifecycle = useCallback(
    async (profile: PaymentProfileReadModel) => {
      setPending(true);
      setError(null);
      setCanRetry(false);
      setNotice(null);
      setUncertain(null);
      try {
        const input = {
          expectedVersion: profile.version,
          id: profile.id,
          organizationId,
        };
        if (profile.status === "active") {
          await orpcClient.paymentProfile.archive(input);
          setNotice(`Perfil “${profile.name}” arquivado.`);
        } else {
          await orpcClient.paymentProfile.restore(input);
          setNotice(`Perfil “${profile.name}” restaurado.`);
        }
        await loadProfiles();
      } catch (actionError) {
        if (isConnectionFailure(actionError)) {
          setUncertain({ message: LIFECYCLE_OUTCOME_UNKNOWN, name: null });
        } else {
          setError(errorText(actionError));
        }
      } finally {
        setPending(false);
      }
    },
    [loadProfiles, organizationId]
  );
  const visibleProfiles = profiles.filter(
    (profile) => showArchived || profile.status === "active"
  );
  return (
    <div className="payment-profiles-page">
      <section className="categories-heading">
        <div>
          <p className="categories-eyebrow">Configuração comercial</p>
          <h1>Perfis de pagamento</h1>
          <p className="categories-intro-copy">
            Organize métodos, parcelamento, prazo de liquidação e taxas por
            perfil.
          </p>
        </div>
      </section>
      {error && (
        <p className="payment-message is-error" role="alert">
          {error}
          {canRetry ? (
            <>
              {" "}
              <button onClick={handleRetry} type="button">
                Tentar novamente
              </button>
            </>
          ) : null}
        </p>
      )}
      {notice && (
        <p className="payment-message is-success" role="status">
          {notice}
        </p>
      )}
      {uncertain && (
        <p className="payment-message is-warning" role="status">
          {uncertain.message}
        </p>
      )}
      <section className="payment-workspace">
        <form className="payment-form" onSubmit={saveProfile}>
          <div className="payment-form-heading">
            <h2>{editing ? "Editar perfil" : "Novo perfil"}</h2>
            {editing && (
              <button
                className="category-button"
                onClick={handleCancelEdit}
                type="button"
              >
                Cancelar edição
              </button>
            )}
          </div>
          <label htmlFor="payment-profile-name">Nome do perfil</label>
          <input
            autoComplete="off"
            id="payment-profile-name"
            maxLength={100}
            onChange={handleNameChange}
            required
            value={draft.name}
          />
          <div className="payment-rules-heading">
            <h3>Regras de pagamento</h3>
            <button
              className="category-button"
              onClick={handleAddRule}
              type="button"
            >
              Adicionar regra
            </button>
          </div>
          {draft.rules.map((rule, index) => (
            <RuleEditor
              canRemove={draft.rules.length > 1}
              errors={fieldErrors}
              index={index}
              key={rule.draftId}
              onRemove={handleRemoveRule}
              onUpdate={updateRule}
              rule={rule}
            />
          ))}
          <button
            {...connectionControlProps(online)}
            className="category-button is-primary"
            disabled={pending}
            type="submit"
          >
            {saveButtonLabel(pending, editing !== null)}
          </button>
        </form>
        <section aria-labelledby="payment-list-title" className="payment-list">
          <div className="payment-list-heading">
            <h2 id="payment-list-title">Perfis cadastrados</h2>
            <label className="payment-archived-toggle">
              <input
                checked={showArchived}
                onChange={handleArchivedChange}
                type="checkbox"
              />{" "}
              Incluir arquivados
            </label>
          </div>
          <ProfileListContent
            loading={loading && online}
            notLoaded={notLoaded || (loading && !online)}
            onChangeLifecycle={changeLifecycle}
            onEdit={editProfile}
            online={online}
            pending={pending}
            profiles={visibleProfiles}
          />
        </section>
      </section>
    </div>
  );
}
