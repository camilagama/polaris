import type { GoalReadModel } from "@polaris/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StoredPeriodSummary } from "../lib/period-summary-cache";
import { ChartBlock } from "./home-chart";
import { TopProductsBlock } from "./home-figures";
import { GoalBlock, OfflineGoalBlock } from "./home-goal";
import { BlockSkeleton, HomeBlock, HomeRoleProvider } from "./home-parts";

const noRetry = () => undefined;

const FOOTER_LINK = /<a\b[^>]*data-slot="card-frame-link"[^>]*>/;
const HREF = /href="([^"]*)"/;
const PANEL_WITH_OWN_BOX = /(^| )(bg-card|p-\(--card-spacing\)|ring-1)( |$)/;
const LABEL_THEN_ARROW = />Ver o resultado<svg/;
const FOOTER = /<div\b[^>]*data-slot="card-frame-footer"[^>]*>/;

const withRole = (role: string, node: React.ReactNode) =>
  renderToStaticMarkup(
    <HomeRoleProvider value={role}>{node}</HomeRoleProvider>
  );

const footerHref = (html: string) =>
  HREF.exec(FOOTER_LINK.exec(html)?.[0] ?? "")?.[1] ?? null;

const summary = (from: string, to: string) =>
  ({
    daily: [{ date: from, netSales: "10.00", salesCount: 1 }],
    period: { from, to },
  }) as unknown as StoredPeriodSummary;

const goal: GoalReadModel = {
  achievedValue: null,
  createdAt: "2026-11-01T12:00:00.000Z",
  endsOn: "2026-11-30",
  id: "0199c2d0-0000-7000-8000-000000000001",
  kind: "net_sales",
  name: null,
  organizationId: "org",
  paused: false,
  progress: {
    percent: "10.00",
    periodEnded: false,
    reached: false,
    value: "500.00",
  },
  settledAt: null,
  startsOn: "2026-11-01",
  status: "active",
  target: "5000.00",
  updatedAt: "2026-11-01T12:00:00.000Z",
  version: 1,
};

describe("a moldura dos blocos do Início", () => {
  const block = (props: Partial<Parameters<typeof HomeBlock>[0]> = {}) => (
    <HomeBlock id="home-teste" title="Teste" {...props}>
      <p>conteúdo</p>
    </HomeBlock>
  );

  it("é uma região com o título na moldura e o conteúdo no painel, nessa ordem", () => {
    const html = withRole("owner", block());
    expect(html).toContain('data-slot="card-frame"');
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-labelledby="home-teste"');
    const header = html.indexOf('data-slot="card-frame-header"');
    const panel = html.indexOf('data-slot="card-frame-panel"');
    expect(header).toBeGreaterThan(-1);
    expect(panel).toBeGreaterThan(header);
    expect(html.indexOf('id="home-teste"')).toBeLessThan(panel);
    expect(html.indexOf("conteúdo")).toBeGreaterThan(panel);
  });

  it("a moldura só existe a partir de 760 px: abaixo disso o painel não tem caixa e o pé some", () => {
    const html = withRole(
      "owner",
      block({
        footer: { capability: "report:read", href: "/dashboard", label: "Ver" },
      })
    );
    const classes = (slot: string) =>
      new RegExp(`class="([^"]*)"[^>]*data-slot="${slot}"`).exec(html)?.[1] ??
      "";
    expect(classes("card-frame")).toContain("md:bg-muted");
    expect(classes("card-frame")).toContain("bg-card");
    const panel = classes("card-frame-panel");
    expect(panel).toContain("md:bg-card");
    expect(panel).toContain("md:p-(--card-spacing)");
    expect(panel).not.toMatch(PANEL_WITH_OWN_BOX);
    expect(classes("card-frame-footer").split(" ")).toContain("hidden");
    expect(classes("card-frame-footer")).toContain("md:flex");
  });

  it("a faixa fina (plain) fica no cartão simples em qualquer largura", () => {
    const html = withRole("owner", block({ plain: true }));
    expect(html).toContain('data-slot="card"');
    expect(html).not.toContain("card-frame");
  });

  it("o pé é um link, com o nome do destino, só para quem tem a permissão dele", () => {
    const footer = {
      capability: "report:read",
      href: "/dashboard",
      label: "Ver o resultado",
    };
    const owner = withRole("owner", block({ footer }));
    expect(footerHref(owner)).toBe("/dashboard");
    expect(owner).toMatch(LABEL_THEN_ARROW);
    expect(FOOTER_LINK.exec(owner)?.[0]).toContain("touch-hit");
    expect(footerHref(withRole("ninguem", block({ footer })))).toBeNull();
    expect(FOOTER.test(withRole("ninguem", block({ footer })))).toBe(false);
    expect(footerHref(renderToStaticMarkup(block({ footer })))).toBeNull();
  });

  it("sem conexão a linha do pé fica e o link sai (o bloco não muda de altura)", () => {
    const html = withRole(
      "owner",
      block({
        footer: {
          capability: "goal:manage",
          href: "/dashboard?aba=metas",
          label: "Ver as metas",
          link: false,
        },
      })
    );
    expect(FOOTER.test(html)).toBe(true);
    expect(footerHref(html)).toBeNull();
  });

  it("o esqueleto tem a forma da moldura e, com pé, a linha do pé", () => {
    const html = renderToStaticMarkup(
      <BlockSkeleton foot label="Carregando…" lines={2} />
    );
    expect(html).toContain('data-slot="card-frame"');
    expect(html).toContain('data-slot="card-frame-panel"');
    expect(html).toContain('data-slot="card-frame-footer"');
    expect(html).toContain('role="status"');
    expect(
      renderToStaticMarkup(<BlockSkeleton label="Carregando…" />)
    ).not.toContain("card-frame-footer");
  });
});

