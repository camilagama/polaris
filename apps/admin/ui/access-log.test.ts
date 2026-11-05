import { describe, expect, it } from "vitest";
import { PROBLEM_TEXT } from "./api";
import {
  allElements,
  buttons,
  byId,
  byTag,
  type FakeElement,
  visibleText,
} from "./test-dom";
import {
  type Answer,
  alertOf,
  type Call,
  flush,
  json,
  mount,
  OWNER,
  screenContext,
} from "./test-page";
import type { AccessLogEntry, AccessLogPage } from "./types";
import {
  CASE_FORMAT,
  NO_ACCESS,
  NO_MORE_ACCESS,
  periodOf,
  REGISTERED_TEXT,
  USER_OR_IP_TEXT,
  WINDOW_TEXT,
} from "./views/access-log";

const PROCESS = "0000001-55.2026.8.26.0100";
const USER = "user_abc-123";
const IP = "203.0.113.7";
const CURSOR = "0199a0a0-0000-7000-8000-00000000c0de";
const WHEN = "2026-10-20T13:05:07.000Z";
const READER = { ...OWNER, capabilities: ["access_log:read", "platform:read"] };
const HOSTILE = [
  "<img src=x onerror=alert(1)>",
  "<script>alert(1)</script>",
  "javascript:alert(1)",
  "‮abc",
  '"><svg onload=1>',
];
const OTHER_FILTERS = /loja|\bcaso|operador|tipo de ação/i;
const DIGIT = /\d/;
const NEVER_CREATED = ["script", "img", "svg", "iframe"];
const TECHNICAL =
  /invalid_|forbidden|internal_error|admin_not_configured|40\d|50\d/;

function entryOf(overrides: Partial<AccessLogEntry> = {}): AccessLogEntry {
  return {
    event: "login_succeeded",
    id: CURSOR,
    ip: IP,
    occurredAt: WHEN,
    requestId: "req-1",
    userId: USER,
    ...overrides,
  };
}

const pageOf = (
  entries: AccessLogEntry[],
  next: string | null = null
): AccessLogPage => ({ entries, next });

const screen = (answers: Answer[], who: Answer = json(READER)) =>
  mount(answers, who, undefined, screenContext({ screen: "registro" }));

type Mounted = Awaited<ReturnType<typeof screen>>;

const bodyOf = (call: Call | undefined) =>
  JSON.parse(String(call?.init.body ?? "null"));

const rowsOf = (root: FakeElement) =>
  byTag(root, "tbody").flatMap((body) => byTag(body, "tr"));

const consult = (root: FakeElement) => buttons(root, "Consultar")[0];

function fill(
  root: FakeElement,
  values: Partial<{
    first: string;
    ip: string;
    last: string;
    process: string;
    user: string;
  }> = {}
) {
  const all = {
    first: "2026-10-01",
    last: "2026-10-31",
    process: PROCESS,
    ...values,
  };
  byId(root, "registro-processo").value = all.process;
  if (all.ip === undefined) {
    byId(root, "registro-valor").value = all.user ?? USER;
  } else {
    const kind = byId(root, "registro-tipo");
    kind.value = "ip";
    kind.dispatch("change");
    byId(root, "registro-valor").value = all.ip;
  }
  byId(root, "registro-inicio").value = all.first;
  byId(root, "registro-fim").value = all.last;
}

async function ask(page: Mounted, values: Parameters<typeof fill>[1] = {}) {
  fill(page.root, values);
  consult(page.root)?.click();
  await flush();
}

const errorOf = (root: FakeElement, id: string) => byId(root, id).textContent;

function pending() {
  let release: (response: Response) => void = () => undefined;
  const answer: Answer = () =>
    new Promise<Response>((resolve) => {
      release = resolve;
    });
  return { answer, release: (response: Response) => release(response) };
}

