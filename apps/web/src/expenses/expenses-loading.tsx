import { Skeleton } from "@/ui/skeleton";

/**
 * The Despesas screen while its chunk loads: the shape of the screen of an empty month (the heading, the parts, the month
 * and the card of the list), so the screen that comes takes the place of the skeleton instead of growing out of a
 * short "Carregando…".
 */
export function ExpensesLoading() {
  return (
    <div className="grid grid-cols-1 gap-4" role="status">
      <span className="sr-only">Carregando as despesas…</span>
      <div aria-hidden="true" className="grid gap-1">
        <div className="flex h-5 items-center">
          <Skeleton className="h-4 w-20" />
        </div>
        <Skeleton className="h-9 w-full max-w-xl md:h-[1.125rem]" />
      </div>
      <Skeleton
        aria-hidden="true"
        className="h-ctl-md w-72 max-w-full rounded-lg"
      />
      <Skeleton
        aria-hidden="true"
        className="h-[6.8125rem] w-full md:h-[3.5625rem]"
      />
      <Skeleton
        aria-hidden="true"
        className="h-[23.9375rem] w-full rounded-xl md:h-[21.3125rem]"
      />
    </div>
  );
}
