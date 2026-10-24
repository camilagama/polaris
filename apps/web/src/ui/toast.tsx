"use client";

import { Toast as ToastPrimitive } from "@base-ui/react/toast";
import CircleAlertIcon from "lucide-react/dist/esm/icons/circle-alert";
import CircleCheckIcon from "lucide-react/dist/esm/icons/circle-check";
import InfoIcon from "lucide-react/dist/esm/icons/info";
import XIcon from "lucide-react/dist/esm/icons/x";
import type * as React from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";

/* The Polaris toast: the Base UI one, which renders no style element (ADR 0103). Rules of the v5.1 design:
   - it confirms an action that does NOT change the screen the person is on ("Produto arquivado", "Venda registrada")
     or tells something that does not block;
   - it is never the only place of a form error or of a result to be read calmly: that stays inline;
   - one at a time in practice (`limit={3}`), 5 s, paused under the pointer or the focus; `role="status"` (low
     priority), and `role="alert"` only for `priority: "high"`;
   - on a phone it comes from the top, below the header; on a desktop from the bottom right corner; 380 px wide at most;
   - ink: `popover` background, 6% ring and `shadow-md`; the type changes only the icon, not the background;
   - always closed by the X (44 px to touch) or a swipe; enters and leaves with opacity and 8 px only (220/140 ms),
     nothing under `prefers-reduced-motion: reduce`. */

export const toastManager = ToastPrimitive.createToastManager();

function ToastProvider({ children, ...props }: ToastPrimitive.Provider.Props) {
  return (
    <ToastPrimitive.Provider
      limit={3}
      timeout={5000}
      toastManager={toastManager}
      {...props}
    >
      {children}
      <ToastList />
    </ToastPrimitive.Provider>
  );
}

const ICON: Record<string, React.ReactNode> = {
  error: (
    <CircleAlertIcon
      aria-hidden="true"
      className="size-4 shrink-0 translate-y-0.5 text-destructive"
    />
  ),
  info: (
    <InfoIcon
      aria-hidden="true"
      className="size-4 shrink-0 translate-y-0.5 text-muted-foreground"
    />
  ),
  success: (
    <CircleCheckIcon
      aria-hidden="true"
      className="size-4 shrink-0 translate-y-0.5"
    />
  ),
  warning: (
    <CircleAlertIcon
      aria-hidden="true"
      className="size-4 shrink-0 translate-y-0.5 text-warning"
    />
  ),
};

function ToastList() {
  const { toasts } = ToastPrimitive.useToastManager();
  return (
    <ToastPrimitive.Portal>
      <ToastPrimitive.Viewport
        aria-label="Avisos"
        className="fixed top-14 right-(--gutter) left-(--gutter) z-50 mx-auto flex w-auto max-w-[380px] flex-col items-stretch gap-2 md:top-auto md:right-6 md:bottom-6 md:left-auto md:mx-0 md:w-[380px]"
        data-slot="toast-viewport"
      >
        {toasts.map((toast) => (
          <ToastPrimitive.Root
            className={cn(
              "group/toast relative grid w-full grid-cols-[auto_1fr_auto] gap-x-2.5 rounded-lg bg-popover px-3 py-2.5 text-popover-foreground shadow-md ring-1 ring-foreground/[0.06] transition-[opacity,translate] duration-[220ms] ease-(--ease-soft)",
              "data-[ending-style]:data-[swipe-direction=right]:translate-x-6 data-[ending-style]:data-[swipe-direction=up]:-translate-y-6 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 data-[ending-style]:duration-[140ms]",
              "motion-reduce:transition-none"
            )}
            data-slot="toast"
            key={toast.id}
            swipeDirection={["up", "right"]}
            toast={toast}
          >
            {ICON[toast.type ?? "info"]}
            <ToastPrimitive.Content
              className="grid min-w-0 gap-0.5"
              data-slot="toast-content"
            >
              {toast.title && (
                <ToastPrimitive.Title
                  className="font-semibold text-sm"
                  data-slot="toast-title"
                />
              )}
              <ToastPrimitive.Description
                className="text-muted-foreground text-support"
                data-slot="toast-description"
              />
              {toast.actionProps && (
                <ToastPrimitive.Action
                  render={
                    <Button
                      className="mt-1 w-fit justify-start"
                      size="sm"
                      text="13"
                      variant="link"
                    />
                  }
                />
              )}
            </ToastPrimitive.Content>
            <ToastPrimitive.Close
              aria-label="Fechar aviso"
              render={
                <Button
                  className="-my-1 -mr-1.5 hover:text-foreground"
                  size="icon-xs"
                  variant="ghost-muted"
                />
              }
            >
              <XIcon />
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        ))}
      </ToastPrimitive.Viewport>
    </ToastPrimitive.Portal>
  );
}

export { ToastProvider };
