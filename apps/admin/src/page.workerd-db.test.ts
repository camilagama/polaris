import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { mountAdmin, type ScreenContext } from "../ui/app";
import {
  allElements,
  buttons,
  byId,
  byTag,
  FakeDocument,
  type FakeElement,
  visibleText,
} from "../ui/test-dom";
import { signAccessToken } from "./workerd-access";

/**
 * The operator's page driven as a person drives it (corte admin-tela-v1, AC-7 to AC-10 and AC-17): the page's own
 * script, in the small DOM of its tests, calls the real Admin Worker inside workerd, with Cloudflare Access simulated
 * and the PostgreSQL of the `admin-worker` gate behind it (stores and principals made by the gate). Only the browser
 * is missing: its policy, layout and focus are the unit tests' and the captures' (the page and its CSP are served by
 * this same Worker in worker.workerd-db.test.ts). The gate then reads the database: one audited read of the refund
 * window, under the store's own case, and one funnel event per answered read.
 *
 * This file has a tsconfig of its own (tsconfig.page-e2e.json): the page is browser code, the Worker's is not.
 */

interface Fixture {
  principals: { ownerSubject: string };
  screen: Record<"free" | "hostile" | "trial", { id: string; name: string }> & {
    firstChargeAt: string;
  };
}

const fixture = JSON.parse(env.TEST_FIXTURE ?? "{}") as Fixture;
const ORIGIN = "https://admin.test";
/** The Admin's own limit (ACTIVATION_FUNNEL_READS_PER_HOUR); the gate counts the events of these reads. */
const FUNNEL_READS_PER_HOUR = 30;
const WAIT = { interval: 50, timeout: 30_000 };
const CASES_COUNT = /\d+ casos?\./;
const LAST_MINUTE_OF_A_DAY = /^\d{2}\/\d{2}\/\d{4} 23:59$/;
const LIMIT_SENTENCE =
  /Limite de leituras do funil por hora atingido\. Tente de novo em \d+ minutos?\./;

interface PageCall {
  method: string;
  path: string;
  status: number;
}

/** A request as the operator's browser makes it: the Access token, and on a write the page's own origin. */
async function asBrowser(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set(
    "cf-access-jwt-assertion",
    await signAccessToken({ subject: fixture.principals.ownerSubject })
  );
  const method = init.method ?? "GET";
  if (method !== "GET") {
    headers.set("origin", ORIGIN);
    headers.set("sec-fetch-site", "same-origin");
  }
  // `cache` and `credentials` are the browser's; workerd's fetch takes neither, and the unit tests check them
  return await exports.default.fetch(`${ORIGIN}${path}`, {
    ...(init.body === undefined ? {} : { body: init.body }),
    headers,
    method,
    ...(init.redirect === undefined ? {} : { redirect: init.redirect }),
  });
}

/** One screen of the page, as the Worker names it on the root (`data-tela`, `data-id`, `data-loja`). */
async function openPage(screen: Partial<ScreenContext> & { screen: string }) {
  const document = new FakeDocument();
  const root = document.createElement("div");
  document.body.append(root);
  const calls: PageCall[] = [];
  const navigations: string[] = [];
  await mountAdmin(
    root as unknown as HTMLElement,
    async (path, init) => {
      const response = await asBrowser(path, init);
      calls.push({
        method: init.method ?? "GET",
        path,
        status: response.status,
      });
      return response;
    },
    () => new Date(fixture.screen.firstChargeAt),
    {
      environment: "unknown",
      id: null,
      listState: "abertos",
      store: null,
      ...screen,
    },
    (path) => {
      navigations.push(path);
    }
  );
  const text = () => visibleText(root);
  const shows = (sentence: string | RegExp) =>
    vi.waitFor(() => expect(text()).toMatch(sentence), WAIT);
  const section = (titleId: string) =>
    allElements(root).find(
      (element) => element.getAttribute("aria-labelledby") === titleId
    ) as FakeElement;
  return { calls, navigations, root, section, shows, text };
}

const funnelCalls = (calls: PageCall[]) =>
  calls.filter((call) => call.path.startsWith("/api/funnel"));
const windowCalls = (calls: PageCall[]) =>
  calls.filter((call) => call.path.endsWith("/refund-window"));

