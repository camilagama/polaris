import { Skeleton } from "@/ui/skeleton";

/**
 * The Despesas screen while its chunk loads: the boxes of the screen of an empty month (the title line with its
 * action, the parts, the month and category filters, the card of the list), at the heights the screen measures, so
 * the screen that comes takes the place of the skeleton instead of moving what is below the title.
 */
export function ExpensesLoading() {
  return (
    <div className="grid grid-cols-1 gap-4" role="status">
      <span className="sr-only">Carregando as despesas…</span>
      <div
        aria-hidden="true"
        className="grid h-[4.75rem] content-between md:flex md:h-8 md:items-center md:justify-between"
      >
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-8 w-full md:w-36" />
      </div>
      <Skeleton
        aria-hidden="true"
        className="h-9 w-72 max-w-full rounded-lg md:h-8"
      />
      <Skeleton
        aria-hidden="true"
        className="h-[4.3125rem] w-full max-w-lg md:h-[3.5625rem]"
      />
      <Skeleton
        aria-hidden="true"
        className="h-[20.3125rem] w-full rounded-xl md:h-[19.875rem]"
      />
    </div>
  );
}