describe("opening the screen (AC-C5, AC-P8.2)", () => {
  it("asks only who the operator is: no read of the log until a click", async () => {
    const { calls, root } = await screen([]);

    expect(calls.map((call) => call.path)).toEqual(["/api/whoami"]);
    expect(visibleText(root)).toContain(REGISTERED_TEXT);
    expect(visibleText(root)).toContain(CASE_FORMAT);
    expect(rowsOf(root)).toHaveLength(0);
  });

  it("opened twice still reads nothing", async () => {
    const one = await screen([]);
    const two = await screen([]);

    expect([...one.calls, ...two.calls].map((call) => call.path)).toEqual([
      "/api/whoami",
      "/api/whoami",
    ]);
  });

  it("says there is no permission, and builds no form, to an operator without access_log:read (AC-C1)", async () => {
    const { calls, root } = await screen([], json(OWNER));

    expect(visibleText(root)).toContain(PROBLEM_TEXT.forbidden);
    expect(buttons(root, "Consultar")).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });

  it("has the case number, one filter and the period, and no filter by store, case, operator or action (AC-P8.0)", async () => {
    const { root } = await screen([]);

    const labels = byTag(root, "label").map((label) => label.textContent);
    expect(labels).toEqual([
      "Número do processo",
      "Filtrar por",
      "Usuário",
      "Primeiro dia",
      "Último dia",
    ]);
    expect(
      byTag(byId(root, "registro-tipo"), "option").map((o) => o.textContent)
    ).toEqual(["Usuário", "IP"]);
    expect(visibleText(byTag(root, "form")[0] as FakeElement)).not.toMatch(
      OTHER_FILTERS
    );
  });
});

describe("the query (AC-P8.1, AC-P8.2, AC-P8.3)", () => {
  it("is one POST whose body carries everything and whose path carries nothing", async () => {
    const page = await screen([json(pageOf([entryOf()]))]);

    await ask(page);

    expect(page.calls).toHaveLength(2);
    const [, call] = page.calls;
    expect(call?.init.method).toBe("POST");
    expect(call?.path).toBe("/api/access-log/read");
    expect(bodyOf(call)).toEqual({
      from: "2026-10-01T03:00:00.000Z",
      legalReference: PROCESS,
      to: "2026-11-01T03:00:00.000Z",
      user: USER,
    });
    expect(call?.path).not.toContain(PROCESS);
    expect(call?.path).not.toContain(USER);
    expect(call?.path).not.toContain("?");
    expect(String(call?.init.credentials)).toBe("same-origin");
    expect(page.navigations).toEqual([]);
  });

  it("sends the IP instead of the user, never both, when the filter is IP", async () => {
    const page = await screen([json(pageOf([entryOf()]))]);

    await ask(page, { ip: IP });

    const body = bodyOf(page.calls[1]);
    expect(body.ip).toBe(IP);
    expect(body).not.toHaveProperty("user");
  });

  it("cannot be made with two filters: choosing the other one swaps the field, and clears what was typed", async () => {
    const page = await screen([]);
    fill(page.root, { user: USER });

    const kind = byId(page.root, "registro-tipo");
    kind.value = "ip";
    kind.dispatch("change");

    expect(byId(page.root, "registro-valor").value).toBe("");
    expect(
      byTag(page.root, "label").map((label) => label.textContent)
    ).toContain("Endereço IP");
    expect(
      allElements(page.root).filter(
        (e) => e.getAttribute("id") === "registro-valor"
      )
    ).toHaveLength(1);
  });

  it("the window runs from 00:00 of the first day to the end of the last day, in Brasília", async () => {
    const page = await screen([json(pageOf([]))]);

    await ask(page, { first: "2026-10-05", last: "2026-10-05" });

    const body = bodyOf(page.calls[1]);
    expect(body.from).toBe("2026-10-05T03:00:00.000Z");
    expect(body.to).toBe("2026-10-06T03:00:00.000Z");
  });

  it("accepts 31 days and refuses 32 on the screen, without a request (AC-P8.1)", async () => {
    const ok = await screen([json(pageOf([]))]);
    await ask(ok, { first: "2026-10-01", last: "2026-10-31" });
    expect(ok.calls).toHaveLength(2);

    const refused = await screen([]);
    await ask(refused, { first: "2026-10-01", last: "2026-11-01" });

    expect(refused.calls).toHaveLength(1);
    expect(errorOf(refused.root, "registro-fim-erro")).toBe(WINDOW_TEXT);
    expect(
      byId(refused.root, "registro-fim").getAttribute("aria-invalid")
    ).toBe("true");
    expect(refused.document.activeElement).toBe(
      byId(refused.root, "registro-fim")
    );
  });

  it("counts days of the calendar across a month and a leap day", () => {
    expect(periodOf("2028-02-01", "2028-03-02")).toHaveProperty("from");
    expect(periodOf("2028-02-01", "2028-03-03")).toEqual({
      problem: WINDOW_TEXT,
    });
    expect(periodOf("2027-02-01", "2027-03-03")).toHaveProperty("from");
    expect(periodOf("2026-10-31", "2026-10-30")).toHaveProperty("problem");
    expect(periodOf("", "2026-10-30")).toHaveProperty("problem");
    expect(periodOf("2026-02-30", "2026-03-01")).toHaveProperty("problem");
    expect(periodOf("1999-12-31", "2000-01-02")).toHaveProperty("problem");
    expect(periodOf("2026-10-01", "2201-01-01")).toHaveProperty("problem");
  });

  it("asks for what is missing beside the field, without a request", async () => {
    const page = await screen([]);

    await ask(page, { process: "" });
    expect(errorOf(page.root, "registro-processo-erro")).toContain(
      "número do processo"
    );
    await ask(page, { user: "  " });
    expect(errorOf(page.root, "registro-valor-erro")).toBe(
      "Informe o usuário."
    );
    await ask(page, { first: "" });
    expect(errorOf(page.root, "registro-fim-erro")).toContain("primeiro dia");

    expect(page.calls).toHaveLength(1);
  });

  it("refuses a control character in the case number or the filter on the screen (AC-C7)", async () => {
    const page = await screen([]);

    await ask(page, { process: `${PROCESS}\u0007` });
    await ask(page, { user: `${USER}\u0000` });

    expect(page.calls).toHaveLength(1);
  });

  it("sends one request per click: a double click, and Enter again, do not repeat it (AC-P8.2)", async () => {
    const wait = pending();
    const page = await screen([wait.answer]);
    fill(page.root);

    consult(page.root)?.click();
    consult(page.root)?.click();
    byTag(page.root, "form")[0]?.dispatch("submit");
    await flush();

    expect(page.calls).toHaveLength(2);
    const button = byTag(page.root, "button").find(
      (b) => b.getAttribute("type") === "submit"
    ) as FakeElement;
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.textContent).toBe("Consultando…");
    expect(button.hasAttribute("disabled")).toBe(false);

    wait.release(json(pageOf([entryOf()])));
    await flush();

    expect(button.getAttribute("aria-disabled")).toBe("false");
    expect(button.textContent).toBe("Consultar");
  });

  it("reads again only on another click, even after a failure: nothing repeats by itself (AC-C5)", async () => {
    const page = await screen([new Error("down")]);

    await ask(page);
    await flush();

    expect(page.calls).toHaveLength(2);
  });
});