/** The facts of a section, as the page wrote them. */
function factsOf(section: FakeElement): Record<string, string> {
  return Object.fromEntries(
    byTag(section, "dt").map((term) => [
      term.textContent,
      term.parent?.children[1]?.textContent ?? "",
    ])
  );
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("the operator's page against the Worker and PostgreSQL (AC-17)", () => {
  it("reads the funnel once when the area opens, and not again for the weeks or for opening it again (AC-7, AC-8)", async () => {
    const page = await openPage({ screen: "funil" });
    expect(page.calls.map((call) => call.path)).toEqual(["/api/whoami"]);
    buttons(page.root, "Abrir o funil")[0]?.click();
    await page.shows("Funil de 12 semanas, atualizado em");
    const weeks = byId(page.root, "funil-semanas");
    weeks.value = "4";
    weeks.dispatch("change");
    buttons(page.root, "Fechar o funil")[0]?.click();
    buttons(page.root, "Abrir o funil")[0]?.click();
    const funnel = page.section("funil-titulo");
    // one row per week in each table, and the few stores of the gate are under k: "não disponível", never 0
    const signupRows = byTag(byTag(funnel, "tbody")[0] as FakeElement, "tr");
    expect(signupRows).toHaveLength(12);
    expect(page.text()).toContain("não disponível (");
    expect(page.text()).toContain(
      'Grupos com menos de 5 lojas aparecem como "não disponível", nunca como 0.'
    );

    // the rest of the hour, straight to the route: the page's read was the first of its 30
    let answered = 1;
    for (let read = 0; read < FUNNEL_READS_PER_HOUR; read += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: Each read is counted in order, up to the limit.
      const response = await asBrowser("/api/funnel?weeks=4");
      if (response.status !== 200) {
        expect(response.status).toBe(429);
        break;
      }
      answered += 1;
    }
    expect(answered).toBe(FUNNEL_READS_PER_HOUR);
    // by now a read the weeks or the reopening had started would have come back and be counted: there is none
    expect(funnelCalls(page.calls)).toEqual([
      { method: "GET", path: "/api/funnel?weeks=12", status: 200 },
    ]);
    // the next click is refused with the wait in minutes, and the page does not ask again by itself (AC-7)
    buttons(page.root, "Atualizar")[0]?.click();
    await page.shows(LIMIT_SENTENCE);
    expect(funnelCalls(page.calls).map((call) => call.status)).toEqual([
      200, 429,
    ]);
  });

  it("opens a case of the store, reads its refund window once and is refused once the case is closed (AC-9, AC-10)", async () => {
    const { hostile, trial } = fixture.screen;
    const page = await openPage({ screen: "lojas" });
    byId(page.root, "busca").value = hostile.id;
    buttons(page.root, "Buscar")[0]?.click();
    await page.shows("1 loja encontrada.");
    buttons(page.root, "Ver loja")[0]?.click();
    await page.shows("Lida em");
    const refund = page.section("reembolso-titulo");
    expect(visibleText(refund)).toContain(
      "Esta tela só mostra a janela. Ela não devolve dinheiro."
    );

    // no open case yet: the page offers no read, so the route is never called
    buttons(refund, "Ver casos abertos desta loja")[0]?.click();
    await page.shows("Nenhum caso aberto desta loja.");
    expect(buttons(refund, "Consultar janela")).toEqual([]);
    expect(windowCalls(page.calls)).toEqual([]);

    // a case of another store does not open this store's window: the server refuses it, and audits nothing
    const other = await json(
      await asBrowser("/api/support-cases", {
        body: JSON.stringify({
          kind: "support",
          organizationId: trial.id,
          reason: "Caso de outra loja",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    );
    const crossed = await asBrowser(
      `/api/support-cases/${String(other.id)}/refund-window`,
      {
        body: JSON.stringify({ organizationId: hostile.id }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }
    );
    expect(crossed.status).toBe(403);
    expect(await json(crossed)).toEqual({
      error: "refund_window_read_refused",
    });

    // the page opens the case with the reason in the JSON body, then reads the window on one click
    byId(refund, "motivo").value = "Dono pediu reembolso por e-mail";
    buttons(refund, "Abrir caso")[0]?.click();
    await page.shows("Caso aberto.");
    const opened = page.calls.at(-1);
    expect(opened).toEqual({
      method: "POST",
      path: "/api/support-cases",
      status: 201,
    });
    buttons(refund, "Consultar janela")[0]?.click();
    await page.shows("Janela lida. A consulta ficou registrada na auditoria.");
    expect(windowCalls(page.calls)).toHaveLength(1);
    const facts = factsOf(refund);
    const charged = new Date(fixture.screen.firstChargeAt);
    const brasilia = new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      timeZone: "America/Sao_Paulo",
      year: "numeric",
    });
    expect(facts["Janela de arrependimento"]).toBe("Dentro do prazo");
    expect(facts["Primeira cobrança"]).toContain(brasilia.format(charged));
    expect(facts["Valor da primeira cobrança"]).toBe("R$ 49,90");
    expect(facts.Assinatura).toBe("Pro ativo");
    expect(facts["Prazo até"]).toMatch(LAST_MINUTE_OF_A_DAY);

    // the read is in the case's audit, under this store
    const cases = await json(
      await asBrowser(
        `/api/support-cases?${new URLSearchParams({ organizationId: hostile.id, status: "open" })}`
      )
    );
    const [mine] = cases.cases as { id: string }[];
    const detail = await json(
      await asBrowser(`/api/support-cases/${String(mine?.id)}`)
    );
    expect(
      (detail.audit as { eventType: string }[]).map((entry) => entry.eventType)
    ).toEqual(
      expect.arrayContaining([
        "support_case.opened",
        "billing.refund_window_read",
      ])
    );

    // once the case is closed, the same click is refused, and the page says so without saying why
    const closed = await asBrowser(
      `/api/support-cases/${String(mine?.id)}/close`,
      {
        body: JSON.stringify({ resolution: "Respondido por e-mail" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }
    );
    expect(closed.status).toBe(200);
    buttons(refund, "Consultar janela")[0]?.click();
    await page.shows(
      "Consulta recusada: confira se o caso está aberto e é desta loja."
    );
    expect(windowCalls(page.calls).map((call) => call.status)).toEqual([
      200, 403,
    ]);
  });
  it("opens a case from the store, closes it on its screen, and a stale screen is told it was already closed (AC-P1.5, AC-P1.6)", async () => {
    const { free } = fixture.screen;
    const opening = await openPage({ screen: "caso-novo", store: free.id });
    await opening.shows("Loja: ");
    await vi.waitFor(() => expect(opening.text()).toContain(free.id), WAIT);
    byId(opening.root, "motivo").value = "Dono não consegue entrar";
    buttons(opening.root, "Abrir caso")[0]?.click();
    await vi.waitFor(() => expect(opening.navigations).toHaveLength(1), WAIT);
    expect(opening.calls.filter((call) => call.method === "POST")).toEqual([
      { method: "POST", path: "/api/support-cases", status: 201 },
    ]);
    const [path] = opening.navigations;
    const caseId = String(path).replace("/casos/", "");
    expect(path).toBe(`/casos/${caseId}`);

    // two screens of the same open case: the first closes it, the second still shows it open
    const first = await openPage({ id: caseId, screen: "caso" });
    const second = await openPage({ id: caseId, screen: "caso" });
    await first.shows("Caso em uso");
    await second.shows("Caso em uso");
    const close = (page: Awaited<ReturnType<typeof openPage>>) => {
      buttons(page.root, "Fechar caso")[0]?.click();
      byId(page.root, "resolucao").value = "Senha trocada pelo dono";
      buttons(page.root, "Revisar o fechamento")[0]?.click();
      expect(page.text()).toContain("Não: isso não poderá ser desfeito.");
      buttons(page.root, "Confirmar o fechamento do caso")[0]?.click();
    };
    close(first);
    await first.shows(
      "Caso fechado. Os acessos temporários dele foram revogados."
    );
    expect(buttons(first.root, "Fechar caso")).toEqual([]);
    expect(first.text()).toContain("Para agir de novo, abra outro caso.");
    expect(first.text()).toContain("Senha trocada pelo dono");
    close(second);
    await second.shows("Este caso já estava fechado.");
    expect(
      [...first.calls, ...second.calls].filter((call) => call.method === "POST")
    ).toEqual([
      {
        method: "POST",
        path: `/api/support-cases/${caseId}/close`,
        status: 200,
      },
      {
        method: "POST",
        path: `/api/support-cases/${caseId}/close`,
        status: 200,
      },
    ]);

    // the database has one close, by this operator, and the case among the closed ones of the store
    const detail = await json(await asBrowser(`/api/support-cases/${caseId}`));
    expect(
      (detail.audit as { eventType: string }[]).filter(
        (entry) => entry.eventType === "support_case.closed"
      )
    ).toHaveLength(1);
    const list = await openPage({ listState: "fechados", screen: "casos" });
    await list.shows(CASES_COUNT);
    byId(list.root, "casos-loja").value = free.id;
    buttons(list.root, "Filtrar")[0]?.click();
    await vi.waitFor(
      () =>
        expect(
          byTag(list.root, "a").map((link) => link.getAttribute("href"))
        ).toContain(`/casos/${caseId}`),
      WAIT
    );
  });
  it("opens a privacy case and takes it through its steps one at a time; a stale screen is refused in words (Parte 11: AC-P11.1 to AC-P11.4)", async () => {
    const { free } = fixture.screen;
    const opening = await openPage({
      screen: "privacidade-novo",
      store: free.id,
    });
    await vi.waitFor(() => expect(opening.text()).toContain(free.id), WAIT);
    byId(opening.root, "privacidade-motivo").value = "Pedido de exclusão";
    byId(opening.root, "privacidade-canal").value = "email";
    byId(opening.root, "privacidade-tipo").value = "deletion";
    byId(opening.root, "privacidade-quem").value = "data_subject";
    buttons(opening.root, "Abrir caso de privacidade")[0]?.click();
    await vi.waitFor(() => expect(opening.navigations).toHaveLength(1), WAIT);
    const [path] = opening.navigations;
    const caseId = String(path).replace("/privacidade/", "");
    expect(path).toBe(`/privacidade/${caseId}`);

    const page = await openPage({ id: caseId, screen: "privacidade-caso" });
    const stale = await openPage({ id: caseId, screen: "privacidade-caso" });
    await page.shows("Revisar identidade");
    await stale.shows("Revisar identidade");
    const record = (
      on: Awaited<ReturnType<typeof openPage>>,
      review: string,
      confirm: string,
      fill: () => void
    ) => {
      fill();
      buttons(on.root, review)[0]?.click();
      expect(on.text()).toContain("Não: cada etapa vale uma vez.");
      const [button] = buttons(on.root, confirm);
      button?.click();
      button?.click();
    };
    const identity = (on: Awaited<ReturnType<typeof openPage>>) => () => {
      byId(on.root, "etapa-identity-status").value = "failed";
      byId(on.root, "etapa-identity-metodo").value = "email_ownership";
    };
    record(page, "Revisar identidade", "Registrar identidade", identity(page));
    await page.shows("Etapa “Identidade” registrada.");
    record(
      stale,
      "Revisar identidade",
      "Registrar identidade",
      identity(stale)
    );
    await stale.shows(
      "Esta etapa já foi registrada ou ainda não é a vez dela. Nada foi refeito."
    );
    await stale.shows("Revisar papel do polaris");

    record(
      page,
      "Revisar papel do polaris",
      "Registrar papel do polaris",
      () => {
        byId(page.root, "etapa-role-papel").value = "controller";
      }
    );
    await page.shows("Etapa “Papel do Polaris” registrada.");
    record(page, "Revisar escopo", "Registrar escopo", () => {
      byId(page.root, "etapa-scope-account").checked = true;
    });
    await page.shows("Etapa “Escopo” registrada.");
    // with the identity not confirmed the server refuses an acceptance: said in words, nothing recorded
    record(page, "Revisar decisão", "Registrar decisão", () => {
      byId(page.root, "etapa-decision-decisao").value = "accept";
    });
    await page.shows("O caso não permite esta escolha.");
    expect(page.text()).not.toContain("privacy_decision_not_allowed");
    record(page, "Revisar decisão", "Registrar decisão", () => {
      byId(page.root, "etapa-decision-decisao").value = "reject";
      byId(page.root, "etapa-decision-motivo").value = "identity_not_verified";
    });
    await page.shows("Etapa “Decisão” registrada.");
    expect(page.text()).toContain(
      "Sem ação: uma recusa não tem o que registrar."
    );
    record(page, "Revisar resolução", "Registrar resolução", () => {
      byId(page.root, "etapa-resolve-texto").value = "Recusado sem identidade";
    });
    await page.shows("Etapa “Resolução” registrada.");
    expect(page.text()).toContain("Caso resolvido em");

    const posts = [...page.calls, ...stale.calls].filter(
      (call) => call.method === "POST"
    );
    expect(posts).toEqual([
      {
        method: "POST",
        path: `/api/privacy-cases/${caseId}/identity`,
        status: 200,
      },
      {
        method: "POST",
        path: `/api/privacy-cases/${caseId}/role`,
        status: 200,
      },
      {
        method: "POST",
        path: `/api/privacy-cases/${caseId}/scope`,
        status: 200,
      },
      {
        method: "POST",
        path: `/api/privacy-cases/${caseId}/decision`,
        status: 400,
      },
      {
        method: "POST",
        path: `/api/privacy-cases/${caseId}/decision`,
        status: 200,
      },
      {
        method: "POST",
        path: `/api/privacy-cases/${caseId}/resolve`,
        status: 200,
      },
      {
        method: "POST",
        path: `/api/privacy-cases/${caseId}/identity`,
        status: 409,
      },
    ]);
    const detail = await json(await asBrowser(`/api/privacy-cases/${caseId}`));
    expect((detail.privacy as { stage: string }).stage).toBe("resolved");
    expect((detail.case as { status: string }).status).toBe("closed");
  });
});
