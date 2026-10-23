import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription } from "@/ui/alert";
import { buttonVariants } from "@/ui/button";
import {
  ACCEPTANCE_NOTICE,
  ACCEPTANCE_NOTICE_KEEPS_INPUT,
  ACCEPTANCE_NOTICE_LINK,
} from "../legal/acceptance/acceptance-texts";
import { legalAcceptancePath } from "../lib/legal-acceptance";
import { currentReturnPath } from "../lib/sign-in-path";
import { useHasUnsentWork } from "../lib/unsent-work";

/**
 * The fixed notice for "the legal acceptance is missing" (ADR 0100): the server refused a call of this
 * page for it. It never navigates by itself and drops nothing: the screen stays as it is, the queue
 * waits. With something typed and not sent the acceptance opens in another tab, so it is not lost.
 */
export function LegalAcceptanceNotice() {
  const unsent = useHasUnsentWork();
  const href = legalAcceptancePath(currentReturnPath(window.location));
  return (
    <Alert
      aria-label="Falta aceitar os termos"
      className="mb-4 font-sans"
      data-notice="legal-acceptance"
      data-ui=""
      variant="warning"
    >
      <TriangleAlertIcon aria-hidden="true" />
      <AlertDescription className="grid justify-items-start gap-2 [&_p:not(:last-child)]:mb-0">
        <p>{ACCEPTANCE_NOTICE}</p>
        {unsent ? (
          <>
            <a
              aria-describedby="legal-acceptance-notice-hint"
              className={cn(buttonVariants(), "no-underline!")}
              data-slot="button"
              href={href}
              rel="noopener noreferrer"
              target="_blank"
            >
              {ACCEPTANCE_NOTICE_LINK}
            </a>
            <p id="legal-acceptance-notice-hint">
              ({ACCEPTANCE_NOTICE_KEEPS_INPUT})
            </p>
          </>
        ) : (
          <a
            className={cn(buttonVariants(), "no-underline!")}
            data-slot="button"
            href={href}
          >
            {ACCEPTANCE_NOTICE_LINK}
          </a>
        )}
      </AlertDescription>
    </Alert>
  );
}
