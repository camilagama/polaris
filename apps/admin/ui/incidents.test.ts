import { describe, expect, it } from "vitest";
import { PROBLEM_TEXT } from "./api";
import {
  allElements,
  buttons,
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
import type {
  DeadEventSummary,
  OperationalIncidentDetail,
  OperationalIncidentPage,
  OperationalIncidentSummary,
} from "./types";
import {
  FOREVER_TEXT,
  INCIDENT_NOT_FOUND,
  NO_EVENTS,
  RETRY_EFFECT,
  RETRY_UNKNOWN,
} from "./views/incident";
import { NO_INCIDENTS } from "./views/incidents";

const INCIDENT = "0199a0a0-0000-7000-8000-00000000f00d";
const OTHER_INCIDENT = "0199a0a0-0000-7000-8000-00000000f00e";
const EVENT = "0199a0a0-0000-7000-8000-0000000e0001";
const OTHER_EVENT = "0199a0a0-0000-7000-8000-0000000e0002";
const STORE = "0199a0a0-0000-7000-8000-0000000000a1";
const FIRST = "2026-10-20T13:05:00.000Z";
const LAST = "2026-10-28T13:05:00.000Z";
const FIRST_TEXT = "20/10/2026 10:05";
const LAST_TEXT = "28/10/2026 10:05";
const HOSTILE = [
  "<img src=x onerror=alert(1)>",
  "<script>alert(1)</script>",
  "javascript:alert(1)",
  "‮abc",
  '"><svg onload=1>',
];
const BATCH_OR_DELETE = /todos|apagar|excluir/;
const TECHNICAL = /event_gone|unknown_item|already_pending|409|404/;
const NEVER_CREATED = ["script", "img", "svg", "iframe"];
const READ_ONLY = {
  ...OWNER,
  capabilities: ["operational_incident:read", "platform:read"],
};
const WITH_RETRY = {
  ...OWNER,
  capabilities: [
    "operational_incident:read",
    "operational_incident:retry",
    "platform:read",
  ],
};

function incidentOf(
  overrides: Partial<OperationalIncidentSummary> = {}
): OperationalIncidentSummary {
  return {
    cause: "retries_exhausted",
    deadEvents: 2,
    firstSeenAt: FIRST,
    id: INCIDENT,
    kind: "queue_dead_letter",
    lastReference: "msg-123.abc:9",
    lastSeenAt: LAST,
    occurrenceCount: 7,
    subject: "billing.payment_confirmed",
    ...overrides,
  };
}

function eventOf(overrides: Partial<DeadEventSummary> = {}): DeadEventSummary {
  return {
    eventId: EVENT,
    eventType: "billing.payment_confirmed",
    firstSeenAt: FIRST,
    lastSeenAt: LAST,
    occurrences: 3,
    organizationId: STORE,
    retriedAt: null,
    retryCount: 0,
    state: "dead",
    ...overrides,
  };
}

const listPage = (
  incidents: OperationalIncidentSummary[],
  next: string | null = null
): OperationalIncidentPage => ({ incidents, next });

function detail(
  events: DeadEventSummary[] = [eventOf()],
  overrides: Partial<OperationalIncidentDetail["incident"]> = {},
  next: string | null = null
): OperationalIncidentDetail {
  const { deadEvents: _deadEvents, ...incident } = incidentOf(overrides);
  return { events, incident, next };
}

const listScreen = (answers: Answer[], who: Answer = json(WITH_RETRY)) =>
  mount(answers, who, undefined, screenContext({ screen: "incidentes" }));

const detailScreen = (
  answers: Answer[],
  who: Answer = json(WITH_RETRY),
  id: string | null = INCIDENT
) => mount(answers, who, undefined, screenContext({ id, screen: "incidente" }));

const search = (call: Call | undefined) =>
  new URL(call?.path ?? "", "http://admin.test").searchParams;

const bodyOf = (call: Call | undefined) =>
  JSON.parse(String(call?.init.body ?? "null"));

const rowsOf = (root: FakeElement) =>
  byTag(root, "tbody").flatMap((body) => byTag(body, "tr"));

const rowOfEvent = (root: FakeElement, eventId: string) =>
  rowsOf(root).find((row) => row.textContent.includes(eventId));

const lineOf = (root: FakeElement, eventId: string) =>
  byTag(rowOfEvent(root, eventId) as FakeElement, "p").find(
    (element) => element.getAttribute("role") === "status"
  );

const retryButton = (root: FakeElement, eventId: string) =>
  byTag(rowOfEvent(root, eventId) as FakeElement, "button")[0];

const retryPath = (eventId = EVENT, incident = INCIDENT) =>
  `/api/operational-incidents/${incident}/events/${eventId}/retry`;

const hrefs = (root: FakeElement) =>
  byTag(root, "a").map((link) => link.getAttribute("href"));

function pending() {
  let release: (response: Response) => void = () => undefined;
  const answer: Answer = () =>
    new Promise<Response>((resolve) => {
      release = resolve;
    });
  return { answer, release: (response: Response) => release(response) };
}

describe("the list of incidents (AC-P2.1)", () => {
  it("reads one page of 25 when the screen opens, with no case and no store in the request (AC-P2.4)", async () => {
    const { calls } = await listScreen([json(listPage([incidentOf()]))]);

    expect(calls.map((call) => [call.init.method, call.path])).toEqual([
      ["GET", "/api/whoami"],
      ["GET", "/api/operational-incidents?limit=25"],
    ]);
  });

  it("shows the type, cause, subject, count, first and last occurrence and how many dead events are left, with a link", async () => {
    const { root } = await listScreen([json(listPage([incidentOf()]))]);

    const [row] = rowsOf(root);
    const cells = byTag(row as FakeElement, "td").map(
      (cell) => cell.textContent
    );
    expect(cells.slice(0, 7)).toEqual([
      "Fila de mensagens",
      "Tentativas esgotadas",
      "billing.payment_confirmed",
      "7",
      FIRST_TEXT,
      LAST_TEXT,
      "2",
    ]);
    expect(hrefs(root)).toEqual([`/incidentes/${INCIDENT}`]);
    expect(visibleText(root)).toContain("1 incidente.");
  });

  it("shows no message body, store, customer or reference, even when the server sends them", async () => {
    const { root } = await listScreen([
      json(
        listPage([
          {
            ...incidentOf({ lastReference: "ref-secret.1" }),
            organizationId: STORE,
            payload: "corpo da mensagem",
          } as OperationalIncidentSummary,
        ])
      ),
    ]);

    const text = visibleText(root);
    expect(text).not.toContain("ref-secret.1");
    expect(text).not.toContain("corpo da mensagem");
    expect(text).not.toContain(STORE);
  });

  it("says nothing is left when there is no incident", async () => {
    const { root } = await listScreen([json(listPage([]))]);

    expect(visibleText(root)).toContain(NO_INCIDENTS);
    expect(rowsOf(root)).toHaveLength(0);
  });

  it("reads the next page by its cursor and keeps the first", async () => {
    const { calls, root } = await listScreen([
      json(listPage([incidentOf()], OTHER_INCIDENT)),
      json(listPage([incidentOf({ deadEvents: 0, id: OTHER_INCIDENT })])),
    ]);
    expect(visibleText(root)).toContain("Há mais");

    buttons(root, "Carregar mais")[0]?.click();
    await flush();

    expect(search(calls[2]).get("after")).toBe(OTHER_INCIDENT);
    expect(search(calls[2]).get("limit")).toBe("25");
    expect(rowsOf(root)).toHaveLength(2);
    expect(visibleText(root)).toContain("2 incidentes.");
  });

  it("reads again only when asked (Atualizar), once per click", async () => {
    const { calls, root } = await listScreen([
      json(listPage([incidentOf()])),
      json(listPage([])),
    ]);

    buttons(root, "Atualizar")[0]?.click();
    await flush();

    expect(calls).toHaveLength(3);
    expect(visibleText(root)).toContain(NO_INCIDENTS);
  });

  it.each([
    ["a 403", json({ error: "forbidden" }, 403), PROBLEM_TEXT.forbidden],
    ["a 429", json({ error: "rate_limited" }, 429), PROBLEM_TEXT.rate_limited],
    ["a 503", json({ error: "x" }, 503), PROBLEM_TEXT.unavailable],
    ["a 400", json({ error: "invalid_request" }, 400), PROBLEM_TEXT.invalid],
    ["a 500", json({ error: "internal_error" }, 500), PROBLEM_TEXT.failed],
    ["no network", new Error("down"), PROBLEM_TEXT.network],
  ])(
    "says the sentence of the problem, with no code, on %s",
    async (_name, answer, text) => {
      const { root } = await listScreen([answer]);

      expect(alertOf(root)?.textContent).toBe(text);
      expect(rowsOf(root)).toHaveLength(0);
    }
  );

  it("shows hostile text as text and builds only the page's own elements (AC-C7)", async () => {
    const { document, root } = await listScreen([
      json(
        listPage(
          HOSTILE.map((subject, index) =>
            incidentOf({
              cause: subject,
              id: `0199a0a0-0000-7000-8000-0000000000b${index}`,
              kind: subject,
              subject,
            })
          )
        )
      ),
    ]);

    expect(rowsOf(root)).toHaveLength(HOSTILE.length);
    expect(visibleText(root)).toContain("<script>alert(1)</script>");
    expect(
      document.created.filter((tag) => NEVER_CREATED.includes(tag))
    ).toEqual([]);
    expect(hrefs(root).every((href) => href?.startsWith("/incidentes/"))).toBe(
      true
    );
  });

  it("makes no link from an ID that is not a UUID", async () => {
    const { root } = await listScreen([
      json(listPage([incidentOf({ id: "../api/funnel" })])),
    ]);

    expect(hrefs(root)).toEqual([]);
  });

  it("shows only the sentence of no permission, and asks nothing, without the read capability", async () => {
    const { calls, root } = await listScreen(
      [],
      json({ ...OWNER, capabilities: ["platform:read"] })
    );

    expect(visibleText(root)).toContain(PROBLEM_TEXT.forbidden);
    expect(calls.map((call) => call.path)).toEqual(["/api/whoami"]);
  });
});

describe("one incident (AC-P2.2, AC-P2.5)", () => {
  it("reads the incident and its first page of events once, with a GET and no case", async () => {
    const { calls } = await detailScreen([json(detail())]);

    expect(calls.map((call) => [call.init.method, call.path])).toEqual([
      ["GET", "/api/whoami"],
      ["GET", `/api/operational-incidents/${INCIDENT}?limit=25`],
    ]);
  });

  it("says the count adds up forever and that the events to send again are what to follow (AC-P2.5)", async () => {
    const { root } = await detailScreen([json(detail())]);

    expect(visibleText(root)).toContain(FOREVER_TEXT);
  });

  it("shows the incident's facts and each event's line", async () => {
    const { root } = await detailScreen([
      json(
        detail([
          eventOf(),
          eventOf({
            eventId: OTHER_EVENT,
            retriedAt: LAST,
            retryCount: 2,
            state: "retried",
          }),
        ])
      ),
    ]);

    const text = visibleText(root);
    expect(text).toContain("Fila de mensagens");
    expect(text).toContain("Tentativas esgotadas");
    expect(text).toContain(FIRST_TEXT);
    expect(text).toContain("2 eventos.");
    const [dead, retried] = rowsOf(root);
    expect(dead?.textContent).toContain("Morto, a reenviar");
    expect(dead?.textContent).toContain("Nenhum");
    expect(retried?.textContent).toContain("Já reenviado");
    expect(retried?.textContent).toContain(`2, o último em ${LAST_TEXT}`);
  });

  it.each(["msg-123.abc:9", ...HOSTILE])(
    "shows the reference %j as text and never as a link (AC-P2.2, AC-C7)",
    async (reference) => {
      const { document, root } = await detailScreen([
        json(detail([eventOf()], { lastReference: reference })),
      ]);

      // an invisible direction control is shown as the replacement character, so the operator sees it
      expect(visibleText(root)).toContain(
        reference.replace("\u202e", "\ufffd")
      );
      expect(hrefs(root)).toEqual(["/incidentes"]);
      expect(
        document.created.filter((tag) => NEVER_CREATED.includes(tag))
      ).toEqual([]);
    }
  );

  it("shows a dash when there is no reference", async () => {
    const { root } = await detailScreen([
      json(detail([eventOf()], { lastReference: null })),
    ]);

    const term = byTag(root, "dt").find(
      (item) => item.textContent === "Referência"
    );
    expect(term?.parent?.querySelector("dd")?.textContent).toBe("—");
  });

  it("shows no store of the events and no message body", async () => {
    const { root } = await detailScreen([
      json(
        detail([
          { ...eventOf(), payload: "corpo da mensagem" } as DeadEventSummary,
        ])
      ),
    ]);

    const text = visibleText(root);
    expect(text).not.toContain(STORE);
    expect(text).not.toContain("corpo da mensagem");
  });

  it("says there is no dead event, and offers no retry, when the page has none", async () => {
    const { root } = await detailScreen([json(detail([]))]);

    expect(visibleText(root)).toContain(NO_EVENTS);
    expect(buttons(root, "Reenviar")).toHaveLength(0);
    expect(visibleText(root)).not.toContain(RETRY_EFFECT);
  });

  it("reads the next page of events by its cursor", async () => {
    const { calls, root } = await detailScreen([
      json(detail([eventOf()], {}, OTHER_EVENT)),
      json(detail([eventOf({ eventId: OTHER_EVENT })])),
    ]);

    buttons(root, "Carregar mais")[0]?.click();
    await flush();

    expect(search(calls[2]).get("after")).toBe(OTHER_EVENT);
    expect(rowsOf(root)).toHaveLength(2);
  });

  it("says the incident was not found on a 404", async () => {
    const { root } = await detailScreen([json({ error: "not_found" }, 404)]);

    expect(alertOf(root)?.textContent).toBe(INCIDENT_NOT_FOUND);
  });

  it("says it was not found, with no request, when the context has no ID", async () => {
    const { calls, root } = await detailScreen([], json(WITH_RETRY), null);

    expect(alertOf(root)?.textContent).toBe(INCIDENT_NOT_FOUND);
    expect(calls.map((call) => call.path)).toEqual(["/api/whoami"]);
  });

  it("asks the same, with no POST, each time the screen opens (AC-C5)", async () => {
    const first = await detailScreen([json(detail())]);
    const second = await detailScreen([json(detail())]);

    const summarize = (calls: Call[]) =>
      calls.map((call) => [call.init.method, call.path]);
    expect(summarize(second.calls)).toEqual(summarize(first.calls));
    expect(first.calls.every((call) => call.init.method === "GET")).toBe(true);
  });

  it("shows only the sentence of no permission, and asks nothing, without the read capability", async () => {
    const { calls, root } = await detailScreen(
      [],
      json({ ...OWNER, capabilities: ["platform:read"] })
    );

    expect(visibleText(root)).toContain(PROBLEM_TEXT.forbidden);
    expect(calls).toHaveLength(1);
  });
});

describe("the retry of one event (AC-P2.3, AC-P2.4)", () => {
  it("says the effect and the audit above the button, and has no reason field, no batch and no delete", async () => {
    const { root } = await detailScreen([json(detail())]);

    expect(visibleText(root)).toContain(RETRY_EFFECT);
    expect(RETRY_EFFECT).toContain(
      "O evento volta para a fila e será enviado no próximo ciclo (até uma hora). Reenviar de novo é seguro."
    );
    expect(RETRY_EFFECT).toContain("Fica na auditoria");
    const tags = allElements(root).map((element) => element.tagName);
    expect(tags).not.toContain("input");
    expect(tags).not.toContain("select");
    expect(tags).not.toContain("textarea");
    const labels = byTag(root, "button")
      .filter((button) => !button.hasAttribute("hidden"))
      .map((button) => button.textContent);
    expect(labels).toEqual(["Reenviar"]);
    expect(visibleText(root).toLowerCase()).not.toMatch(BATCH_OR_DELETE);
  });

  it("offers no retry, and does not say the effect, without the retry capability (AC-C1)", async () => {
    const { root } = await detailScreen(
      [json(detail([eventOf(), eventOf({ eventId: OTHER_EVENT })]))],
      json(READ_ONLY)
    );

    expect(buttons(root, "Reenviar")).toHaveLength(0);
    expect(visibleText(root)).not.toContain(RETRY_EFFECT);
    expect(rowsOf(root)).toHaveLength(2);
    expect(byTag(root, "th").map((cell) => cell.textContent)).not.toContain(
      "Ação"
    );
  });

  it("sends one POST with an empty JSON body to the event's own path", async () => {
    const { calls, root } = await detailScreen([
      json(detail()),
      json({ result: "retried" }),
      json(detail()),
    ]);

    retryButton(root, EVENT)?.click();
    await flush();

    expect(calls.filter((call) => call.init.method === "POST")).toHaveLength(1);
    expect(calls[2]?.init.method).toBe("POST");
    expect(calls[2]?.path).toBe(retryPath());
    expect(bodyOf(calls[2])).toEqual({});
  });

  it.each([
    [
      "retried",
      200,
      "Reenviado às 12:07. O evento sai no próximo ciclo (até uma hora).",
      true,
    ],
    [
      "already_pending",
      200,
      "Este evento já estava na fila. Nada foi mudado; ele sai no próximo ciclo (até uma hora).",
      true,
    ],
    [
      "busy",
      409,
      "Este evento está sendo processado agora. Nada foi mudado. Tente de novo mais tarde.",
      true,
    ],
    [
      "event_gone",
      409,
      "Este evento não existe mais e não pode ser reenviado. Nada foi mudado.",
      true,
    ],
    [
      "unknown_item",
      404,
      "Este evento não foi encontrado neste incidente. Nada foi mudado. A lista foi atualizada.",
      true,
    ],
  ] as const)(
    "says %s on the event's own line, as a status with no code, and reads the list again after every answer",
    async (result, status, text, rereads) => {
      const answers = [json(detail()), json({ result }, status)];
      if (rereads) {
        answers.push(json(detail()));
      }
      const { calls, root } = await detailScreen(answers);

      retryButton(root, EVENT)?.click();
      await flush();

      const line = lineOf(root, EVENT);
      expect(line?.textContent).toBe(text);
      expect(line?.getAttribute("role")).toBe("status");
      expect(calls).toHaveLength(rereads ? 4 : 3);
      if (rereads) {
        expect(calls[3]?.init.method).toBe("GET");
        expect(calls[3]?.path).toBe(
          `/api/operational-incidents/${INCIDENT}?limit=25`
        );
      }
      expect(alertOf(root)).toBeUndefined();
      expect(visibleText(root)).not.toMatch(TECHNICAL);
      expect(document_focus(root)).toBe(line);
    }
  );

  it("keeps the line's sentence after the list was read again, on the event's new line", async () => {
    const { root } = await detailScreen([
      json(detail([eventOf(), eventOf({ eventId: OTHER_EVENT })])),
      json({ result: "busy" }, 409),
      json(detail([eventOf(), eventOf({ eventId: OTHER_EVENT })])),
    ]);

    retryButton(root, EVENT)?.click();
    await flush();

    expect(lineOf(root, EVENT)?.textContent).toContain("sendo processado");
    expect(lineOf(root, OTHER_EVENT)?.textContent).toBe("");
    expect(buttons(root, "Reenviar")).toHaveLength(2);
  });

  it("says the sentence in the page's status when the event is no longer in the list that was read again", async () => {
    const { root } = await detailScreen([
      json(detail([eventOf()])),
      json({ result: "unknown_item" }, 404),
      json(detail([])),
    ]);

    retryButton(root, EVENT)?.click();
    await flush();

    expect(visibleText(root)).toContain("não foi encontrado neste incidente");
  });

  it("shows the state the server says after a retry, with the sentence kept, and never a dead line beside it", async () => {
    const { root } = await detailScreen([
      json(detail([eventOf(), eventOf({ eventId: OTHER_EVENT })])),
      json({ result: "retried" }),
      json(
        detail([
          eventOf({ retriedAt: LAST, retryCount: 1, state: "retried" }),
          eventOf({ eventId: OTHER_EVENT }),
        ])
      ),
    ]);

    retryButton(root, EVENT)?.click();
    await flush();

    const row = rowOfEvent(root, EVENT);
    expect(row?.textContent).toContain("Já reenviado");
    expect(row?.textContent).not.toContain("Morto, a reenviar");
    expect(row?.textContent).toContain(`1, o último em ${LAST_TEXT}`);
    expect(lineOf(root, EVENT)?.textContent).toBe(
      "Reenviado às 12:07. O evento sai no próximo ciclo (até uma hora)."
    );
    expect(rowOfEvent(root, OTHER_EVENT)?.textContent).toContain("Nenhum");
    expect(lineOf(root, OTHER_EVENT)?.textContent).toBe("");
  });

  it("reads the list again after already_pending and shows the server's state", async () => {
    const { calls, root } = await detailScreen([
      json(detail()),
      json({ result: "already_pending" }),
      json(
        detail([eventOf({ retriedAt: LAST, retryCount: 1, state: "retried" })])
      ),
    ]);

    retryButton(root, EVENT)?.click();
    await flush();

    expect(calls).toHaveLength(4);
    expect(calls[3]?.init.method).toBe("GET");
    expect(rowOfEvent(root, EVENT)?.textContent).toContain("Já reenviado");
    expect(lineOf(root, EVENT)?.textContent).toContain("já estava na fila");
  });

  it("says the sentence in the page's status when the retried event left the list that was read again", async () => {
    const { root } = await detailScreen([
      json(detail([eventOf()])),
      json({ result: "retried" }),
      json(detail([])),
    ]);

    retryButton(root, EVENT)?.click();
    await flush();

    expect(visibleText(root)).toContain("Reenviado às 12:07");
  });

  it("sends one request for a double click and keeps every button off until the answer", async () => {
    const held = pending();
    const { calls, root } = await detailScreen([
      json(detail([eventOf(), eventOf({ eventId: OTHER_EVENT })])),
      held.answer,
    ]);
    const first = retryButton(root, EVENT);

    first?.click();
    first?.click();
    retryButton(root, OTHER_EVENT)?.click();
    await flush();

    expect(calls.filter((call) => call.init.method === "POST")).toHaveLength(1);
    expect(first?.getAttribute("aria-disabled")).toBe("true");
    expect(first?.textContent).toBe("Reenviando…");
    expect(retryButton(root, OTHER_EVENT)?.getAttribute("aria-disabled")).toBe(
      "true"
    );
    expect(lineOf(root, EVENT)?.textContent).toBe("Reenviando…");

    held.release(json({ result: "retried" }));
    await flush();

    expect(first?.getAttribute("aria-disabled")).toBe("false");
    expect(first?.textContent).toBe("Reenviar");
    expect(calls.filter((call) => call.init.method === "POST")).toHaveLength(1);
  });

  it("lets the operator send the same event again after the answer, as a new request", async () => {
    const { calls, root } = await detailScreen([
      json(detail()),
      json({ result: "retried" }),
      json(detail()),
      json({ result: "already_pending" }),
      json(detail()),
    ]);

    retryButton(root, EVENT)?.click();
    await flush();
    retryButton(root, EVENT)?.click();
    await flush();

    expect(calls.filter((call) => call.init.method === "POST")).toHaveLength(2);
    expect(lineOf(root, EVENT)?.textContent).toContain("já estava na fila");
  });

  it("makes no retry button for an event whose ID is not a UUID, so the URL never carries it", async () => {
    const { calls, root } = await detailScreen([
      json(detail([eventOf({ eventId: "../../api/funnel" })])),
    ]);

    expect(buttons(root, "Reenviar")).toHaveLength(0);
    expect(calls).toHaveLength(2);
  });

  it.each([
    ["403", json({ error: "forbidden" }, 403), PROBLEM_TEXT.forbidden],
    [
      "429 with the wait",
      new Response("{}", { headers: { "retry-after": "120" }, status: 429 }),
      "Limite de consultas por hora atingido. Tente de novo em 2 minutos.",
    ],
    ["429", json({ error: "rate_limited" }, 429), PROBLEM_TEXT.rate_limited],
    ["503", json({ error: "x" }, 503), PROBLEM_TEXT.unavailable],
    ["400", json({ error: "invalid_request" }, 400), PROBLEM_TEXT.failed],
    [
      "404 without a result",
      json({ error: "not_found" }, 404),
      PROBLEM_TEXT.failed,
    ],
    ["409 without a result", json({ error: "x" }, 409), PROBLEM_TEXT.failed],
    ["500", json({ error: "internal_error" }, 500), PROBLEM_TEXT.failed],
    [
      "200 with a result of no known kind",
      json({ result: "deleted" }),
      PROBLEM_TEXT.failed,
    ],
    ["no network", new Error("down"), RETRY_UNKNOWN],
  ])(
    "says the sentence of a %s as an alert with the focus, with no code, and reads nothing again",
    async (_name, answer, text) => {
      const { calls, root } = await detailScreen([json(detail()), answer]);

      retryButton(root, EVENT)?.click();
      await flush();

      expect(alertOf(root)?.textContent).toBe(text);
      expect(calls).toHaveLength(3);
      expect(lineOf(root, EVENT)?.textContent).toBe("");
      expect(retryButton(root, EVENT)?.getAttribute("aria-disabled")).toBe(
        "false"
      );
    }
  );

  it("never repeats a failed retry by itself", async () => {
    const { calls, root } = await detailScreen([
      json(detail()),
      new Error("down"),
    ]);

    retryButton(root, EVENT)?.click();
    await flush();
    await flush();

    expect(calls.filter((call) => call.init.method === "POST")).toHaveLength(1);
  });
});

function document_focus(root: FakeElement) {
  return root.ownerDocument.activeElement;
}

describe("Início counts the incidents with events to send again (AC-P1.2b)", () => {
  const home = (answers: Answer[], capabilities: string[]) =>
    mount(
      answers,
      json({ ...OWNER, capabilities }),
      undefined,
      screenContext({ screen: "inicio" })
    );
  const READ = ["operational_incident:read"];

  it("reads the list once, a GET of the largest page, and links to the screen", async () => {
    const { calls, root } = await home(
      [json(listPage([incidentOf(), incidentOf({ deadEvents: 5 })]))],
      READ
    );

    expect(calls.map((call) => [call.init.method, call.path])).toEqual([
      ["GET", "/api/whoami"],
      ["GET", "/api/operational-incidents?limit=50"],
    ]);
    expect(visibleText(root)).toContain("2 incidentes com eventos a reenviar");
    expect(hrefs(root)).toEqual(["/incidentes"]);
  });

  it("counts only the incidents that still have a dead event, and says 1 in the singular", async () => {
    const { root } = await home(
      [json(listPage([incidentOf(), incidentOf({ deadEvents: 0 })]))],
      READ
    );

    expect(visibleText(root)).toContain("1 incidente com eventos a reenviar");
  });

  it('says "ou mais" when the server has another page', async () => {
    const { root } = await home(
      [json(listPage([incidentOf()], OTHER_INCIDENT))],
      READ
    );

    expect(visibleText(root)).toContain(
      "1 ou mais incidentes com eventos a reenviar"
    );
  });

  it("does not say that none is left when the page has none but there is another one", async () => {
    const { root } = await home(
      [json(listPage([incidentOf({ deadEvents: 0 })], OTHER_INCIDENT))],
      READ
    );

    expect(visibleText(root)).toContain("Há incidentes na lista");
    expect(visibleText(root)).not.toContain("Nada esperando por você.");
  });

  it("says nothing waits when no incident has an event to send again", async () => {
    const { root } = await home(
      [json(listPage([incidentOf({ deadEvents: 0 })]))],
      READ
    );

    expect(visibleText(root)).toContain("Nada esperando por você.");
    expect(hrefs(root)).toEqual([]);
  });

  it("does not read the incidents without the read capability", async () => {
    const { calls, root } = await home([], ["platform:read"]);

    expect(calls.map((call) => call.path)).toEqual(["/api/whoami"]);
    expect(visibleText(root)).toContain("Nada esperando por você.");
  });

  it("says the count could not be made, with the sentence of the problem, and not that nothing waits", async () => {
    const { root } = await home([json({ error: "x" }, 503)], READ);

    expect(alertOf(root)?.textContent).toBe(
      `Não foi possível contar os incidentes. ${PROBLEM_TEXT.unavailable}`
    );
    expect(visibleText(root)).not.toContain("Nada esperando por você.");
  });

  it("keeps the case count when the incidents cannot be read, and the other way round", async () => {
    const { root } = await home(
      [
        json({
          cases: [
            {
              closedAt: null,
              id: "0199a0a0-0000-7000-8000-00000000c0de",
              kind: "support",
              openedAt: FIRST,
              organizationId: STORE,
              organizationName: "Loja da Ana",
              reason: "x",
              status: "open",
            },
          ],
          next: null,
        }),
        json({ error: "x" }, 503),
      ],
      ["support_case:manage", ...READ]
    );

    expect(visibleText(root)).toContain("1 caso de suporte aberto");
    expect(alertOf(root)?.textContent).toContain("incidentes");
  });
});

describe("when the list cannot be read again after a retry", () => {
  it("keeps the list and the sentence of the event, says the list could not be read, and does not claim it was updated", async () => {
    const { root } = await detailScreen([
      json(detail()),
      json({ result: "unknown_item" }, 404),
      json({ error: "x" }, 503),
    ]);

    retryButton(root, EVENT)?.click();
    await flush();

    expect(rowsOf(root)).toHaveLength(1);
    expect(lineOf(root, EVENT)?.textContent).toBe(
      "Este evento não foi encontrado neste incidente. Nada foi mudado."
    );
    expect(alertOf(root)?.textContent).toBe(PROBLEM_TEXT.unavailable);
    expect(retryButton(root, EVENT)?.getAttribute("aria-disabled")).toBe(
      "false"
    );
  });

  it.each([
    [
      "retried",
      "Reenviado às 12:07. O evento sai no próximo ciclo (até uma hora). Não foi possível reler a lista: o estado desta linha pode estar desatualizado.",
    ],
    [
      "already_pending",
      "Este evento já estava na fila. Nada foi mudado; ele sai no próximo ciclo (até uma hora). Não foi possível reler a lista: o estado desta linha pode estar desatualizado.",
    ],
  ] as const)(
    "keeps the sentence of %s with the warning that the list was not read again",
    async (result, text) => {
      const { root } = await detailScreen([
        json(detail()),
        json({ result }),
        json({ error: "x" }, 503),
      ]);

      retryButton(root, EVENT)?.click();
      await flush();

      expect(rowsOf(root)).toHaveLength(1);
      expect(lineOf(root, EVENT)?.textContent).toBe(text);
      expect(alertOf(root)?.textContent).toBe(PROBLEM_TEXT.unavailable);
      expect(retryButton(root, EVENT)?.getAttribute("aria-disabled")).toBe(
        "false"
      );
    }
  );

  it("frees the buttons when the list read again is malformed", async () => {
    const { root } = await detailScreen([
      json(detail()),
      json({ result: "busy" }, 409),
      json({ events: [null], incident: {}, next: null }),
    ]);

    retryButton(root, EVENT)?.click();
    await flush();

    expect(retryButton(root, EVENT)?.getAttribute("aria-disabled")).toBe(
      "false"
    );
  });
});

describe("Início when both counts fail", () => {
  it("says both in one alert instead of one hiding the other", async () => {
    const { root } = await mount(
      [json({ error: "x" }, 503), json({ error: "x" }, 503)],
      json({
        ...OWNER,
        capabilities: ["support_case:manage", "operational_incident:read"],
      }),
      undefined,
      screenContext({ screen: "inicio" })
    );

    expect(alertOf(root)?.textContent).toBe(
      `Não foi possível contar os casos abertos e os incidentes. ${PROBLEM_TEXT.unavailable}`
    );
    expect(visibleText(root)).not.toContain("Nada esperando por você.");
  });
});
