import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { challengeAlertId, SubmitButton } from "./entry-ui";
import type { Challenge } from "./turnstile";

type ChallengeState = Challenge["state"];

const ALERT_ID = challengeAlertId("form");
const DISABLED_ATTR = /\sdisabled=/;

const challengeIn = (state: ChallengeState): Challenge => ({
  containerRef: { current: null },
  getToken: () => Promise.resolve(null),
  retry: () => undefined,
  state,
});

const button = (state: ChallengeState, pending = false) =>
  renderToStaticMarkup(
    <SubmitButton
      alertId={ALERT_ID}
      challenge={challengeIn(state)}
      disabled={false}
      pending={pending}
      pendingText="Entrando…"
    >
      Entrar
    </SubmitButton>
  );

describe("SubmitButton with the challenge script blocked (N-1)", () => {
  it("is aria-disabled, still reachable, and names the alert that says why", () => {
    const markup = button("blocked");
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain(`aria-describedby="${ALERT_ID}"`);
    // `aria-disabled`, not `disabled`: the focus and the screen reader still reach it
    expect(markup).not.toMatch(DISABLED_ATTR);
    expect(markup).toContain(">Entrar<");
  });

  it("is normal again in every other state of the challenge", () => {
    for (const state of [
      "checking",
      "idle",
      "interactive",
    ] as const satisfies readonly ChallengeState[]) {
      const markup = button(state);
      expect(markup).not.toContain('aria-disabled="');
      expect(markup).not.toContain("aria-describedby=");
    }
  });

  it("keeps its own pending state apart from the block", () => {
    const markup = button("idle", true);
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain(">Entrando…<");
  });

  it("derives the alert id from the form, one place for both parts", () => {
    expect(challengeAlertId("a")).not.toBe(challengeAlertId("b"));
  });
});
