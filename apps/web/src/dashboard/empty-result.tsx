import { buttonVariants } from "@/ui/button";
import { Card, CardContent } from "@/ui/card";

interface EmptyResultProps {
  /** `expense:create`: the Despesas tab has this button only for who can use it, under the name of its own. */
  canCreateExpense: boolean;
  period: string;
}

/** A period with no sale and no expense: the sentence, and the two ways to give it something to show. */
export function EmptyResult({ canCreateExpense, period }: EmptyResultProps) {
  return (
    <Card>
      <CardContent className="grid justify-items-center gap-3 text-center">
        <div className="grid gap-1">
          <p className="font-medium">{`Sem vendas nem despesas em ${period}`}</p>
          <p className="text-muted-foreground text-support">
            Escolha outro período ou registre vendas e despesas.
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
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
        </div>
      </CardContent>
    </Card>
  );
}
