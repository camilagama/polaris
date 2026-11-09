import { buttonVariants } from "@/ui/button";
import { EMPTY_TITLE_MAX, EmptyState } from "@/ui/empty-state";

interface EmptyResultProps {
  /** `expense:create`: the Despesas tab has this button only for who can use it, under the name of its own. */
  canCreateExpense: boolean;
  period: string;
}

/**
 * The sentence names the period; a period with two years ("30 de setembro de 2025 a 30 de setembro de 2026") does not
 * fit in `EMPTY_TITLE_MAX`, so there the period goes to the line of support and the sentence says "no período".
 */
function emptyResultText(period: string) {
  const named = `Sem vendas nem despesas em ${period}`;
  return named.length <= EMPTY_TITLE_MAX
    ? {
        support: "Escolha outro período ou registre vendas e despesas.",
        title: named,
      }
    : {
        support: `${period}. Escolha outro ou registre vendas e despesas.`,
        title: "Sem vendas nem despesas no período",
      };
}

/** A period with no sale and no expense: the sentence, and the two ways to give it something to show. */
export function EmptyResult({ canCreateExpense, period }: EmptyResultProps) {
  const { support, title } = emptyResultText(period);
  return (
    <EmptyState afterRead support={support} title={title}>
      <a className={buttonVariants()} href="/sales">
        Nova venda
      </a>
      {canCreateExpense ? (
        <a
          className={buttonVariants({ variant: "outline" })}
          href="/dashboard?aba=despesas"
        >
          Nova despesa
        </a>
      ) : null}
    </EmptyState>
  );
}
