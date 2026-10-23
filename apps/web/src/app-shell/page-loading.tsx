import { cn } from "@/lib/utils";
import { Skeleton } from "@/ui/skeleton";

interface PageLoadingProps {
  /** Outside the shell: the color of the page, so there is no white flash in the dark theme. */
  fullPage?: boolean;
  /** What is going on; read by the screen reader and shown above the skeleton. */
  label?: string;
  /** Without the drawing of the page: for a status that is not a wait ("not available on this device"). */
  skeleton?: boolean;
}

const ROWS = [0, 1, 2];

/**
 * "Carregando…" of a screen (v5.1): the line that says it, and the skeleton of a page under it (a heading and a
 * card with three rows). The skeleton is drawing only: the status is the line. It is the fallback of every lazy
 * screen, so it is in the first chunk: the card is drawn with classes and not with `Card`, which would take the
 * component (and what it brings) out of the screens' chunk into the first one.
 */
export function PageLoading({
  fullPage = false,
  label = "Carregando…",
  skeleton = true,
}: PageLoadingProps) {
  return (
    <div
      className={cn(
        "grid content-start gap-4 font-sans text-foreground text-sm antialiased",
        fullPage ? "min-h-dvh bg-background p-(--gutter)" : "py-2"
      )}
      role="status"
    >
      <p className="text-muted-foreground">{label}</p>
      {skeleton ? (
        <div aria-hidden="true" className="grid gap-4">
          <Skeleton className="h-6 w-40" />
          <div className="grid gap-3 rounded-xl bg-card p-3 shadow-xs ring-1 ring-foreground/[0.06] md:p-4">
            {ROWS.map((row) => (
              <div className="flex items-center gap-3" key={row}>
                <Skeleton className="size-9 shrink-0 rounded-full" />
                <div className="grid flex-1 gap-1.5">
                  <Skeleton className="h-3.5 w-2/3" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
