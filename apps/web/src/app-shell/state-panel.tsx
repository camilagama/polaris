import type { ReactNode, Ref } from "react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader } from "@/ui/card";

interface StatePanelProps {
  /** The buttons or links under the text. */
  actions?: ReactNode;
  children: ReactNode;
  /** The small line over the title ("Erro 404"). */
  eyebrow?: string;
  /** Outside the shell (no sidebar, no frame): the panel brings the color of the page and its height. */
  fullPage?: boolean;
  /** An icon beside the title, `aria-hidden`. */
  icon?: ReactNode;
  /** The element that gets the focus when the panel is the whole page. */
  panelRef?: Ref<HTMLElement>;
  /** "alert" for a failure the person must hear at once; the panel is a landmark by its title either way. */
  role?: "alert";
  tabIndex?: -1;
  title: string;
  titleId: string;
}

/**
 * A screen of the shell that says what happened and gives the way out (v5.1): the 404, the failure of a screen, the
 * organization that did not open, the offline access that expired. One card of 32 rem under the frame (the section is
 * the card's own width, so the focus ring wraps the card); in `fullPage` it also stands alone on the page (the failure
 * of the whole app has no shell to sit in).
 */
export function StatePanel({
  actions,
  children,
  eyebrow,
  fullPage = false,
  icon,
  panelRef,
  role,
  tabIndex,
  title,
  titleId,
}: StatePanelProps) {
  return (
    <div
      className={cn(
        "font-sans text-foreground text-sm antialiased",
        fullPage ? "min-h-dvh bg-background p-(--gutter)" : "py-2"
      )}
      data-ui=""
    >
      <section
        aria-labelledby={titleId}
        className="focus-ring mx-auto w-full max-w-lg rounded-xl"
        ref={panelRef}
        role={role}
        tabIndex={tabIndex}
      >
        <Card>
          <CardHeader>
            {eyebrow ? (
              <p className="text-muted-foreground text-support">{eyebrow}</p>
            ) : null}
            <h1 className="flex items-center gap-2 text-title" id={titleId}>
              {icon}
              {title}
            </h1>
          </CardHeader>
          <CardContent className="grid gap-4">
            {children}
            {actions ? (
              <div className="flex flex-wrap gap-3">{actions}</div>
            ) : null}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
