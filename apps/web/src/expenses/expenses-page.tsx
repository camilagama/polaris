import type { ExpenseReadModel } from "@polaris/contracts";
import PlusIcon from "lucide-react/dist/esm/icons/plus";
import { useCallback, useMemo, useRef, useState } from "react";
import { Button } from "@/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";
import { Dialog, DialogContent } from "@/ui/dialog";
import { Tabs, TabsContent, TabsTrigger } from "@/ui/tabs";
import { ScreenTitle } from "../app-shell/screen-title";
import { ScreenTabList } from "../app-shell/screen-tabs";
import { connectionControlProps } from "../app-shell/connection-required-notice";
import { useConnectionOnline } from "../lib/browser-connection";
import { useCurrentOrganization } from "../lib/current-organization";
import { invalidatePreviousWindow } from "../home/previous-window-copy";
import { browserStorage } from "../lib/current-organization-model";
import { focusLater } from "../lib/focus";
import { orpcClient } from "../lib/orpc";
import { markPeriodSummaryStale } from "../lib/period-summary-stale";
import { ExpenseCategoriesPanel } from "./expense-categories-panel";
import { ActionNotice, LoadError } from "./expense-fields";
import { ExpenseForm } from "./expense-form";
import {
  ExpenseCategoryFilter,
  ExpenseList,
  ExpenseStatusTabs,
  ExpenseSummary,
} from "./expense-list";
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
import { useStoreToday } from "./use-store-today";

type StatusChange = "restore" | "void";

/**
 * What the person chose. While `chosenMonth` is null the month follows the store's day, so it moves to the new month
 * at the turn (one read of the list); a month picked by hand stays, and the turn reads nothing.
 */
interface ExpenseChoices {
  categoryId: string;
  chosenMonth: string | null;
  status: ExpenseFilters["status"];
}

function restoredMessage(competenceOn: string, shownMonth: string): string {
  const month = monthOfDay(competenceOn);
  return month === shownMonth
    ? "Despesa reativada."
    : `Despesa reativada. Ela pertence a ${formatMonthLabel(month)}, que não é o mês exibido.`;
}

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

/** The home's copy of the days before the month no longer holds once an expense of a past competence changed here. */
function dropPreviousWindow(organizationId: string, competences: string[]) {
  for (const competenceOn of competences) {
    invalidatePreviousWindow(browserStorage(), organizationId, competenceOn);
  }
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
  const today = useStoreToday(organization.timezone);
  const [view, selectView] = useExpenseView();
  const [choices, setChoices] = useState<ExpenseChoices>({
    categoryId: "",
    chosenMonth: null,
    status: "active",
  });
  const filters = useMemo<ExpenseFilters>(
    () => ({
      categoryId: choices.categoryId,
      month: choices.chosenMonth ?? monthOfDay(today),
      status: choices.status,
    }),
    [choices, today]
  );
  const { busy, clearFeedback, feedback, run } = useCommandRunner();
  const online = useConnectionOnline();
  const noticeRef = useRef<HTMLDivElement>(null);
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
        dropPreviousWindow(
          organizationId,
          target
            ? [input.competenceOn, target.competenceOn]
            : [input.competenceOn]
        );
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
    async (
      expense: ExpenseReadModel,
      change: StatusChange,
      fromUndo = false
    ) => {
      const input = {
        expectedVersion: expense.version,
        id: expense.id,
        organizationId,
      };
      const outcome = await run(
        `${change}:${expense.id}`,
        change,
        async () => {
          if (change === "void") {
            const result = await orpcClient.expense.void(input);
            const text = `Despesa “${expense.description}” anulada.`;
            return result.changed ? { text, undo: result.expense } : text;
          }
          await orpcClient.expense.restore(input);
          return restoredMessage(expense.competenceOn, filters.month);
        },
        fromUndo ? expense : undefined
      );
      if (outcome === "ok") {
        markPeriodSummaryStale();
        dropPreviousWindow(organizationId, [expense.competenceOn]);
      }
      if (outcome !== "failed") {
        if (editing?.id === expense.id) {
          closeForm();
        }
        await refresh();
      }
      if (outcome === "ok" || fromUndo) {
        // the button that was pressed left the list with the row, or "Desfazer" was drawn again: the notice takes the focus
        focusLater(() => noticeRef.current?.focus());
      }
    },
    [closeForm, editing?.id, filters.month, organizationId, refresh, run]
  );

  const undo = feedback?.undo;
  const handleUndo = useCallback(() => {
    if (undo) {
      handleStatusChange(undo, "restore", true);
    }
  }, [handleStatusChange, undo]);
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
    (month: string) =>
      setChoices((current) => ({ ...current, chosenMonth: month })),
    []
  );
  const handleFilters = useCallback(
    (next: ExpenseFilters) =>
      setChoices((current) => ({
        ...current,
        categoryId: next.categoryId,
        status: next.status,
      })),
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
          {/* the month and the category on one line: the list and its first expense come in the first screen */}
          <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-3 min-[30rem]:flex min-[30rem]:flex-wrap">
            <MonthPicker
              currentMonth={monthOfDay(today)}
              id="expense-month"
              label="Mês de competência"
              month={filters.month}
              onChange={handleMonth}
            />
            <ExpenseCategoryFilter
              categories={categories.state.categories}
              filters={filters}
              onChange={handleFilters}
            />
          </div>
          {/* while the form is open it covers the screen: what the commands say is said inside it */}
          <ActionNotice
            errorRef={noticeRef}
            feedback={form.open ? null : feedback}
            noticeRef={noticeRef}
            onUndo={undo ? handleUndo : undefined}
            undoDisabled={busy !== null || !online}
            undoReasonId={connectionControlProps(online)["aria-describedby"]}
          />
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
            <CardHeader className="gap-3">
              <div className="flex items-center justify-between gap-x-3 gap-y-2">
                <CardTitle aria-level={2} id={LIST_TITLE_ID} role="heading">
                  Despesas do período
                </CardTitle>
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
              <ExpenseSummary filters={filters} state={state} />
            </CardHeader>
            <CardContent className="grid gap-4">
              <ExpenseStatusTabs filters={filters} onChange={handleFilters} />
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
