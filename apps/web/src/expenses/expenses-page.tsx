import type { ExpenseReadModel } from "@polaris/contracts";
import { useCallback, useMemo, useState } from "react";
import { useCurrentOrganization } from "../lib/current-organization";
import { calendarDayInTimezone } from "../lib/dates";
import { focusLater } from "../lib/focus";
import { orpcClient } from "../lib/orpc";
import { ExpenseCategoriesPanel } from "./expense-categories-panel";
import { ExpenseForm } from "./expense-form";
import { ExpenseFiltersBar, ExpenseList, ExpenseSummary } from "./expense-list";
import {
  type ExpenseInput,
  formatMonthLabel,
  monthOfDay,
} from "./expense-model";
import { ExpenseRulesPanel } from "./expense-rules-panel";
import { FeedbackMessage } from "./feedback-message";
import { useCommandRunner } from "./use-command-runner";
import { useExpenseCategories } from "./use-expense-categories";
import { type ExpenseFilters, useExpenseList } from "./use-expense-list";
import "./expenses-page.css";

type StatusChange = "restore" | "void";

function savedMessage(
  editing: boolean,
  competenceOn: string,
  shownMonth: string
): string {
  const base = editing ? "Despesa atualizada." : "Despesa registrada.";
  const month = monthOfDay(competenceOn);
  return month === shownMonth
    ? base
    : `${base} Ela pertence a ${formatMonthLabel(month)}, que não é o mês exibido.`;
}

function Heading() {
  return (
    <section className="categories-heading">
      <div>
        <p className="categories-eyebrow">Resultado</p>
        <h1>Despesas</h1>
        <p className="categories-intro-copy">
          Cada despesa pertence ao mês de competência, o período a que ela se
          refere, e não à data do pagamento. Comprar estoque não é despesa: o
          custo entra quando o produto é vendido. Taxas de cartão e de
          antecipação já registradas na venda não devem ser lançadas de novo.
        </p>
      </div>
    </section>
  );
}

/** The expenses screen: online only, every figure comes from the server. */
export function ExpensesPage() {
  const { organization, organizationId } = useCurrentOrganization();
  const today = useMemo(
    () => calendarDayInTimezone(new Date(), organization.timezone),
    [organization.timezone]
  );
  const [filters, setFilters] = useState<ExpenseFilters>(() => ({
    categoryId: "",
    month: monthOfDay(today),
    status: "active",
  }));
  const [editing, setEditing] = useState<ExpenseReadModel | null>(null);
  const [formCount, setFormCount] = useState(0);
  const { busy, clearFeedback, feedback, run } = useCommandRunner();
  const categories = useExpenseCategories(organizationId);
  const { loadMore, refresh, state } = useExpenseList(organizationId, filters);
  const reloadCategories = categories.reload;

  const resetForm = useCallback(() => {
    setEditing(null);
    setFormCount((count) => count + 1);
  }, []);

  const handleSave = useCallback(
    async (input: ExpenseInput) => {
      const target = editing;
      const outcome = await run(
        target ? `save:${target.id}` : "create",
        "save",
        async () => {
          if (target) {
            await orpcClient.expense.update({
              ...input,
              expectedVersion: target.version,
              id: target.id,
              organizationId,
              saleId: target.saleId,
            });
          } else {
            await orpcClient.expense.create({ ...input, organizationId });
          }
          return savedMessage(
            target !== null,
            input.competenceOn,
            filters.month
          );
        }
      );
      if (outcome === "failed") {
        return false;
      }
      resetForm();
      await refresh();
      if (outcome === "conflict") {
        await reloadCategories();
      }
      return outcome === "ok";
    },
    [
      editing,
      filters.month,
      organizationId,
      refresh,
      reloadCategories,
      resetForm,
      run,
    ]
  );

  const handleStatusChange = useCallback(
    async (expense: ExpenseReadModel, change: StatusChange) => {
      const input = {
        expectedVersion: expense.version,
        id: expense.id,
        organizationId,
      };
      const outcome = await run(`${change}:${expense.id}`, change, async () => {
        if (change === "void") {
          await orpcClient.expense.void(input);
          return "Despesa anulada. Ela deixa de somar no período e pode ser reativada.";
        }
        await orpcClient.expense.restore(input);
        return "Despesa reativada.";
      });
      if (outcome !== "failed") {
        if (editing?.id === expense.id) {
          resetForm();
        }
        await refresh();
      }
    },
    [editing?.id, organizationId, refresh, resetForm, run]
  );

  const handleVoid = useCallback(
    (expense: ExpenseReadModel) => handleStatusChange(expense, "void"),
    [handleStatusChange]
  );
  const handleRestore = useCallback(
    (expense: ExpenseReadModel) => handleStatusChange(expense, "restore"),
    [handleStatusChange]
  );

  const handleEdit = useCallback(
    (expense: ExpenseReadModel) => {
      clearFeedback();
      setEditing(expense);
      focusLater(() => document.getElementById("expense-amount")?.focus());
    },
    [clearFeedback]
  );

  // The server generates the occurrences that fell due when the list is read,
  // so a changed rule means the list (and the month total) must be read again.
  const handleRulesChanged = useCallback(async () => {
    await Promise.all([refresh(), reloadCategories()]);
  }, [refresh, reloadCategories]);

  const handleRetry = useCallback(() => {
    refresh();
  }, [refresh]);
  const handleCategoriesRetry = useCallback(() => {
    reloadCategories();
  }, [reloadCategories]);

  const isSaving = busy === "create" || (busy?.startsWith("save:") ?? false);

  return (
    <div className="expenses-page">
      <Heading />
      <FeedbackMessage feedback={feedback} />
      {categories.state.error ? (
        <p className="categories-message is-error" role="alert">
          {categories.state.error}{" "}
          <button
            className="quiet-button"
            disabled={categories.state.isLoading}
            onClick={handleCategoriesRetry}
            type="button"
          >
            Tentar de novo
          </button>
        </p>
      ) : null}

      <ExpenseForm
        categories={categories.state.categories}
        disabled={busy !== null}
        editing={editing}
        key={editing ? `${editing.id}:${editing.version}` : `new:${formCount}`}
        onCancel={resetForm}
        onSave={handleSave}
        saving={isSaving}
        today={today}
      />

      <section aria-labelledby="expense-list-heading" className="expense-panel">
        <div className="expense-panel-heading">
          <div>
            <p className="categories-eyebrow">Registros da organização</p>
            <h2 id="expense-list-heading">Despesas do período</h2>
          </div>
        </div>
        <div className="expense-list-body">
          <ExpenseFiltersBar
            categories={categories.state.categories}
            filters={filters}
            onChange={setFilters}
          />
          <ExpenseSummary filters={filters} state={state} />
          <ExpenseList
            busyKey={busy}
            filters={filters}
            onEdit={handleEdit}
            onLoadMore={loadMore}
            onRestore={handleRestore}
            onRetry={handleRetry}
            onVoid={handleVoid}
            state={state}
          />
        </div>
      </section>

      <ExpenseRulesPanel
        categories={categories.state.categories}
        onChanged={handleRulesChanged}
        organizationId={organizationId}
        today={today}
      />

      <ExpenseCategoriesPanel
        onReload={reloadCategories}
        onUpsert={categories.upsert}
        organizationId={organizationId}
        state={categories.state}
      />
    </div>
  );
}
