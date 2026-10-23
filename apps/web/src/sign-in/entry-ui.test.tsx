import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { challengeAlertId, EntryScreen, SubmitButton } from "./entry-ui";
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

  it("is off the same way for a pause, naming the alert of the pause", () => {
    const markup = renderToStaticMarkup(
      <SubmitButton offBy="pause-alert" pending={false} pendingText="Trocando…">
        Trocar senha
      </SubmitButton>
    );
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain('aria-describedby="pause-alert"');
    expect(markup).not.toMatch(DISABLED_ATTR);
    expect(markup).toContain(">Trocar senha<");
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

describe("EntryScreen outside the entry pages (t239)", () => {
  const screen = (props: Partial<Parameters<typeof EntryScreen>[0]> = {}) =>
    renderToStaticMarkup(
      <EntryScreen title="Abra a sua loja" {...props}>
        <p>conteúdo</p>
      </EntryScreen>
    );

  it("is the card of the entry, with the two legal links, by default", () => {
    const markup = screen();
    expect(markup).toContain("max-w-[380px]");
    expect(markup).toContain("Termos de Uso");
    expect(markup).toContain("Política de Privacidade");
    // the brand is a name, not a link, where nobody is going back to the start
    expect(markup).not.toContain('href="/"');
  });

  it("is wider for the acceptance and a reading column for a legal text", () => {
    expect(screen({ width: "wide" })).toContain("max-w-[420px]");
    const reading = screen({ width: "reading" });
    expect(reading).toContain("max-w-[calc(68ch+3rem)]");
    // the title of a text is the 24/32 of the reading scale
    expect(reading).toContain("text-2xl/8");
  });

  it("drops the legal links where the page is one of them, and links the brand to the start", () => {
    const markup = screen({ brandHref: "/", legalLinks: false });
    expect(markup).not.toContain("Termos de Uso");
    expect(markup).toContain('href="/"');
  });

  it("says its one line of support under the title", () => {
    expect(screen({ support: "Uma linha de apoio." })).toContain(
      "Uma linha de apoio."
    );
  });
});