describe("the answer (AC-P8.3, AC-P8.4, AC-C7, AC-C12)", () => {
  it("shows each access to the second, in Brasília and in UTC, with its event, IP, user and request", async () => {
    const page = await screen([
      json(
        pageOf([
          entryOf(),
          entryOf({ event: "login_failed", id: "b", userId: null }),
          entryOf({ event: "logout", id: "c" }),
          entryOf({ event: "session_refreshed", id: "d" }),
        ])
      ),
    ]);

    await ask(page);

    const cells = rowsOf(page.root).map((row) =>
      byTag(row, "td").map((cell) => cell.textContent)
    );
    expect(cells[0]).toEqual([
      "20/10/2026 10:05:07",
      "20/10/2026 13:05:07",
      "Entrada",
      IP,
      USER,
      "req-1",
    ]);
    expect(cells.map((row) => row[2])).toEqual([
      "Entrada",
      "Entrada recusada",
      "Saída",
      "Sessão renovada",
    ]);
    expect(cells[1]?.[4]).toBe("—");
    expect(visibleText(page.root)).toContain("4 acessos nesta página.");
    expect(page.document.activeElement?.getAttribute("role")).toBe("status");
  });

  it("says an empty window is empty, as a result and not as a failure", async () => {
    const page = await screen([json(pageOf([]))]);

    await ask(page);

    expect(visibleText(page.root)).toContain(NO_ACCESS);
    expect(alertOf(page.root)).toBeUndefined();
    expect(rowsOf(page.root)).toHaveLength(0);
    expect(
      buttons(page.root, "Próxima página")[0]?.hasAttribute("hidden")
    ).toBe(true);
  });

  it("goes to the next page by its cursor with the same fields, as one more click", async () => {
    const page = await screen([
      json(pageOf([entryOf()], CURSOR)),
      json(pageOf([entryOf({ id: "b" })])),
    ]);
    await ask(page);
    const more = buttons(page.root, "Próxima página")[0] as FakeElement;
    expect(more.hasAttribute("hidden")).toBe(false);
    expect(page.calls).toHaveLength(2);

    more.click();
    await flush();

    expect(page.calls).toHaveLength(3);
    const first = bodyOf(page.calls[1]);
    expect(bodyOf(page.calls[2])).toEqual({ ...first, after: CURSOR });
    expect(page.calls[2]?.path).toBe("/api/access-log/read");
    expect(more.hasAttribute("hidden")).toBe(true);
    expect(rowsOf(page.root)).toHaveLength(1);
  });

  it("does not send a next page twice on a double click", async () => {
    const wait = pending();
    const page = await screen([json(pageOf([entryOf()], CURSOR)), wait.answer]);
    await ask(page);
    const more = buttons(page.root, "Próxima página")[0] as FakeElement;

    more.click();
    more.click();
    await flush();

    expect(page.calls).toHaveLength(3);
    wait.release(json(pageOf([])));
    await flush();
    expect(visibleText(page.root)).toContain(NO_MORE_ACCESS);
  });

  it("keeps the page on screen when the next one fails", async () => {
    const page = await screen([
      json(pageOf([entryOf()], CURSOR)),
      json({ error: "x" }, 503),
    ]);
    await ask(page);

    buttons(page.root, "Próxima página")[0]?.click();
    await flush();

    expect(alertOf(page.root)?.textContent).toBe(PROBLEM_TEXT.unavailable);
    expect(rowsOf(page.root)).toHaveLength(1);
  });

  it("takes the answer off the page when a field changes, so the next page cannot go with other fields", async () => {
    const page = await screen([json(pageOf([entryOf()], CURSOR))]);
    await ask(page);

    byId(page.root, "registro-valor").dispatch("input");

    expect(rowsOf(page.root)).toHaveLength(0);
    expect(
      buttons(page.root, "Próxima página")[0]?.hasAttribute("hidden")
    ).toBe(true);
    expect(visibleText(page.root)).not.toContain(IP);
  });

  it("writes hostile text as text and builds only the page's own elements", async () => {
    const page = await screen([
      json(
        pageOf(
          HOSTILE.map((hostile, index) =>
            entryOf({
              id: `id-${index}`,
              ip: hostile,
              requestId: hostile,
              userId: hostile,
            })
          )
        )
      ),
    ]);

    await ask(page);

    const text = visibleText(page.root);
    expect(text).toContain("<script>alert(1)</script>");
    expect(
      page.document.created.filter((tag) => NEVER_CREATED.includes(tag))
    ).toEqual([]);
    expect(byTag(page.root, "a")).toHaveLength(0);
    expect(rowsOf(page.root)).toHaveLength(HOSTILE.length);
  });

  it("shows a code it does not know as unknown, never as a known event", async () => {
    const page = await screen([
      json(
        pageOf([entryOf({ event: "new_event" as AccessLogEntry["event"] })])
      ),
    ]);

    await ask(page);

    expect(visibleText(page.root)).toContain("evento desconhecido: new_event");
  });

  it("does not trust an answer that is not a page", async () => {
    const page = await screen([json({ entries: "x" })]);

    await ask(page);

    expect(alertOf(page.root)?.textContent).toBe(PROBLEM_TEXT.failed);
  });
});

