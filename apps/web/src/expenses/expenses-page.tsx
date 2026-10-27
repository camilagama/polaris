import type { ExpenseReadModel } from "@polaris/contracts";
import PlusIcon from "lucide-react/dist/esm/icons/plus";
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";
import { Dialog, DialogContent } from "@/ui/dialog";
import { Tabs, TabsContent, TabsTrigger } from "@/ui/tabs";
import { ScreenTitle } from "../app-shell/screen-title";
import { ScreenTabList } from "../app-shell/screen-tabs";
import { useCurrentOrganization } from "../lib/current-organization";
import { calendarDayInTimezone } from "../lib/dates";
import { focusLater } from "../lib/focus";
import { orpcClient } from "../lib/orpc";
import { markPeriodSummaryStale } from "../lib/period-summary-stale";
import { ExpenseCategoriesPanel } from "./expense-categories-panel";
import { ActionNotice, LoadError } from "./expense-fields";
import { ExpenseForm } from "./expense-form";
import { ExpenseFiltersBar, ExpenseList, ExpenseSummary } from "./expense-list";
import {
  type ExpenseDraft,
  type ExpenseInput,
  formatMonthLabel,
  monthOfDay,
} from "./expense-model";
import { ExpenseRulesPanel } from "./expense-rules-panel";
import { EXPENSE_VIEWS, useExpenseView } from "./expense-view";
import { MonthPicker } from "./month-picker";
import { useCommandRunner } from "./use-command-runner";
import { useExpenseCategories } from "./use-expense-categories";
import { type ExpenseFilters, useExpenseList } from "./use-expense-list";
import { useFormDialog } from "./use-form-dialog";

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
      <ScreenTitle>Despesas</ScreenTitle>
      <p className="text-muted-foreground text-support">
        Cada despesa conta no mês de competência, não no dia do pagamento.
      </p>
    </header>
  );
}

const LIST_TITLE_ID = "expense-list-title";

/** What opened the form (or, when its row left the list, the button of a new one): "Nova despesa" or the "Editar" of the expense. */
function expenseFormOrigin(next: ExpenseReadModel | "new") {
  return next === "new"
    ? () => document.querySelector<HTMLElement>("[data-expense-new]")
    : () =>
        document.querySelector<HTMLElement>(
          `[data-expense-id="${next.id}"] [data-expense-edit]`
        ) ?? document.querySelector<HTMLElement>("[data-expense-new]");
}

/** The focus fell to the page (what had it left the list): "Nova despesa" takes it. */
function focusNewWhenLost() {
  if (document.activeElement === document.body) {
    document.querySelector<HTMLElement>("[data-expense-new]")?.focus();
  }
}

/**
 * The expenses screen, the Despesas tab of the Resultado: online only, every figure comes from the server. Three parts
 * in a segmented list, named in the address (`?ver=`): the expenses of the month, the recurring rules and the
 * categories. Every form is a dialog; the three parts stay mounted, so a filter or a ticked box survives a change of part.
 */
