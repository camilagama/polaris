import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROBLEM_TEXT } from "./api";
import {
  allElements,
  buttons,
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
import type { SupportCaseDetail } from "./types";
import { NO_ACCESS } from "./views/access";
import {
  CUSTOMER_GONE,
  FIELD_TEXT,
  NO_ACCESS_NOW,
  REVEAL_AUDIT,
  type REVEAL_FIELDS,
  REVEAL_GONE,
  REVEAL_RATE_LIMITED,
  REVEAL_SECONDS,
  REVEAL_UNDO,
  REVEAL_UNKNOWN,
  REVEALED_MARK,
} from "./views/reveal";

/**
 * Revealing one field of one customer on the screen of a support case (corte admin-v2, Parte 6): the capability that
 * shows the menu (AC-P6.2), one field and one confirmation per request, never a batch (AC-P6.1), the value only in
 * its row, as text, and gone after 30 seconds or at once when the access ends, the case closes, the tab is hidden,
 * the page leaves or another reveal starts (AC-P6.3), and the four fields only (AC-P6.4).
 */

const CASE = "0199a0a0-0000-7000-8000-00000000c0de";
const ACCESS_VIEW_LISTENERS = 1;
const STORE = "0199a0a0-0000-7000-8000-0000000000a1";
const GRANT = "0199d0d0-0000-7000-8000-0000000000a1";
const C1 = "0199c1c1-0000-7000-8000-000000000001";
const C2 = "0199c1c1-0000-7000-8000-000000000002";
const ENDS = "2026-10-28T18:45:00.000Z";
const NOW = "2026-10-28T15:07:00.000Z";
const PHONE = "(11) 91234-5678";
const OPERATOR = {
  ...OWNER,
  capabilities: [
    "pii:reveal",
    "support_case:manage",
    "tenant_access:grant",
    "tenant_data:read",
  ],
};
const WITHOUT_REVEAL = {
  ...OWNER,
  capabilities: ["support_case:manage", "tenant_data:read"],
};
const HOSTILE = "<img src=x onerror=alert(1)>\n‮abc\u0007fim";
const REVEAL_PATH = new RegExp(
  `^/api/support-cases/${CASE}/customers/(.+)/reveal$`
);
const TECHNICAL_TEXT =
  /tenant_access_denied|invalid_[a-z]+|not_found|\b4\d\d\b|\b50\d\b/;
const OPEN_MENU = "Revelar ▾";
const ROW_1 = "M*** S***";
const ROW_2 = "S*** L***";
const BATCH_OR_SECRET =
  /tudo|todos|página inteira|lote|senha|token|segredo|chave/i;

type Grant = SupportCaseDetail["grants"][number];

const grantRow = (overrides: Partial<Grant> = {}): Grant => ({
  active: true,
  expiresAt: ENDS,
  id: GRANT,
  principalId: OWNER.principal.id,
  revokedAt: null,
  startsAt: "2026-10-28T14:00:00.000Z",
  ...overrides,
});

function detail(
  grants: Grant[] = [grantRow()],
  overrides: Partial<SupportCaseDetail["case"]> = {}
): SupportCaseDetail {
  return {
    audit: [],
    case: {
      closedAt: null,
      context: null,
      id: CASE,
      kind: "support",
      openedAt: "2026-10-28T13:05:00.000Z",
      openedBy: OWNER.principal.id,
      organizationId: STORE,
      organizationName: "Loja da Ana",
      reason: "Dono não acha um cliente",
      resolution: null,
      status: "open",
      ...overrides,
    },
    grants,
  };
}

const customer = (name: string, id: string) => ({
  archived: false,
  email: "m***@e***.br",
  hasNotes: true,
  id,
  name,
  phone: "***",
});

const customersPage = () =>
  json({
    customers: [customer("M*** S***", C1), customer("S*** L***", C2)],
    next: null,
  });

const revealed = (customerId: string, field: string, value: string | null) =>
  json({ customerId, field, value });

const refusal = (error: string, status: number, headers?: HeadersInit) =>
  new Response(JSON.stringify({ error }), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });

const clock = { now: new Date(NOW) };

const open = async (
  answers: Answer[],
  caseDetail: SupportCaseDetail = detail(),
  who = OPERATOR
) => {
  clock.now = new Date(NOW);
  const mounted = await mount(
    [json(caseDetail), customersPage(), ...answers],
    json(who),
    () => clock.now,
    screenContext({ id: CASE, screen: "caso" })
  );
  firstButton(mounted.root, "Ver clientes").click();
  await flush();
  return mounted;
};

type Mounted = Awaited<ReturnType<typeof open>>;

const revealListeners = (mounted: Mounted) =>
  mounted.document.listenerCount("visibilitychange") - ACCESS_VIEW_LISTENERS;

const firstButton = (root: FakeElement, text: string): FakeElement => {
  const [target] = buttons(root, text);
  if (target === undefined) {
    throw new Error(`no button ${text}`);
  }
  return target;
};

const click = async (root: FakeElement, text: string, index = 0) => {
  const target = buttons(root, text)[index];
  if (target === undefined) {
    throw new Error(`no button ${text} at ${index}`);
  }
  target.click();
  await flush();
};

/** Opens the menu of a row, picks the field and confirms the review: the whole decision, as a person makes it. */
const reveal = async (
  mounted: Mounted,
  name: string,
  field: (typeof REVEAL_FIELDS)[number]
) => {
  const row = rowOf(mounted, name);
  const menu = row === undefined ? undefined : buttons(row, OPEN_MENU)[0];
  if (menu === undefined) {
    throw new Error(`no menu in the row of ${name}`);
  }
  menu.click();
  await flush();
  await click(mounted.root, FIELD_TEXT[field].label);
  await click(
    mounted.root,
    `Revelar ${FIELD_TEXT[field].article} deste cliente`
  );
};

const shown = (mounted: Mounted) => visibleText(mounted.root);
const revealCalls = (calls: Call[]) =>
  calls.filter((call) => REVEAL_PATH.test(call.path));
const rows = (mounted: Mounted) =>
  allElements(mounted.root).filter((element) => element.tagName === "tr");
const rowOf = (mounted: Mounted, name: string) =>
  rows(mounted).find((row) => row.textContent.includes(name));
const menuOf = (mounted: Mounted, name: string): FakeElement =>
  firstButton(rowOf(mounted, name) as FakeElement, OPEN_MENU);
const bodyOf = (call: Call | undefined) =>
  JSON.parse(String(call?.init.body ?? "null"));