describe("what the server refuses (AC-C3, AC-P8.1)", () => {
  it("says invalid_filter beside the filter, with the sentence of the design", async () => {
    const page = await screen([json({ error: "invalid_filter" }, 400)]);

    await ask(page);

    const text = errorOf(page.root, "registro-valor-erro");
    expect(text.startsWith(USER_OR_IP_TEXT)).toBe(true);
    expect(text).not.toMatch(TECHNICAL);
    expect(byId(page.root, "registro-valor").getAttribute("aria-invalid")).toBe(
      "true"
    );
    expect(page.document.activeElement).toBe(byId(page.root, "registro-valor"));
  });

  it("says invalid_window beside the period, with the sentence of the design", async () => {
    const page = await screen([json({ error: "invalid_window" }, 400)]);

    await ask(page);

    expect(errorOf(page.root, "registro-fim-erro")).toBe(WINDOW_TEXT);
  });

  it("says invalid_reference beside the case number, with its own sentence", async () => {
    const page = await screen([json({ error: "invalid_reference" }, 400)]);

    await ask(page);

    const text = errorOf(page.root, "registro-processo-erro");
    expect(text).toContain("número do processo");
    expect(text).toContain(CASE_FORMAT);
    expect(text).not.toMatch(TECHNICAL);
  });

  it.each(["invalid_page", "invalid_cursor", "invalid_request", "outra_coisa"])(
    "says %s as a sentence at the top, with no code",
    async (code) => {
      const page = await screen([json({ error: code }, 400)]);

      await ask(page);

      const text = alertOf(page.root)?.textContent ?? "";
      expect(text).toContain("A consulta não foi aceita");
      expect(text).not.toContain(code);
    }
  );

  it.each([
    ["a 401", json({ error: "unauthenticated" }, 401), PROBLEM_TEXT.session],
    ["a 403", json({ error: "forbidden" }, 403), PROBLEM_TEXT.forbidden],
    ["a 409", json({ error: "conflict" }, 409), PROBLEM_TEXT.failed],
    ["a 500", json({ error: "internal_error" }, 500), PROBLEM_TEXT.failed],
    [
      "a 503",
      json({ error: "admin_not_configured" }, 503),
      PROBLEM_TEXT.unavailable,
    ],
    ["no network", new Error("down"), PROBLEM_TEXT.network],
  ])("says the sentence of the problem on %s", async (_name, answer, text) => {
    const page = await screen([answer]);

    await ask(page);

    expect(alertOf(page.root)?.textContent).toBe(text);
    expect(alertOf(page.root)?.textContent).not.toMatch(TECHNICAL);
    expect(rowsOf(page.root)).toHaveLength(0);
  });

  it("says a 404 with its own sentence, not the store's", async () => {
    const page = await screen([json({ error: "not_found" }, 404)]);

    await ask(page);

    const text = alertOf(page.root)?.textContent ?? "";
    expect(text).toContain("A consulta não foi encontrada");
    expect(text).not.toContain("Loja");
  });

  it("says the wait of a 429 in minutes when the server gave it, and never invents one", async () => {
    const timed = await screen([
      new Response("{}", { headers: { "retry-after": "61" }, status: 429 }),
    ]);
    await ask(timed);
    expect(alertOf(timed.root)?.textContent).toContain("2 minutos");

    const plain = await screen([json({}, 429)]);
    await ask(plain);
    const text = alertOf(plain.root)?.textContent ?? "";
    expect(text).toContain("Muitas consultas");
    expect(text).not.toMatch(DIGIT);
  });

  it("lets the operator ask again after a refusal, one click one request", async () => {
    const page = await screen([
      json({ error: "invalid_window" }, 400),
      json(pageOf([entryOf()])),
    ]);
    await ask(page);

    consult(page.root)?.click();
    await flush();

    expect(page.calls).toHaveLength(3);
    expect(rowsOf(page.root)).toHaveLength(1);
    expect(errorOf(page.root, "registro-fim-erro")).toBe("");
  });
});

