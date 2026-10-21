/// <reference lib="dom" />
import type { Locator, Page, Request } from "@playwright/test";
import { expect, test } from "@playwright/test";

const GOOGLE_URL =
  "https://accounts.google.com/o/oauth2/v2/auth?client_id=teste";
const CSP_VIOLATION = /Content Security Policy/i;
const NOOPENER = /noopener/;
const BUTTON = "Continuar com o Google";
const TECHNICAL =
  /\b(40[13]|429|50[03])\b|auth_|rate_limited|UNAUTHORIZED|Unauthorized/;
const SECRET_IN_CONSOLE = /cookie|token|session[-_ ]?id|set-cookie|code=/i;
const ORGANIZATION_CALLS = /\/rpc\/organization\//;

interface Server {
  methods: { emailPassword: boolean; google: boolean } | "down";
  rpcCalls: string[];
  /** What get-session says: a session, or none. */
  session: boolean;
  sessionDelayMs: number;
  /** The answer to the start of the Google sign-in. */
  start: "abort" | "garbage" | "limit" | "ok" | "unavailable";
  startBodies: Record<string, unknown>[];
  /** Holds the answer of the start until released. */
  startGate: Promise<void> | null;
}

const newServer = (overrides: Partial<Server> = {}): Server => ({
  methods: { emailPassword: false, google: true },
  rpcCalls: [],
  session: false,
  sessionDelayMs: 0,
  start: "ok",
  startBodies: [],
  startGate: null,
  ...overrides,
});

const json = (body: unknown, status = 200) => ({
  body: JSON.stringify(body),
  contentType: "application/json",
  status,
});

/** Plays the part of the server for the sign-in screen, and of Google for the page it navigates to. */
async function serve(page: Page, server: Server) {
  await page.route("**/api/auth/get-session", async (route) => {
    if (server.sessionDelayMs > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, server.sessionDelayMs)
      );
    }
    await route.fulfill(
      json(server.session ? { session: { id: "s" }, user: { id: "u" } } : null)
    );
  });
  await page.route("**/api/auth-methods", async (route) => {
    if (server.methods === "down") {
      await route.abort("internetdisconnected");
      return;
    }
    await route.fulfill(json({ ...server.methods, turnstileSiteKey: null }));
  });
  await page.route("**/api/auth/sign-in/social", async (route) => {
    server.startBodies.push(route.request().postDataJSON());
    await server.startGate;
    switch (server.start) {
      case "abort":
        await route.abort("internetdisconnected");
        return;
      case "garbage":
        await route.fulfill({ body: "<html>", contentType: "text/html" });
        return;
      case "limit":
        await route.fulfill(
          json({ error: { code: "auth_rate_limited" } }, 429)
        );
        return;
      case "unavailable":
        await route.fulfill(
          json({ error: { code: "auth_rate_limit_unavailable" } }, 503)
        );
        return;
      default:
        await route.fulfill(json({ redirect: true, url: GOOGLE_URL }));
    }
  });
  await page.route("**/rpc/**", async (route) => {
    server.rpcCalls.push(route.request().url());
    await route.abort("internetdisconnected");
  });
  await page.route("https://accounts.google.com/**", (route) =>
    route.fulfill({ body: "<title>Google</title>", contentType: "text/html" })
  );
}

function watchConsole(page: Page) {
  const lines: string[] = [];
  page.on("console", (message) => lines.push(message.text()));
  page.on("pageerror", (error) => lines.push(error.message));
  return lines;
}

const alertBox = (page: Page) => page.getByRole("alert");

/** The height a finger can hit: the box, grown by the `touch-hit` pseudo-element on a touch screen. */
const touchHeight = (control: Locator) =>
  control.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = getComputedStyle(element, "::before");
    const grow =
      hit.content === '""' && hit.position === "absolute"
        ? -(Number.parseFloat(hit.top) || 0) -
          (Number.parseFloat(hit.bottom) || 0)
        : 0;
    return box.height + Math.max(0, grow);
  });
const googleButton = (page: Page) => page.getByRole("button", { name: BUTTON });