function pending() {
  let release: (response: Response) => void = () => undefined;
  const answer: Answer = () =>
    new Promise<Response>((resolve) => {
      release = resolve;
    });
  return { answer, release: (response: Response) => release(response) };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("who sees the menu (AC-P6.2, AC-C1)", () => {
  it("has no menu, no column and no request for a reveal without pii:reveal", async () => {
    const mounted = await open([], detail(), WITHOUT_REVEAL);

    expect(shown(mounted)).toContain("M*** S***");
    expect(buttons(mounted.root, OPEN_MENU)).toHaveLength(0);
    expect(shown(mounted)).not.toContain("Dado pessoal");
    expect(revealCalls(mounted.calls)).toEqual([]);
  });

  it("gives each listed customer one menu, and lists nothing before the read", async () => {
    const mounted = await mount(
      [json(detail())],
      json(OPERATOR),
      () => clock.now,
      screenContext({ id: CASE, screen: "caso" })
    );
    expect(buttons(mounted.root, OPEN_MENU)).toHaveLength(0);

    const listed = await open([]);
    expect(shown(listed)).toContain("Dado pessoal");
    expect(buttons(listed.root, OPEN_MENU)).toHaveLength(2);
  });

  it("has no menu on the case with no access, where there is no list", async () => {
    clock.now = new Date(NOW);
    const mounted = await mount(
      [json(detail([]))],
      json(OPERATOR),
      () => clock.now,
      screenContext({ id: CASE, screen: "caso" })
    );

    expect(shown(mounted)).toContain(NO_ACCESS);
    expect(buttons(mounted.root, OPEN_MENU)).toHaveLength(0);
  });
});

describe("one field, one decision (AC-P6.1, AC-P6.4, AC-C2)", () => {
  it("offers the four fields and no batch, page or secret", async () => {
    const mounted = await open([]);
    await click(mounted.root, OPEN_MENU, 0);

    const menu = allElements(mounted.root).find(
      (element) => element.getAttribute("role") === "group"
    );
    expect(menu?.children.map((button) => button.textContent)).toEqual([
      "Nome",
      "E-mail",
      "Telefone",
      "Observações",
    ]);
    expect(
      allElements(mounted.root).filter(
        (element) =>
          element.tagName === "button" &&
          BATCH_OR_SECRET.test(
            `${element.textContent} ${element.getAttribute("aria-label") ?? ""}`
          )
      )
    ).toEqual([]);
    expect(revealCalls(mounted.calls)).toEqual([]);
  });

  it("asks first, with the store, the case, the customer, the field and the three lines, and sends nothing yet", async () => {
    const mounted = await open([]);
    await click(mounted.root, OPEN_MENU, 0);
    await click(mounted.root, "Telefone");

    const text = shown(mounted);
    expect(text).toContain("Revise antes de revelar o telefone");
    expect(text).toContain("STAGING");
    expect(text).toContain("Loja da Ana");
    expect(text).toContain("Dono não acha um cliente");
    expect(text).toContain("M*** S***");
    expect(text).toContain(REVEAL_AUDIT);
    expect(text).toContain(REVEAL_UNDO);
    expect(text).toContain(`${REVEAL_SECONDS} segundos`);
    expect(
      buttons(mounted.root, "Revelar o telefone deste cliente")
    ).toHaveLength(1);
    expect(revealCalls(mounted.calls)).toEqual([]);
  });

  it("goes back from the review without sending and with focus on the row's menu", async () => {
    const mounted = await open([]);
    await click(mounted.root, OPEN_MENU, 0);
    await click(mounted.root, "Telefone");
    await click(mounted.root, "Voltar");

    expect(shown(mounted)).not.toContain("Revise antes de revelar");
    expect(revealCalls(mounted.calls)).toEqual([]);
  });

  it("sends one POST naming the field and the customer, and writes the value only in that row", async () => {
    const mounted = await open([revealed(C1, "phone", PHONE)]);
    await reveal(mounted, ROW_1, "phone");

    const [call] = revealCalls(mounted.calls);
    expect(call?.path).toBe(
      `/api/support-cases/${CASE}/customers/${C1}/reveal`
    );
    expect(call?.init.method).toBe("POST");
    expect(bodyOf(call)).toEqual({ field: "phone" });
    const row = rowOf(mounted, "M*** S***");
    expect(visibleText(row as FakeElement)).toContain(PHONE);
    expect(visibleText(row as FakeElement)).toContain(REVEALED_MARK);
    expect(
      visibleText(rowOf(mounted, "S*** L***") as FakeElement)
    ).not.toContain(PHONE);
    expect(
      allElements(mounted.root).filter(
        (element) => element.textContent === PHONE
      )
    ).toHaveLength(1);
    expect(shown(mounted)).not.toContain("Revise antes de revelar");
  });

  it("sends the name of each of the four fields, and nothing else", async () => {
    const mounted = await open([
      revealed(C1, "name", "Maria Souza"),
      revealed(C1, "email", "maria@exemplo.com"),
      revealed(C1, "notes", null),
    ]);
    await reveal(mounted, ROW_1, "name");
    await click(mounted.root, "Esconder agora");
    await reveal(mounted, ROW_1, "email");
    await click(mounted.root, "Esconder agora");
    await reveal(mounted, ROW_1, "notes");

    expect(revealCalls(mounted.calls).map((call) => bodyOf(call))).toEqual([
      { field: "name" },
      { field: "email" },
      { field: "notes" },
    ]);
    expect(shown(mounted)).toContain(FIELD_TEXT.notes.empty);
  });

  it("sends one request for a double click on the confirmation", async () => {
    const held = pending();
    const mounted = await open([held.answer]);
    await click(mounted.root, OPEN_MENU, 0);
    await click(mounted.root, "Telefone");
    const confirm = firstButton(
      mounted.root,
      "Revelar o telefone deste cliente"
    );
    confirm.click();
    confirm.click();
    await flush();

    expect(revealCalls(mounted.calls)).toHaveLength(1);
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    held.release(revealed(C1, "phone", PHONE));
    await flush();
    expect(shown(mounted)).toContain(PHONE);
    expect(revealCalls(mounted.calls)).toHaveLength(1);
  });

  it("keeps one value at a time: a second reveal takes the first off the page", async () => {
    const mounted = await open([
      revealed(C1, "phone", PHONE),
      revealed(C2, "email", "lia@exemplo.com"),
    ]);
    await reveal(mounted, ROW_1, "phone");
    expect(shown(mounted)).toContain(PHONE);

    await reveal(mounted, ROW_2, "email");
    expect(shown(mounted)).not.toContain(PHONE);
    expect(shown(mounted)).toContain("lia@exemplo.com");
    expect(revealCalls(mounted.calls)).toHaveLength(2);
  });

  it("takes the value off the page when another reveal starts, before its answer comes", async () => {
    const held = pending();
    const mounted = await open([revealed(C1, "phone", PHONE), held.answer]);
    await reveal(mounted, ROW_1, "phone");
    await reveal(mounted, ROW_2, "email");

    expect(shown(mounted)).not.toContain(PHONE);
  });
});

describe("the value leaves the page (AC-P6.3)", () => {
  const withValue = async (extra: Answer[] = [], grants?: Grant[]) => {
    const mounted = await open(
      [revealed(C1, "phone", PHONE), ...extra],
      detail(grants)
    );
    await reveal(mounted, ROW_1, "phone");
    expect(shown(mounted)).toContain(PHONE);
    return mounted;
  };

  const maskedAgain = (mounted: Mounted) => {
    expect(shown(mounted)).not.toContain(PHONE);
    expect(
      allElements(mounted.root).filter((element) =>
        element.textContent.includes(PHONE)
      )
    ).toEqual([]);
  };

  it("stays for 30 seconds and not a moment more, then the row says to reveal again", async () => {
    const mounted = await withValue();
    await vi.advanceTimersByTimeAsync(REVEAL_SECONDS * 1000 - 1);
    expect(shown(mounted)).toContain(PHONE);

    await vi.advanceTimersByTimeAsync(1);
    maskedAgain(mounted);
    const row = rowOf(mounted, "M*** S***") as FakeElement;
    expect(visibleText(row)).toContain("Valor escondido: revele de novo.");
    expect(shown(mounted)).toContain(REVEAL_GONE);
    expect(buttons(row, OPEN_MENU)).toHaveLength(1);
  });

  it("makes a new reveal, and a new request, after it left", async () => {
    const mounted = await open([
      revealed(C1, "phone", PHONE),
      revealed(C1, "phone", PHONE),
    ]);
    await reveal(mounted, ROW_1, "phone");
    await vi.advanceTimersByTimeAsync(REVEAL_SECONDS * 1000);
    maskedAgain(mounted);
    await reveal(mounted, ROW_1, "phone");

    expect(shown(mounted)).toContain(PHONE);
    expect(revealCalls(mounted.calls)).toHaveLength(2);
  });

  it("counts the 30 seconds from each reveal, not from the first", async () => {
    const mounted = await open([
      revealed(C1, "phone", PHONE),
      revealed(C2, "email", "lia@exemplo.com"),
    ]);
    await reveal(mounted, ROW_1, "phone");
    await vi.advanceTimersByTimeAsync(20_000);
    await reveal(mounted, ROW_2, "email");
    await vi.advanceTimersByTimeAsync(20_000);

    expect(shown(mounted)).toContain("lia@exemplo.com");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(shown(mounted)).not.toContain("lia@exemplo.com");
  });

  it("goes when the operator hides it", async () => {
    const mounted = await withValue();
    await click(mounted.root, "Esconder agora");

    maskedAgain(mounted);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("goes with the tab hidden, and stays gone when it is visible again", async () => {
    const mounted = await withValue();
    mounted.document.hidden = true;
    mounted.document.dispatch("visibilitychange");
    mounted.document.hidden = false;
    mounted.document.dispatch("visibilitychange");

    maskedAgain(mounted);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("puts the focus on the value when it appears, so the keyboard lands on it", async () => {
    const mounted = await withValue();
    const focused = mounted.document.activeElement;

    expect(focused?.tagName).toBe("bdi");
    expect(focused?.textContent).toBe(PHONE);
    expect(focused?.getAttribute("tabindex")).toBe("-1");
    expect(rowOf(mounted, ROW_1)?.textContent).toContain(PHONE);
  });

  it("puts the focus on the value when the answer comes with the focus still on the confirmation", async () => {
    const held = pending();
    const mounted = await open([held.answer]);
    await click(mounted.root, OPEN_MENU, 0);
    await click(mounted.root, "Telefone");
    await click(mounted.root, "Revelar o telefone deste cliente");
    firstButton(mounted.root, "Revelar o telefone deste cliente").focus();
    held.release(revealed(C1, "phone", PHONE));
    await flush();

    expect(shown(mounted)).toContain(PHONE);
    expect(mounted.document.activeElement?.tagName).toBe("bdi");
  });

  it("puts the focus on the value when the answer comes with the focus on the body", async () => {
    const held = pending();
    const mounted = await open([held.answer]);
    await click(mounted.root, OPEN_MENU, 0);
    await click(mounted.root, "Telefone");
    await click(mounted.root, "Revelar o telefone deste cliente");
    mounted.document.activeElement = mounted.document.body;
    held.release(revealed(C1, "phone", PHONE));
    await flush();

    expect(mounted.document.activeElement?.tagName).toBe("bdi");
  });

  it("does not pull the focus to the value when the operator took it elsewhere while the request answered", async () => {
    const held = pending();
    const mounted = await open([held.answer]);
    await click(mounted.root, OPEN_MENU, 0);
    await click(mounted.root, "Telefone");
    await click(mounted.root, "Revelar o telefone deste cliente");
    const elsewhere = firstButton(mounted.root, "Atualizar a lista");
    elsewhere.focus();
    held.release(revealed(C1, "phone", PHONE));
    await flush();

    expect(shown(mounted)).toContain(PHONE);
    expect(mounted.document.activeElement).toBe(elsewhere);
  });

  it("gives the focus to the row's menu button when the 30 seconds end with the focus on the row", async () => {
    const mounted = await withValue();
    await vi.advanceTimersByTimeAsync(REVEAL_SECONDS * 1000);

    expect(mounted.document.activeElement).toBe(menuOf(mounted, ROW_1));
  });

  it("gives the focus to the row's menu button when it is on the Esconder agora button and the time ends", async () => {
    const mounted = await withValue();
    firstButton(mounted.root, "Esconder agora").focus();
    await vi.advanceTimersByTimeAsync(REVEAL_SECONDS * 1000);

    expect(mounted.document.activeElement).toBe(menuOf(mounted, ROW_1));
  });

  it("gives the focus to the row's menu button when the tab hides the value", async () => {
    const mounted = await withValue();
    mounted.document.hidden = true;
    mounted.document.dispatch("visibilitychange");

    expect(mounted.document.activeElement).toBe(menuOf(mounted, ROW_1));
  });

  it("gives the focus to the row's menu button when the focus fell to the body", async () => {
    const mounted = await withValue();
    mounted.document.activeElement = mounted.document.body;
    await vi.advanceTimersByTimeAsync(REVEAL_SECONDS * 1000);

    expect(mounted.document.activeElement).toBe(menuOf(mounted, ROW_1));
  });

  it("does not take the focus from another place on the page when the value leaves", async () => {
    const mounted = await withValue();
    const elsewhere = firstButton(mounted.root, "Atualizar a lista");
    elsewhere.focus();
    await vi.advanceTimersByTimeAsync(REVEAL_SECONDS * 1000);

    maskedAgain(mounted);
    expect(mounted.document.activeElement).toBe(elsewhere);
  });

  it("hides the value, stops the timer and the listening and says so when another row's menu opens", async () => {
    const mounted = await withValue();
    expect(vi.getTimerCount()).toBe(1);
    expect(revealListeners(mounted)).toBe(1);
    menuOf(mounted, ROW_2).click();
    await flush();

    maskedAgain(mounted);
    expect(vi.getTimerCount()).toBe(0);
    expect(revealListeners(mounted)).toBe(0);
    expect(shown(mounted)).toContain("Valor escondido.");
    expect(
      buttons(rowOf(mounted, ROW_2) as FakeElement, "Telefone")
    ).toHaveLength(1);
    expect(mounted.document.activeElement).toBe(menuOf(mounted, ROW_2));
  });

  it("keeps the value while the tab stays visible", async () => {
    const mounted = await withValue();
    mounted.document.dispatch("visibilitychange");

    expect(shown(mounted)).toContain(PHONE);
  });

  it("goes when the page leaves, and listens to nothing afterwards", async () => {
    const mounted = await withValue();
    mounted.document.defaultView.dispatch("pagehide");

    maskedAgain(mounted);
    expect(vi.getTimerCount()).toBe(0);
    expect(mounted.document.listenerCount("visibilitychange")).toBe(0);
  });

  it("goes when the access is ended, with the list", async () => {
    const mounted = await withValue([
      json({ revoked: true }),
      json(detail([grantRow({ active: false })])),
    ]);
    await click(mounted.root, "Encerrar acesso agora");
    await click(mounted.root, "Confirmar encerramento do acesso");

    maskedAgain(mounted);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("goes when the case is closed", async () => {
    const mounted = await withValue([
      json({ changed: true, id: CASE, status: "closed" }),
      json(
        detail([grantRow({ active: false })], {
          closedAt: "2026-10-28T15:08:00.000Z",
          resolution: "Resolvido",
          status: "closed",
        })
      ),
    ]);
    await click(mounted.root, "Fechar atendimento");
    await click(mounted.root, "Revisar o fechamento");
    await click(mounted.root, "Confirmar o fechamento do atendimento");

    expect(shown(mounted)).toContain("Atendimento fechado");
    maskedAgain(mounted);
    expect(buttons(mounted.root, OPEN_MENU)).toHaveLength(0);
    expect(revealListeners(mounted)).toBe(0);
  });

  it("goes with the server's end of the access when it comes before the 30 seconds", async () => {
    const mounted = await withValue(
      [],
      [grantRow({ expiresAt: "2026-10-28T15:07:10.000Z" })]
    );
    clock.now = new Date("2026-10-28T15:07:10.000Z");
    await vi.advanceTimersByTimeAsync(10_000);

    maskedAgain(mounted);
    expect(shown(mounted)).toContain(NO_ACCESS);
    expect(buttons(mounted.root, OPEN_MENU)).toHaveLength(0);
  });

  it("goes when the list is read again", async () => {
    const mounted = await withValue([customersPage()]);
    await click(mounted.root, "Atualizar a lista");

    maskedAgain(mounted);
    expect(shown(mounted)).toContain("M*** S***");
  });

  it("does not put a value that comes back after the page left on the page", async () => {
    const held = pending();
    const mounted = await open([held.answer]);
    await click(mounted.root, OPEN_MENU, 0);
    await click(mounted.root, "Telefone");
    await click(mounted.root, "Revelar o telefone deste cliente");
    mounted.document.defaultView.dispatch("pagehide");
    held.release(revealed(C1, "phone", PHONE));
    await flush();

    maskedAgain(mounted);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not show a value that comes after the server's end", async () => {
    const held = pending();
    const mounted = await open([held.answer]);
    await click(mounted.root, OPEN_MENU, 0);
    await click(mounted.root, "Telefone");
    await click(mounted.root, "Revelar o telefone deste cliente");
    clock.now = new Date("2026-10-28T19:00:00.000Z");
    held.release(revealed(C1, "phone", PHONE));
    await flush();

    maskedAgain(mounted);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("with no access in force (AC-P6.2)", () => {
  it("does not call the route after the server's end, and says why", async () => {
    const mounted = await open([]);
    await click(mounted.root, OPEN_MENU, 0);
    await click(mounted.root, "Telefone");
    clock.now = new Date("2026-10-28T19:00:00.000Z");
    await click(mounted.root, "Revelar o telefone deste cliente");

    expect(revealCalls(mounted.calls)).toEqual([]);
    expect(shown(mounted)).toContain("O acesso acabou.");
    expect(buttons(mounted.root, OPEN_MENU)).toHaveLength(0);
  });

  it("does not open the menu after the server's end", async () => {
    const mounted = await open([]);
    clock.now = new Date("2026-10-28T19:00:00.000Z");
    await click(mounted.root, OPEN_MENU, 0);

    expect(revealCalls(mounted.calls)).toEqual([]);
    expect(shown(mounted)).toContain("O acesso acabou.");
  });

  it("takes the list off and reads the case again when the server says there is no access", async () => {
    const mounted = await open([
      refusal("tenant_access_denied", 403),
      json(detail([grantRow({ active: false })])),
    ]);
    await reveal(mounted, ROW_1, "phone");

    expect(alertOf(mounted.root)?.textContent).toBe(NO_ACCESS_NOW);
    expect(shown(mounted)).not.toContain("M*** S***");
    expect(shown(mounted)).toContain(NO_ACCESS);
    expect(mounted.calls.map((call) => call.path).at(-1)).toBe(
      `/api/support-cases/${CASE}`
    );
  });
});

describe("the refusals, in words (AC-C3)", () => {
  const cases: [string, Answer, string][] = [
    ["a customer not found", refusal("not_found", 404), CUSTOMER_GONE],
    ["a missing capability", refusal("forbidden", 403), PROBLEM_TEXT.forbidden],
    [
      "the hourly limit of reveals",
      refusal("rate_limited", 429),
      REVEAL_RATE_LIMITED,
    ],
    [
      "the hourly limit of reveals, even with a wait the server named",
      refusal("rate_limited", 429, { "retry-after": "600" }),
      REVEAL_RATE_LIMITED,
    ],
    [
      "a field the server refuses",
      refusal("invalid_request", 400),
      "O pedido não foi aceito. Nada foi revelado.",
    ],
    ["an Access session that ended", refusal("x", 401), PROBLEM_TEXT.session],
    ["an answer that does not come", new Error("offline"), REVEAL_UNKNOWN],
    ["a server error", refusal("internal_error", 500), REVEAL_UNKNOWN],
  ];

  it.each(cases)("says %s and shows no value", async (_name, answer, text) => {
    const mounted = await open([answer]);
    await reveal(mounted, ROW_1, "phone");

    expect(alertOf(mounted.root)?.textContent).toBe(text);
    expect(alertOf(mounted.root)?.textContent).not.toMatch(TECHNICAL_TEXT);
    expect(shown(mounted)).not.toContain(PHONE);
    expect(shown(mounted)).toContain("M*** S***");
    expect(buttons(mounted.root, OPEN_MENU)).toHaveLength(2);
  });

  it("does not show an answer that is not the customer and the field asked", async () => {
    const mounted = await open([revealed(C2, "phone", PHONE)]);
    await reveal(mounted, ROW_1, "phone");

    expect(shown(mounted)).not.toContain(PHONE);
    expect(alertOf(mounted.root)?.textContent).toBe(REVEAL_UNKNOWN);
  });

  it("says the exact words of the limit and does not ask again by itself", async () => {
    const mounted = await open([refusal("rate_limited", 429)]);
    await reveal(mounted, ROW_1, "phone");
    await vi.advanceTimersByTimeAsync(3_600_000);

    expect(alertOf(mounted.root)?.textContent).toBe(
      "Limite de revelações por hora atingido. Nada foi revelado. Tente mais tarde."
    );
    expect(revealCalls(mounted.calls)).toHaveLength(1);
  });

  it("never sends a second request by itself after a failure", async () => {
    const mounted = await open([new Error("offline")]);
    await reveal(mounted, ROW_1, "phone");
    await vi.advanceTimersByTimeAsync(120_000);

    expect(revealCalls(mounted.calls)).toHaveLength(1);
  });
});

describe("no trace of a revealed value (AC-P6.3, AC-C6, AC-C7)", () => {
  it("leaves it out of the address, the title, any request and any attribute", async () => {
    const mounted = await open([revealed(C1, "name", HOSTILE)]);
    await reveal(mounted, ROW_1, "name");

    expect(mounted.navigations).toEqual([]);
    expect(mounted.document.body.getAttribute("title")).toBeNull();
    expect(JSON.stringify(mounted.calls)).not.toContain("onerror");
    expect(
      allElements(mounted.root).filter((element) =>
        [...element.attributes.values()].some((value) =>
          value.includes("onerror")
        )
      )
    ).toEqual([]);
  });

  it("writes the value as text, with line breaks kept and the invisible made visible", async () => {
    const mounted = await open([revealed(C1, "notes", HOSTILE)]);
    await reveal(mounted, ROW_1, "notes");

    const text = shown(mounted);
    expect(text).toContain("<img src=x onerror=alert(1)>\n");
    expect(text).not.toContain("\u0007");
    expect(text).toContain("�");
    expect(
      mounted.document.created.filter((tag) =>
        ["script", "img", "svg", "iframe", "style", "a"].includes(tag)
      )
    ).toEqual([]);
  });
});

describe("what the review of the code found", () => {
  const withValue = async (extra: Answer[]) => {
    const mounted = await open([revealed(C1, "phone", PHONE), ...extra]);
    await reveal(mounted, ROW_1, "phone");
    expect(shown(mounted)).toContain(PHONE);
    return mounted;
  };

  it("takes the value off the page while the list is read again, and keeps it off when that read fails", async () => {
    const held = pending();
    const mounted = await withValue([held.answer]);
    await click(mounted.root, "Atualizar a lista");
    expect(shown(mounted)).not.toContain(PHONE);

    held.release(new Response("{}", { status: 500 }));
    await flush();
    expect(shown(mounted)).not.toContain(PHONE);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the value off a page whose list read fails on the network", async () => {
    const mounted = await withValue([new Error("offline")]);
    await click(mounted.root, "Atualizar a lista");

    expect(shown(mounted)).not.toContain(PHONE);
    expect(
      allElements(mounted.root).filter((element) =>
        element.textContent.includes(PHONE)
      )
    ).toEqual([]);
  });

  it("does not put a value on the page when the answer comes with the tab hidden", async () => {
    const held = pending();
    const mounted = await open([held.answer]);
    await click(mounted.root, OPEN_MENU, 0);
    await click(mounted.root, "Telefone");
    await click(mounted.root, "Revelar o telefone deste cliente");
    mounted.document.hidden = true;
    mounted.document.dispatch("visibilitychange");
    held.release(revealed(C1, "phone", PHONE));
    await flush();

    expect(shown(mounted)).not.toContain(PHONE);
    expect(vi.getTimerCount()).toBe(0);
    expect(revealListeners(mounted)).toBe(0);
  });

  it("shows a Windows line break as one", async () => {
    const mounted = await open([revealed(C1, "notes", "um\r\ndois")]);
    await reveal(mounted, ROW_1, "notes");

    expect(shown(mounted)).toContain("um\ndois");
    expect(shown(mounted)).not.toContain("�");
  });
});