describe("nothing outside the answer (AC-P8.3, AC-C6)", () => {
  it("leaves the case number, the filter and the lines on no attribute of the page but the fields themselves", async () => {
    const page = await screen([json(pageOf([entryOf()]))]);
    await ask(page);

    const holders = allElements(page.root).filter((element) =>
      [...element.attributes.values()].some(
        (value) =>
          value.includes(PROCESS) || value.includes(USER) || value.includes(IP)
      )
    );
    expect(holders).toEqual([]);
  });

  it("a new mount of the screen (the next page load) shows none of it and asks nothing", async () => {
    const before = await screen([json(pageOf([entryOf()]))]);
    await ask(before);

    const after = await screen([]);

    expect(visibleText(after.root)).not.toContain(IP);
    expect(visibleText(after.root)).not.toContain(PROCESS);
    expect(rowsOf(after.root)).toHaveLength(0);
    expect(byId(after.root, "registro-processo").value).toBe("");
    expect(after.calls.map((call) => call.path)).toEqual(["/api/whoami"]);
  });

  it("drops the number, the filter and the lines when the page is hidden, so the back-forward cache brings none back", async () => {
    const page = await screen([json(pageOf([entryOf()], CURSOR))]);
    await ask(page);

    page.document.defaultView.dispatch("pagehide");

    expect(rowsOf(page.root)).toHaveLength(0);
    expect(visibleText(page.root)).not.toContain(IP);
    expect(byId(page.root, "registro-processo").value).toBe("");
    expect(byId(page.root, "registro-valor").value).toBe("");
    expect(
      buttons(page.root, "Próxima página")[0]?.hasAttribute("hidden")
    ).toBe(true);
  });
});
