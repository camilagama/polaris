import { signInPath } from "../../lib/sign-in-path";
import {
  clearSessionMarker,
  openingReason,
  readSessionMarker,
} from "../../lib/session-marker";
import { leaveTo } from "./leave-browser";
import type { OfflineRuntime } from "./offline-runtime";

const SESSION_COPY_GRACE_MS = 5000;

/**
 * The session is already gone: drop the local copy that needs it (never the queue), then go to the
 * sign-in screen with the reason `sessao` and the page to come back to. Never through "Sair": it
 * cannot sign out of a session the server no longer knows, and the queue stays where it is (AC-18).
 *
 * `atOpen`: the refusal came from the read that opens the app, so it may be a first visit or a "Sair":
 * the reason says only what this browser really lived (U-01). Refused while a screen was in use, there
 * was a session, and the reason is always `sessao`.
 */
export function leaveSessionOver(
  runtime: OfflineRuntime | null,
  returnTo: string | undefined,
  options: { atOpen?: boolean } = {}
): void {
  const reason = options.atOpen
    ? openingReason(readSessionMarker())
    : ("sessao" as const);

  // a send that never answers must not trap the person on this panel: the caches are
  // already gone and the runtime drops the copy at the next start anyway
  const grace = new Promise<void>((resolve) => {
    setTimeout(resolve, SESSION_COPY_GRACE_MS);
  });
  Promise.race([runtime?.dropSessionCopy() ?? Promise.resolve(), grace])
    .catch(() => undefined)
    .then(() => {
      // whatever was said is said once: the next opening without a session starts clean (cleared only now, so a
      // second call during the wait still reads it)
      clearSessionMarker();
      leaveTo(signInPath({ reason, returnTo }));
    });
}
