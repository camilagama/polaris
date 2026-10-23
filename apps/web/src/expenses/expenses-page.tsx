import type { ExpenseReadModel } from "@polaris/contracts";
import { useCallback, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";
import { useCurrentOrganization } from "../lib/current-organization";
import { calendarDayInTimezone } from "../lib/dates";
import { focusLater } from "../lib/focus";
import { orpcClient } from "../lib/orpc";
import { ExpenseCategoriesPanel } from "./expense-categories-panel";
import { FeedbackMessage, LoadError } from "./expense-fields";
import { ExpenseForm } from "./expense-form";
import { ExpenseFiltersBar, ExpenseList, ExpenseSummary } from "./expense-list";
import {
  type ExpenseInput,
  formatMonthLabel,
  monthOfDay,
} from "./expense-model";
import { ExpenseRulesPanel } from "./expense-rules-panel";
import { useCommandRunner } from "./use-command-runner";
import { useExpenseCategories } from "./use-expense-categories";
import { type ExpenseFilters, useExpenseList } from "./use-expense-list";

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
    <header className="grid gap-1">
      <h1 className="text-title">Despesas</h1>
      <p className="text-muted-foreground text-support">
        Cada despesa conta no mês de competência, não no dia do pagamento.
      </p>
    </header>
  );
}

const LIST_TITLE_ID = "expense-list-title";

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
    <div
      className="grid gap-4 font-sans text-foreground text-sm antialiased"
      data-ui=""
    >
      <Heading />
      <FeedbackMessage feedback={feedback} />
      {categories.state.error ? (
        <LoadError
          busy={categories.state.isLoading}
          message={categories.state.error}
          onRetry={handleCategoriesRetry}
        />
      ) : null}

      {/* from 900 px, the form beside the list (as Perfis de pagamento); below, one column, the form first */}
      <div className="grid items-start gap-4 min-[56.25rem]:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
        <ExpenseForm
          categories={categories.state.categories}
          disabled={busy !== null}
          editing={editing}
          key={
            editing ? `${editing.id}:${editing.version}` : `new:${formCount}`
          }
          onCancel={resetForm}
          onSave={handleSave}
          saving={isSaving}
          today={today}
        />

        <Card aria-labelledby={LIST_TITLE_ID} role="region">
          <CardHeader>
            <CardTitle aria-level={2} id={LIST_TITLE_ID} role="heading">
              Despesas do período
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
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
          </CardContent>
        </Card>
      </div>

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