export function ExpensesPage() {
  const { organization, organizationId } = useCurrentOrganization();
  const today = useMemo(
    () => calendarDayInTimezone(new Date(), organization.timezone),
    [organization.timezone]
  );
  const [view, selectView] = useExpenseView();
  const [filters, setFilters] = useState<ExpenseFilters>(() => ({
    categoryId: "",
    month: monthOfDay(today),
    status: "active",
  }));
  const { busy, clearFeedback, feedback, run } = useCommandRunner();
  const categories = useExpenseCategories(organizationId);
  const { loadMore, refresh, state } = useExpenseList(organizationId, filters);
  const reloadCategories = categories.reload;
  const form = useFormDialog<ExpenseReadModel, ExpenseDraft>({
    busy: busy !== null,
    onOpen: clearFeedback,
    originOf: expenseFormOrigin,
  });
  const { close: closeForm, editing, openForm } = form;

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
      if (outcome === "ok") {
        markPeriodSummaryStale();
      }
      closeForm();
      await refresh();
      // the dialog may have finished closing before the list was read again: the focus went back to the "Editar" of a
      // row the save took out of the list (another month), and fell to the page with it
      focusLater(focusNewWhenLost);
      if (outcome === "conflict") {
        await reloadCategories();
      }
      return outcome === "ok";
    },
    [
      closeForm,
      editing,
      filters.month,
      organizationId,
      refresh,
      reloadCategories,
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
      if (outcome === "ok") {
        markPeriodSummaryStale();
      }
      if (outcome !== "failed") {
        if (editing?.id === expense.id) {
          closeForm();
        }
        await refresh();
      }
    },
    [closeForm, editing?.id, organizationId, refresh, run]
  );

  const handleVoid = useCallback(
    (expense: ExpenseReadModel) => handleStatusChange(expense, "void"),
    [handleStatusChange]
  );
  const handleRestore = useCallback(
    (expense: ExpenseReadModel) => handleStatusChange(expense, "restore"),
    [handleStatusChange]
  );
  const handleNew = useCallback(() => openForm("new"), [openForm]);
  const handleMonth = useCallback(
    (month: string) => setFilters((current) => ({ ...current, month })),
    []
  );

  // The server generates the occurrences that fell due when the list is read,
  // so a changed rule means the list (and the month total) must be read again.
  const handleRulesChanged = useCallback(async () => {
    await Promise.all([refresh(), reloadCategories()]);
    // after the list: the occurrences are generated by that read, and the result adds them up
    markPeriodSummaryStale();
  }, [refresh, reloadCategories]);

  const handleRetry = useCallback(() => {
    refresh();
  }, [refresh]);
  const handleCategoriesRetry = useCallback(() => {
    reloadCategories();
  }, [reloadCategories]);

  const isSaving = busy === "create" || (busy?.startsWith("save:") ?? false);

  return (
    <div className="grid gap-4 font-sans text-foreground text-sm antialiased">
      <Heading />
      {categories.state.error ? (
        <LoadError
          busy={categories.state.isLoading}
          message={categories.state.error}
          onRetry={handleCategoriesRetry}
        />
      ) : null}
      <Tabs className="min-w-0 gap-4" onValueChange={selectView} value={view}>
        <ScreenTabList
          label="Lançamentos, recorrentes e categorias"
          value={view}
        >
          {/* below 360 px a narrower padding keeps the three parts on screen, with no sideways scroll */}
          {EXPENSE_VIEWS.map((item) => (
            <TabsTrigger
              className="flex-none max-[22.5rem]:px-1.5"
              data-value={item.value}
              key={item.value}
              value={item.value}
            >
              {item.label}
            </TabsTrigger>
          ))}
        </ScreenTabList>

        <TabsContent className="grid gap-4" keepMounted value="lancamentos">
          {/* the month at the top of the part, beside the way to a new expense */}
          <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
            <MonthPicker
              currentMonth={monthOfDay(today)}
              id="expense-month"
              label="Mês de competência"
              month={filters.month}
              onChange={handleMonth}
            />
            <Button
              data-expense-new=""
              disabled={busy !== null}
              onClick={handleNew}
              type="button"
            >
              <PlusIcon aria-hidden="true" data-icon="inline-start" />
              Nova despesa
            </Button>
          </div>
          {/* while the form is open it covers the screen: what the commands say is said inside it */}
          <ActionNotice feedback={form.open ? null : feedback} />
          <Dialog disablePointerDismissal {...form.dialog}>
            <DialogContent finalFocus={form.finalFocus} layout="form">
              <ExpenseForm
                categories={categories.state.categories}
                disabled={busy !== null}
                editing={editing}
                feedback={feedback?.kind === "error" ? feedback : null}
                key={form.formKey}
                keptDraft={form.keptDraft}
                onCancel={closeForm}
                onDraftChange={form.onDraftChange}
                onSave={handleSave}
                saving={isSaving}
                today={today}
              />
            </DialogContent>
          </Dialog>
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
                onEdit={openForm}
                onLoadMore={loadMore}
                onRestore={handleRestore}
                onRetry={handleRetry}
                onVoid={handleVoid}
                state={state}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent keepMounted value="recorrentes">
          <ExpenseRulesPanel
            categories={categories.state.categories}
            onChanged={handleRulesChanged}
            organizationId={organizationId}
            today={today}
          />
        </TabsContent>

        <TabsContent keepMounted value="categorias">
          <ExpenseCategoriesPanel
            onReload={reloadCategories}
            onUpsert={categories.upsert}
            organizationId={organizationId}
            state={categories.state}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
