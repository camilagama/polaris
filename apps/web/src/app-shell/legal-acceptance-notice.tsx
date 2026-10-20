import { legalAcceptancePath } from "../lib/legal-acceptance";
import { currentReturnPath } from "../lib/sign-in-path";
import { useHasUnsentWork } from "../lib/unsent-work";
import {
  ACCEPTANCE_NOTICE,
  ACCEPTANCE_NOTICE_KEEPS_INPUT,
  ACCEPTANCE_NOTICE_LINK,
} from "../legal/acceptance/acceptance-texts";

/**
 * The fixed notice for "the legal acceptance is missing" (ADR 0100): the server refused a call of this
 * page for it. It never navigates by itself and drops nothing: the screen stays as it is, the queue
 * waits. With something typed and not sent the acceptance opens in another tab, so it is not lost.
 */
export function LegalAcceptanceNotice() {
  const unsent = useHasUnsentWork();
  const href = legalAcceptancePath(currentReturnPath(window.location));
  return (
    <section
      aria-label="Falta aceitar os termos"
      className="session-ended-notice legal-acceptance-notice"
      role="status"
    >
      <p>{ACCEPTANCE_NOTICE}</p>
      {unsent ? (
        <>
          <a
            aria-describedby="legal-acceptance-notice-hint"
            className="primary-button"
            href={href}
            rel="noopener noreferrer"
            target="_blank"
          >
            {ACCEPTANCE_NOTICE_LINK}
          </a>
          <p
            className="legal-acceptance-notice-hint"
            id="legal-acceptance-notice-hint"
          >
            ({ACCEPTANCE_NOTICE_KEEPS_INPUT})
          </p>
        </>
      ) : (
        <a className="primary-button" href={href}>
          {ACCEPTANCE_NOTICE_LINK}
        </a>
      )}
    </section>
  );
}
