import { describe, expect, it } from "vitest";
import {
  allElements,
  buttons,
  byTag,
  type FakeElement,
  visibleText,
} from "./test-dom";
import {
  type Answer,
  type Call,
  flush,
  json,
  mount,
  OWNER,
  screenContext,
} from "./test-page";
import { NO_HOLDS } from "./views/legal-holds";

/**
 * Retenções legais (`/retencoes`, corte admin-v2, Parte 7, AC-P7.4): the holds in force as the server lists them, read
 * only, 25 at a time, with the ones past their review date marked and still in force.
 */

const NOW = new Date("2026-11-05T15:00:00.000Z");
const STORE = "0199a0a0-0000-7000-8000-0000000000a1";
const UUID_TEXT =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const OTHER = "0199a0a0-0000-7000-8000-0000000000a2";

const MAY = {
  ...OWNER,
  capabilities: [...OWNER.capabilities, "organization:legal_hold"],
};
const WITHOUT_DIAGNOSE = {
  ...OWNER,
  capabilities: ["platform:read", "organization:legal_hold"],
};

const hold = (organizationId: string, reviewDue = false) => ({
  id: `hold-${organizationId.slice(-2)}`,
  organizationId,
  placedAt: "2026-10-01T15:00:00.000Z",
  placedBy: OWNER.principal.id,
  reviewAt: "2026-11-01T15:00:00.000Z",
  reviewDue,
  supportCaseId: "0199a0a0-0000-7000-8000-00000000c0de",
});

const page = (
  holds: ReturnType<typeof hold>[],
  next: string | null = null,
  dueForReview = 0
) => json({ dueForReview, holds, next });

const open = (answers: Answer[], who = MAY) =>
  mount(answers, json(who), () => NOW, screenContext({ screen: "retencoes" }));

const sectionOf = (root: FakeElement): FakeElement => {
  const found = allElements(root).find(
    (element) => element.getAttribute("aria-labelledby") === "retencoes-titulo"
  );
  if (found === undefined) {
    throw new Error("no section");
  }
  return found;
};

const posts = (calls: Call[]) =>
  calls.filter((call) => call.init.method === "POST");

describe("Lojas com trava legal", () => {
  it("says no permission, and asks for no hold, without organization:legal_hold", async () => {
    const mounted = await open([], OWNER);
    expect(visibleText(mounted.root)).toContain("Sem permissão para isto.");
    expect(mounted.calls.map((call) => call.path)).toEqual(["/api/whoami"]);
  });

  it("says there is no store with a hold when the list is empty", async () => {
    const mounted = await open([page([])]);
    expect(mounted.calls.map((call) => call.path)).toEqual([
      "/api/whoami",
      "/api/legal-holds?limit=25",
    ]);
    expect(visibleText(mounted.root)).toContain(NO_HOLDS);
  });

  it("marks a hold past its review as still in force, with the dates as dd/mm/aaaa", async () => {
    const mounted = await open([
      page([hold(STORE, true), hold(OTHER)], null, 1),
    ]);
    const text = visibleText(sectionOf(mounted.root));
    expect(text).toContain("Vigente · pendente de revisão");
    expect(text).toContain(
      "1 trava está pendente de revisão: ela continua valendo até ser liberada."
    );
    expect(text).toContain("01/10/2026");
    expect(text).toContain("01/11/2026");
    const rows = byTag(sectionOf(mounted.root), "tr").map((row) =>
      visibleText(row)
    );
    expect(
      rows.filter((row) => row.includes("pendente de revisão"))
    ).toHaveLength(1);
    expect(rows.filter((row) => row.endsWith("Vigente"))).toHaveLength(1);
  });

  it("says pendentes de revisão for two holds past their review, and keeps the singular on the row", async () => {
    const mounted = await open([
      page([hold(STORE, true), hold(OTHER, true)], null, 2),
    ]);
    const text = visibleText(sectionOf(mounted.root));
    expect(text).toContain(
      "2 travas estão pendentes de revisão: elas continuam valendo até serem liberadas."
    );
    expect(text).not.toContain("estão pendente de revisão");
    expect(text).toContain("Vigente · pendente de revisão");
  });

  it("is read only: the only button is Carregar mais, and it asks once for each cursor", async () => {
    const wait = (() => {
      let release: (response: Response) => void = () => undefined;
      const answer: Answer = () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        });
      return { answer, release: (response: Response) => release(response) };
    })();
    const mounted = await open([page([hold(STORE)], "cursor 2"), wait.answer]);
    const section = sectionOf(mounted.root);
    expect(
      byTag(section, "button").map((button) => button.textContent)
    ).toEqual(["Carregar mais"]);
    await Promise.all([
      buttons(section, "Carregar mais")[0]?.click(),
      buttons(section, "Carregar mais")[0]?.click(),
    ]);
    await flush();
    expect(
      mounted.calls.filter((call) => call.path.includes("after="))
    ).toHaveLength(1);
    expect(mounted.calls.at(-1)?.path).toBe(
      "/api/legal-holds?limit=25&after=cursor%202"
    );
    wait.release(json({ dueForReview: 0, holds: [hold(OTHER)], next: null }));
    await flush();
    expect(byTag(section, "tbody")[0]?.children).toHaveLength(2);
    expect(buttons(section, "Carregar mais")[0]?.hasAttribute("hidden")).toBe(
      true
    );
    expect(posts(mounted.calls)).toHaveLength(0);
  });

  it("links the store only for an operator who may read stores", async () => {
    const withLink = await open([page([hold(STORE)])]);
    expect(
      byTag(sectionOf(withLink.root), "a").map((link) =>
        link.getAttribute("href")
      )
    ).toEqual([`/lojas/${STORE}`]);

    const withoutLink = await open([page([hold(STORE)])], WITHOUT_DIAGNOSE);
    expect(byTag(sectionOf(withoutLink.root), "a")).toHaveLength(0);
    expect(visibleText(sectionOf(withoutLink.root))).not.toContain(STORE);
  });

  it("shows no store ID as a text of the list, only in the title of the link (AC-CP5)", async () => {
    const mounted = await open([page([hold(STORE), hold(OTHER)])]);
    const section = sectionOf(mounted.root);
    expect(visibleText(section)).not.toMatch(UUID_TEXT);
    expect(
      byTag(section, "a").map((link) => link.getAttribute("title"))
    ).toEqual([STORE, OTHER]);
  });
});