test.describe("a tela de entrada, com o servidor interceptado", () => {
  test("abre sem sessão, sem menu e sem organização, com título e botão do Google (AC-1, AC-8)", async ({
    page,
  }) => {
    const server = newServer();
    const printed = watchConsole(page);
    await serve(page, server);
    await page.goto("/entrar");

    await expect(page).toHaveTitle("Entrar · Polaris");
    await expect(
      page.getByRole("heading", { level: 1, name: "Entrar no Polaris" })
    ).toBeVisible();
    await expect(googleButton(page)).toBeEnabled();
    await expect(page.getByRole("navigation")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Menu" })).toHaveCount(0);
    // the only way in is Google: no field at all (nothing to type, no PIN, no code)
    await expect(page.locator("input, textarea, select")).toHaveCount(0);
    expect(
      server.rpcCalls.filter((url) => ORGANIZATION_CALLS.test(url))
    ).toEqual([]);
    expect(printed.filter((line) => SECRET_IN_CONSOLE.test(line))).toEqual([]);
  });

  test("o G é imagem embutida: nenhuma requisição de imagem, fonte ou script externos e nenhuma violação de CSP (AC-7)", async ({
    page,
  }) => {
    const server = newServer();
    const printed = watchConsole(page);
    const external: string[] = [];
    page.on("request", (request) => {
      const { hostname } = new URL(request.url());
      if (hostname !== "127.0.0.1" && hostname !== "localhost") {
        external.push(request.url());
      }
    });
    await serve(page, server);
    await page.goto("/entrar");
    await expect(googleButton(page)).toBeVisible();
    await expect(googleButton(page).locator("svg")).toHaveCount(1);
    await expect(googleButton(page).locator("img")).toHaveCount(0);
    expect(external).toEqual([]);
    expect(printed.filter((line) => CSP_VIOLATION.test(line))).toEqual([]);
  });

  test("os links dos Termos de Uso e da Política de Privacidade abrem em outra aba, sem sessão (AC-1, AC-36)", async ({
    context,
    page,
  }) => {
    await serve(page, newServer());
    await page.goto("/entrar");
    for (const [name, path, heading] of [
      ["Termos de Uso", "/termos", "Termos de Uso"],
      ["Política de Privacidade", "/privacidade", "Política de Privacidade"],
    ] as const) {
      const link = page.getByRole("link", { name: new RegExp(name) });
      // biome-ignore lint/performance/noAwaitInLoops: one link after the other
      await expect(link).toHaveAttribute("href", path);
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(link).toHaveAttribute("rel", NOOPENER);
      const opened = context.waitForEvent("page");
      await link.click();
      const popup = await opened;
      await expect(
        popup.getByRole("heading", { level: 1, name: heading })
      ).toBeVisible();
      // the sign-in screen stays where it was
      expect(new URL(page.url()).pathname).toBe("/entrar");
      await popup.close();
    }
  });

  test("o clique chama o início com o provedor, o destino codificado e sem idToken, e navega para a URL devolvida (AC-2)", async ({
    page,
  }) => {
    const server = newServer();
    await serve(page, server);
    await page.goto("/entrar?voltar=%2Fsales%2Fhistory%3Fx%3D1");

    await googleButton(page).click();
    await page.waitForURL(GOOGLE_URL);

    expect(server.startBodies).toEqual([
      {
        callbackURL: "/entrar?voltar=%2Fsales%2Fhistory%3Fx%3D1",
        errorCallbackURL: "/entrar?erro=google",
        provider: "google",
      },
    ]);
    expect(JSON.stringify(server.startBodies)).not.toContain("idToken");
  });

  test("sem voltar, o destino é a própria tela de entrada (AC-2)", async ({
    page,
  }) => {
    const server = newServer();
    await serve(page, server);
    await page.goto("/entrar");
    await googleButton(page).click();
    await page.waitForURL(GOOGLE_URL);
    expect(server.startBodies[0]).toMatchObject({ callbackURL: "/entrar" });
  });

  test("dois cliques rápidos fazem uma chamada só e o botão fica pendente (AC-3)", async ({
    page,
  }) => {
    let release: () => void = () => undefined;
    const server = newServer({
      startGate: new Promise<void>((resolve) => {
        release = resolve;
      }),
    });
    await serve(page, server);
    await page.goto("/entrar");

    await googleButton(page).dblclick();
    const pending = page.getByRole("button", { name: "Abrindo o Google…" });
    await expect(pending).toHaveAttribute("aria-busy", "true");
    await expect(pending).toBeDisabled();
    expect(server.startBodies).toHaveLength(1);

    release();
    await page.waitForURL(GOOGLE_URL);
    expect(server.startBodies).toHaveLength(1);
  });

  for (const hostile of [
    "//outro.com",
    "/%5Coutro.com",
    "https://outro.com",
    "javascript:alert(1)",
    "%2F%2Foutro.com",
    "/entrar",
    `/${"a".repeat(300)}`,
  ]) {
    test(`um voltar hostil (${hostile.slice(0, 24)}) vira o início: nada vai ao servidor e quem já está dentro termina em / (AC-14)`, async ({
      page,
    }) => {
      const server = newServer();
      await serve(page, server);
      await page.goto(`/entrar?voltar=${encodeURIComponent(hostile)}`);
      await googleButton(page).click();
      await page.waitForURL(GOOGLE_URL);
      expect(server.startBodies[0]).toMatchObject({ callbackURL: "/entrar" });

      // and coming back from Google with that same address, the person lands on the start
      server.session = true;
      await page.goto(`/entrar?voltar=${encodeURIComponent(hostile)}`);
      await page.waitForURL((url) => url.pathname === "/");
      expect(new URL(page.url()).hostname).toBe("127.0.0.1");
    });
  }

  test("quem já está dentro vai direto ao destino sem ver o botão (AC-6)", async ({
    page,
  }) => {
    const server = newServer({ session: true, sessionDelayMs: 150 });
    await serve(page, server);
    // the destination screen needs the organizations: it does not matter here, only that it is reached
    await page.goto("/entrar?voltar=%2Fsales%2Fhistory");
    await expect(googleButton(page)).toHaveCount(0);
    await page.waitForURL("**/sales/history");
    await expect(googleButton(page)).toHaveCount(0);
  });

  test("com motivo=sessao e uma sessão que o servidor ainda aceita no lookup, a tela fica e oferece o botão: nunca um laço entre o app e /entrar", async ({
    page,
  }) => {
    const server = newServer({ session: true });
    await serve(page, server);
    await page.goto("/entrar?motivo=sessao&voltar=%2Fsales");
    await expect(googleButton(page)).toBeEnabled();
    expect(new URL(page.url()).pathname).toBe("/entrar");
    await page.waitForTimeout(800);
    expect(new URL(page.url()).pathname).toBe("/entrar");
  });

  test("a volta do Google mostra 'Entrando…' até o redirecionamento, sem o botão voltar a piscar (AC-4)", async ({
    page,
  }) => {
    const server = newServer({ session: true, sessionDelayMs: 150 });
    await serve(page, server);
    // what the status line and the button showed, kept outside the page: it survives the navigation
    const statuses: string[] = [];
    let buttonShown = false;
    await page.exposeFunction(
      "recordScreen",
      (status: string, button: boolean) => {
        statuses.push(status);
        buttonShown = buttonShown || button;
      }
    );
    await page.addInitScript(() => {
      const report = () => {
        const status = [...document.querySelectorAll("main p[role=status]")]
          .map((line) => line.textContent ?? "")
          .join("");
        const button = [...document.querySelectorAll("main button")].some(
          (element) => element.textContent?.includes("Continuar com o Google")
        );
        (
          window as unknown as {
            recordScreen: (status: string, button: boolean) => void;
          }
        ).recordScreen(status, button);
      };
      new MutationObserver(report).observe(document, {
        childList: true,
        subtree: true,
      });
    });
    await page.goto("/entrar?voltar=%2Fsales%2Fhistory");
    await page.waitForURL("**/sales/history");

    expect(statuses).toContain("Entrando…");
    expect(buttonShown).toBe(false);
  });

  const failures: [string, string, string][] = [
    [
      "cancelou, recusou, fora da lista, callback inválido: o servidor volta com erro=google",
      "?erro=google",
      "Não foi possível entrar com o Google. Tente de novo.",
    ],
    [
      "o limite no retorno do Google",
      "?erro=limite",
      "Muitas tentativas em pouco tempo. Espere alguns minutos e tente de novo.",
    ],
    [
      "a indisponibilidade no retorno do Google",
      "?erro=indisponivel",
      "Não conseguimos entrar agora. Tente de novo em instantes.",
    ],
  ];
  for (const [name, search, text] of failures) {
    test(`${name} (AC-5, AC-12, AC-13)`, async ({ page }) => {
      const server = newServer();
      await serve(page, server);
      await page.goto(`/entrar${search}`);
      await expect(alertBox(page)).toContainText(text);
      await expect(alertBox(page)).toBeFocused();
      await expect(googleButton(page)).toBeEnabled();
      await expect(page.locator("body")).not.toContainText(TECHNICAL);
    });
  }

  test("o erro do Google leva a linha de ajuda de quem cancelou", async ({
    page,
  }) => {
    await serve(page, newServer());
    await page.goto("/entrar?erro=google");
    await expect(alertBox(page)).toContainText(
      "Se você cancelou no Google, toque em Continuar com o Google para tentar outra vez."
    );
  });

  test("qualquer motivo de falha do Google mostra o mesmo texto (AC-5)", async ({
    page,
  }) => {
    await serve(page, newServer());
    const texts = new Set<string>();
    for (const cause of [
      "access_denied",
      "unable_to_link_account",
      "invalid_code",
    ]) {
      // the server maps every cause to the same `erro=google`: the page never sees the cause
      // biome-ignore lint/performance/noAwaitInLoops: one address after the other
      await page.goto(`/entrar?erro=google&causa=${cause}`);
      texts.add((await alertBox(page).innerText()).trim());
    }
    expect(texts.size).toBe(1);
  });

  test("valores desconhecidos de motivo e erro mostram a tela padrão e não são refletidos (AC-15)", async ({
    page,
  }) => {
    await serve(page, newServer());
    await page.goto("/entrar?motivo=%3Cb%3Eadmin%3C%2Fb%3E&erro=hacked");
    await expect(alertBox(page)).toHaveCount(0);
    await expect(googleButton(page)).toBeEnabled();
    await expect(page.locator("body")).not.toContainText("admin");
    await expect(page.locator("body")).not.toContainText("hacked");
  });

  test("429 no início: texto de espera, botão ativo, nada tenta de novo (AC-12)", async ({
    page,
  }) => {
    const server = newServer({ start: "limit" });
    await serve(page, server);
    await page.goto("/entrar");
    await googleButton(page).click();
    await expect(alertBox(page)).toContainText(
      "Muitas tentativas em pouco tempo. Espere alguns minutos e tente de novo."
    );
    await expect(alertBox(page)).toBeFocused();
    await expect(googleButton(page)).toBeEnabled();
    await page.waitForTimeout(1500);
    expect(server.startBodies).toHaveLength(1);
    await expect(page.locator("body")).not.toContainText(TECHNICAL);
  });

  for (const start of ["unavailable", "abort", "garbage"] as const) {
    test(`início com ${start}: texto de tentar em instantes, sem código nem corpo (AC-12)`, async ({
      page,
    }) => {
      const server = newServer({ start });
      await serve(page, server);
      await page.goto("/entrar");
      await googleButton(page).click();
      await expect(alertBox(page)).toContainText(
        "Não conseguimos entrar agora. Tente de novo em instantes."
      );
      await expect(googleButton(page)).toBeEnabled();
      await page.waitForTimeout(1000);
      expect(server.startBodies).toHaveLength(1);
      await expect(page.locator("body")).not.toContainText(TECHNICAL);
      await expect(page.locator("body")).not.toContainText("<html>");
    });
  }

  test("o motivo 'sessao' e o 'recente' põem a frase acima do botão (AC-16, AC-19)", async ({
    page,
  }) => {
    await serve(page, newServer());
    await page.goto("/entrar?motivo=sessao&voltar=%2Fdevices");
    await expect(
      page.getByText("Sua sessão acabou. Entre de novo.", { exact: true })
    ).toBeVisible();
    await page.goto("/entrar?motivo=recente&voltar=%2Fdevices");
    await expect(
      page.getByText("Por segurança, entre de novo para confirmar que é você.")
    ).toBeVisible();
    await googleButton(page).click();
    await page.waitForURL(GOOGLE_URL);
  });

  test("sem rede: aviso, botão desabilitado, nada vai à rede; com a rede de volta, habilita sem recarregar (AC-10)", async ({
    context,
    page,
  }) => {
    const server = newServer();
    await serve(page, server);
    await page.goto("/entrar");
    await expect(googleButton(page)).toBeEnabled();

    const calls: Request[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/")) {
        calls.push(request);
      }
    });
    await context.setOffline(true);
    await expect(
      page.getByText("Sem conexão. Conecte-se para entrar.")
    ).toBeVisible();
    await expect(googleButton(page)).toBeDisabled();
    expect(calls).toEqual([]);

    await context.setOffline(false);
    await expect(googleButton(page)).toBeEnabled();
    await expect(page.getByRole("status")).toHaveText(
      "Conexão de volta. Você já pode entrar."
    );
  });

  test("com o Google desligado no servidor o botão fica desabilitado e a tela diz por quê", async ({
    page,
  }) => {
    await serve(
      page,
      newServer({ methods: { emailPassword: false, google: false } })
    );
    await page.goto("/entrar");
    await expect(googleButton(page)).toBeDisabled();
    await expect(alertBox(page)).toContainText(
      "A entrada com o Google não está disponível agora."
    );
  });

  test("com o Google desligado há um 'Tentar de novo' que consulta de novo e, com o Google de volta, habilita o botão", async ({
    page,
  }) => {
    const server = newServer({
      methods: { emailPassword: false, google: false },
    });
    await serve(page, server);
    await page.goto("/entrar");
    await expect(googleButton(page)).toBeDisabled();

    server.methods = { emailPassword: false, google: true };
    await page.getByRole("button", { name: "Tentar de novo" }).click();
    await expect(googleButton(page)).toBeEnabled();
    await expect(alertBox(page)).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Tentar de novo" })
    ).toHaveCount(0);
  });

  test("com a consulta lenta o botão já está ativo e a tela diz que verifica (V1)", async ({
    page,
  }) => {
    await serve(page, newServer({ sessionDelayMs: 3000 }));
    await page.goto("/entrar");

    await expect(googleButton(page)).toBeEnabled();
    await expect(
      page.getByText("Verificando se você já entrou…")
    ).toBeVisible();
  });

  test("diz que a primeira vez é o mesmo botão e lista os dois textos legais com área de toque de 48 px (V4, V5)", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await serve(page, newServer());
    await page.goto("/entrar");

    await expect(
      page.getByText("Primeira vez? O botão também cria a conta.")
    ).toBeVisible();
    for (const name of ["Termos de Uso", "Política de Privacidade"]) {
      const link = page.getByRole("link", { name: new RegExp(name) });
      // biome-ignore lint/performance/noAwaitInLoops: one link after the other
      await expect(link).toBeVisible();
      expect(await touchHeight(link)).toBeGreaterThanOrEqual(48);
    }
    await expect(page.getByText("Leia antes de entrar")).toHaveCount(0);
  });

  test("sem resposta dos métodos, o botão do Google segue ativo", async ({
    page,
  }) => {
    await serve(page, newServer({ methods: "down" }));
    await page.goto("/entrar");
    await expect(googleButton(page)).toBeEnabled();
  });

  test("a tela não guarda nada no navegador e só leva voltar, motivo e erro na URL (AC-26)", async ({
    page,
  }) => {
    const server = newServer({ start: "limit" });
    const printed = watchConsole(page);
    await serve(page, server);
    await page.goto("/entrar?motivo=sessao&voltar=%2Fsales");
    await googleButton(page).click();
    await expect(alertBox(page)).toBeVisible();

    const stored = await page.evaluate(() => ({
      cookie: document.cookie,
      local: Object.keys(window.localStorage),
      session: Object.keys(window.sessionStorage),
    }));
    expect(stored).toEqual({ cookie: "", local: [], session: [] });
    const params = [...new URL(page.url()).searchParams.keys()];
    expect(
      params.every((key) => ["erro", "motivo", "voltar"].includes(key))
    ).toBe(true);
    expect(printed.filter((line) => SECRET_IN_CONSOLE.test(line))).toEqual([]);
  });

  test("a 360 px o botão tem área de toque de 48 px e nada rola para o lado (AC-29)", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 640, width: 360 });
    await serve(page, newServer());
    await page.goto("/entrar?erro=google&motivo=sessao");
    await expect(googleButton(page)).toBeVisible();
    expect(await touchHeight(googleButton(page))).toBeGreaterThanOrEqual(48);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("teclado: Tab chega ao botão com foco visível e Enter o aciona (AC-30)", async ({
    page,
  }) => {
    const server = newServer();
    await serve(page, server);
    await page.goto("/entrar");
    await expect(googleButton(page)).toBeEnabled();
    await page.keyboard.press("Tab");
    await expect(googleButton(page)).toBeFocused();
    const outline = await googleButton(page).evaluate(
      (element) => getComputedStyle(element).outlineWidth
    );
    expect(Number.parseFloat(outline)).toBeGreaterThanOrEqual(3);
    await page.keyboard.press("Enter");
    await page.waitForURL(GOOGLE_URL);
    expect(server.startBodies).toHaveLength(1);
  });

  test("o erro tem texto e ícone, não só cor (AC-31)", async ({ page }) => {
    await serve(page, newServer());
    await page.goto("/entrar?erro=limite");
    await expect(alertBox(page).locator("svg[aria-hidden='true']")).toHaveCount(
      1
    );
    await expect(alertBox(page)).toContainText("Muitas tentativas");
  });
});
