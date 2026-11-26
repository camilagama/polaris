// @vitest-environment happy-dom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NearLimitNotice, useNearLimitRead } from "./limit-help";
import type { NearLimitView } from "./limit-help-model";
import { planRead } from "../lib/plan-read";

const connection = { online: true };
const readPlan = vi.fn();

vi.mock("../lib/current-organization", () => ({
  useCurrentOrganization: () => ({
    billingSelfService: true,
    organization: { role: "owner" },
    organizationId: "org-a",
  }),
}));
vi.mock("../lib/browser-connection", () => ({
  useConnectionOnline: () => connection.online,
}));
vi.mock("../lib/orpc", () => ({
  orpcClient: {
    billing: { readPlan: (input: unknown) => readPlan(input) },
  },
}));

const planWith = (images: number) => ({
  limits: { goals: 1, images: 50, variants: 50 },
  state: "free",
  usage: { goals: 0, images, variants: 0 },
});

const near: NearLimitView = {
  freeableProducts: 0,
  kind: "near",
  proMax: null,
  usage: { max: 50, subject: "images", used: 47 },
};

interface ElementState {
  className?: string;
  inert?: boolean;
  tabIndex?: number;
}

function element({ className, inert, tabIndex }: ElementState): Element {
  const node = document.createElement("span");
  if (className !== undefined) {
    node.className = className;
  }
  if (inert) {
    node.setAttribute("inert", "");
  }
  if (tabIndex !== undefined) {
    node.setAttribute("tabindex", String(tabIndex));
  }
  return node;
}

function pathToAnchor(root: Element, boundary: Element): Element[] | null {
  const anchor = root.querySelector("a");
  if (anchor === null) {
    return null;
  }
  const path: Element[] = [];
  for (
    let node: Element | null = anchor;
    node !== null && node !== boundary;
    node = node.parentElement
  ) {
    path.unshift(node);
  }
  return path;
}

function leavesTabOrder(path: Element[]): boolean {
  let hidden = false;
  let inert = false;
  for (const node of path) {
    inert ||= node.hasAttribute("inert");
    if (node.classList.contains("visible")) {
      hidden = false;
    }
    if (node.classList.contains("invisible")) {
      hidden = true;
    }
  }
  return inert || hidden || path.at(-1)?.getAttribute("tabindex") === "-1";
}

function Screen({ version }: { version: number }) {
  const read = useNearLimitRead("images", version);
  return (
    <div data-settled={String(read.settled)} data-testid="screen">
      <NearLimitNotice holdSpace={!read.settled} view={read.view} />
    </div>
  );
}

function mountScreen() {
  const view = render(<Screen version={0} />);
  const screenEl = () => view.getByTestId("screen");
  return {
    notice: () => screenEl().firstElementChild,
    rerender: (version = 0) => view.rerender(<Screen version={version} />),
    settled: () => screenEl().getAttribute("data-settled") === "true",
  };
}

const flush = () =>
  act(async () => {
    for (let tick = 0; tick < 6; tick += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each microtask turn must finish before the next
      await Promise.resolve();
    }
  });

async function settle(screen: ReturnType<typeof mountScreen>, version = 0) {
  screen.rerender(version);
  await flush();
}

beforeEach(() => {
  connection.online = true;
  readPlan.mockReset();
  planRead.clear();
});

afterEach(cleanup);