describe("o pé de cada bloco do Início", () => {
  it("Vendas por dia leva ao Resultado com o período escolhido no endereço", () => {
    const today = "2026-11-21";
    const month = withRole(
      "owner",
      <ChartBlock summary={summary("2026-11-01", "2026-11-30")} today={today} />
    );
    expect(footerHref(month)).toBe("/dashboard");
    const last30 = withRole(
      "owner",
      <ChartBlock summary={summary("2026-10-23", "2026-11-21")} today={today} />
    );
    expect(footerHref(last30)).toBe("/dashboard?periodo=30-dias");
    const range = withRole(
      "owner",
      <ChartBlock summary={summary("2026-11-03", "2026-11-09")} today={today} />
    );
    expect(footerHref(range)).toBe("/dashboard?de=2026-11-03&amp;ate=2026-11-09");
    expect(range).toContain("Ver o resultado");
  });

  it("Mais vendidos leva aos produtos, com e sem produto no ranking", () => {
    const full = withRole(
      "owner",
      <TopProductsBlock
        products={[
          {
            coverAssetId: null,
            deleted: false,
            name: "Boné",
            netSales: "10.00",
            productId: "0199c2d0-0000-7000-8000-0000000000b2",
            quantity: 1,
          },
        ]}
        salesCount={1}
      />
    );
    expect(footerHref(full)).toBe("/products");
    expect(full).toContain("Ver os produtos");
    const empty = withRole(
      "owner",
      <TopProductsBlock products={[]} salesCount={0} />
    );
    expect(footerHref(empty)).toBe("/products");
  });

  it("Meta leva às metas; a faixa fina e o erro não têm pé; sem conexão fica a linha vazia", () => {
    const ready = withRole(
      "owner",
      <GoalBlock
        block={{ data: [goal], status: "ready" }}
        onRetry={noRetry}
        projection={null}
        today="2026-11-11"
        view={{ goal, kind: "active", others: 0 }}
      />
    );
    expect(footerHref(ready)).toBe("/dashboard?aba=metas");
    expect(ready).toContain("Ver as metas");
    const none = withRole(
      "owner",
      <GoalBlock
        block={{ data: [], status: "ready" }}
        onRetry={noRetry}
        projection={null}
        today="2026-11-11"
        view={{ kind: "none" }}
      />
    );
    expect(none).not.toContain("card-frame");
    const offline = withRole(
      "owner",
      <OfflineGoalBlock goal={{ ended: false, goal, kind: "active" }} />
    );
    expect(FOOTER.test(offline)).toBe(true);
    expect(footerHref(offline)).toBeNull();
  });
});