describe("NearLimitNotice com holdSpace", () => {
  const renderNotice = (
    view: NearLimitView | null,
    holdSpace: boolean,
    hidden = false
  ) => {
    const mounted = render(
      <NearLimitNotice hidden={hidden} holdSpace={holdSpace} view={near} />
    );
    mounted.rerender(
      <NearLimitNotice hidden={hidden} holdSpace={holdSpace} view={view} />
    );
    return {
      notice: mounted.container.firstElementChild,
      root: mounted.container,
    };
  };

  it("com o vão, a linha que já apareceu fica invisível, fora da leitura e sem data-near-limit", () => {
    const { notice: held } = renderNotice(null, true);
    expect(held).not.toBeNull();
    expect(held?.getAttribute("aria-hidden")).toBe("true");
    expect(held?.className).toContain("invisible");
    expect(held?.getAttribute("data-near-limit")).toBeNull();
  });

  it("o link do parágrafo retido fica fora da ordem de Tab: o parágrafo leva invisible e nada dentro dele o reabre", () => {
    const { notice: held, root } = renderNotice(null, true);
    expect(held?.className.split(" ")).toContain("invisible");
    const path = held && pathToAnchor(held, root);
    expect(path?.at(-1)?.hasAttribute("href")).toBe(true);
    expect(path && leavesTabOrder(path)).toBe(true);
  });

  it("controle: o caminho que reabre o link com visible, ou o prende por inert ou tabIndex, é lido como esperado", () => {
    const hiddenBox = element({ className: "invisible" });
    expect(leavesTabOrder([hiddenBox, element({})])).toBe(true);
    expect(leavesTabOrder([hiddenBox, element({ className: "visible" })])).toBe(
      false
    );
    expect(leavesTabOrder([element({ inert: true }), element({})])).toBe(true);
    expect(leavesTabOrder([element({}), element({ tabIndex: -1 })])).toBe(true);
    expect(leavesTabOrder([element({ tabIndex: -1 }), element({})])).toBe(
      false
    );
  });

  it("o link da linha à mostra continua na ordem de Tab", () => {
    const { notice, root } = renderNotice(near, true);
    const path = notice && pathToAnchor(notice, root);
    expect(path?.at(-1)?.hasAttribute("href")).toBe(true);
    expect(path && leavesTabOrder(path)).toBe(false);
  });

  it("sem o vão, nada é renderizado", () => {
    expect(renderNotice(null, false).notice).toBeNull();
  });

  it("com o vão, mas com a recusa na tela (hidden), nada é renderizado", () => {
    expect(renderNotice(null, true, true).notice).toBeNull();
  });

  it("a linha à mostra não leva aria-hidden nem invisible, e ganha data-near-limit", () => {
    const { notice: visible } = renderNotice(near, true);
    expect(visible?.getAttribute("aria-hidden")).toBeNull();
    expect(visible?.className).not.toContain("invisible");
    expect(visible?.getAttribute("data-near-limit")).toBe("near");
  });
});

describe("a linha que sai por leitura não volta como vão", () => {
  it("de 45 a 44: a leitura tira a linha e, depois, a conexão que cai não devolve o número velho", async () => {
    readPlan.mockResolvedValue(planWith(45));
    const screen = mountScreen();
    await settle(screen);
    expect(screen.notice()?.getAttribute("data-near-limit")).toBe("near");

    readPlan.mockResolvedValue(planWith(44));
    await settle(screen, 1);
    expect(screen.settled()).toBe(true);
    expect(screen.notice()).toBeNull();

    connection.online = false;
    screen.rerender(1);
    expect(screen.settled()).toBe(false);
    expect(screen.notice()).toBeNull();
  });

  it("a linha que sai pela conexão deixa o vão, e só até a leitura responder", async () => {
    readPlan.mockResolvedValue(planWith(47));
    const screen = mountScreen();
    await settle(screen);
    expect(screen.notice()?.getAttribute("data-near-limit")).toBe("near");

    connection.online = false;
    screen.rerender();
    expect(screen.notice()?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.notice()?.getAttribute("data-near-limit")).toBeNull();
  });

  it("a conexão que volta e a leitura que responde sem linha soltam o vão", async () => {
    readPlan.mockResolvedValue(planWith(47));
    const screen = mountScreen();
    await settle(screen);
    expect(screen.notice()?.getAttribute("data-near-limit")).toBe("near");

    connection.online = false;
    screen.rerender();
    expect(screen.settled()).toBe(false);
    expect(screen.notice()?.getAttribute("aria-hidden")).toBe("true");

    connection.online = true;
    readPlan.mockResolvedValue(planWith(44));
    screen.rerender();
    expect(screen.settled()).toBe(false);
    expect(screen.notice()?.getAttribute("aria-hidden")).toBe("true");
    await flush();
    expect(screen.settled()).toBe(true);
    expect(screen.notice()).toBeNull();
    expect(readPlan).toHaveBeenCalledTimes(2);
  });
});

describe("a leitura do plano que falha online", () => {
  it("conta como resposta sem linha: some a linha e o vão se solta", async () => {
    readPlan.mockResolvedValue(planWith(47));
    const screen = mountScreen();
    await settle(screen);
    expect(screen.notice()?.getAttribute("data-near-limit")).toBe("near");

    readPlan.mockRejectedValue(new Error("rede"));
    await settle(screen, 1);
    expect(screen.settled()).toBe(true);
    expect(screen.notice()).toBeNull();
  });

  it("depois de ficar sem conexão, a leitura que falha ao voltar solta o vão guardado", async () => {
    readPlan.mockResolvedValue(planWith(47));
    const screen = mountScreen();
    await settle(screen);

    connection.online = false;
    screen.rerender();
    expect(screen.notice()?.getAttribute("aria-hidden")).toBe("true");

    connection.online = true;
    readPlan.mockRejectedValue(new Error("rede"));
    await settle(screen);
    expect(screen.settled()).toBe(true);
    expect(screen.notice()).toBeNull();
  });
});
