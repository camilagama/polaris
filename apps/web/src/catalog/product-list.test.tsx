import type { CategoryReadModel, ProductReadModel } from "@polaris/contracts";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PendingProduct } from "../offline/product-create";
import { lockedReasonFor, ProductList } from "./product-list";

/**
 * The list of the products screen, drawn without a browser: what each state says and what each row carries. The
 * menu opens in a popup (Base UI), so its items are proved in the browser (e2e/products-screen.e2e.ts); here is the
 * trigger, its name and whether it is off.
 */
const product = (
  n: number,
  overrides: Partial<ProductReadModel> = {}
): ProductReadModel => ({
  archivedAt: null,
  categoryId: null,
  createdAt: "2026-10-14T12:00:00.000Z",
  deletedAt: null,
  description: null,
  id: `0199c2d0-0000-7000-8000-0000000000${20 + n}`,
  name: `Produto ${n}`,
  organizationId: "org",
  status: "active",
  updatedAt: "2026-10-14T12:00:00.000Z",
  version: 1,
  ...overrides,
});

const clothes: CategoryReadModel = {
  archivedAt: null,
  createdAt: "2026-10-14T12:00:00.000Z",
  deletedAt: null,
  id: "0199c2d0-0000-7000-8000-000000000011",
  name: "Roupas",
  organizationId: "org",
  status: "active",
  updatedAt: "2026-10-14T12:00:00.000Z",
  version: 1,
} as CategoryReadModel;

/** The attribute a switched-off button has (its classes also say `disabled:`). */
const OFF = ' disabled=""';

/** The trigger of the menu of a product, as drawn: its tag, to say whether it is off. */
function menuTrigger(markup: string, name: string): string {
  const tag = new RegExp(
    `<button[^>]*aria-label="Mais ações para ${name}"[^>]*>`
  ).exec(markup);
  if (!tag) {
    throw new Error(`no menu for ${name}`);
  }
  return tag[0];
}

const noop = () => undefined;
type Props = ComponentProps<typeof ProductList>;
const base: Props = {
  categories: [clothes],
  isLoading: false,
  isOffline: false,
  onArchive: noop,
  onEdit: noop,
  onManageMedia: noop,
  onManageVariants: noop,
  onNew: noop,
  onRestore: noop,
  pendingAction: null,
  products: [],
  query: "",
  status: "active",
  syncStates: new Map(),
  total: 0,
};

const html = (props: Partial<Props> = {}) =>
  renderToStaticMarkup(<ProductList {...base} {...props} />);

const pending = (
  productId: string,
  state: PendingProduct["state"]
): PendingProduct => ({
  code: null,
  commandId: "00000000-0000-4000-8000-000000000001",
  productId,
  state,
  variantId: "00000000-0000-4000-8000-000000000002",
});

describe("estados da lista", () => {
  it("carregando diz que carrega, como status, e não mostra a lista nem o convite", () => {
    const markup = html({ isLoading: true });
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Carregando produtos…");
    expect(markup).not.toContain("Nenhum produto ainda");
  });

  it("sem produto nenhum convida a cadastrar o primeiro, com o botão", () => {
    const markup = html();
    expect(markup).toContain("Nenhum produto ainda");
    expect(markup).toContain("Cadastre o primeiro para vender.");
    expect(markup).toContain("Novo produto");
  });

  it("a lista de arquivados vazia não convida a cadastrar", () => {
    const markup = html({ status: "archived" });
    expect(markup).toContain("Nenhum produto arquivado.");
    expect(markup).not.toContain("Novo produto");
  });

  it("com produtos e uma busca que não casa, diz o que foi buscado em vez de dizer que não há produtos", () => {
    const markup = html({ query: " tenis ", total: 3 });
    expect(markup).toContain("Nenhum produto com “tenis”.");
    expect(markup).not.toContain("Nenhum produto ainda");
  });
});

describe("linha do produto", () => {
  it("mostra o nome, a categoria (ou 'Sem categoria'), a descrição e as duas letras do nome", () => {
    const withCategory = product(1, {
      categoryId: clothes.id,
      description: "Algodão, corte reto.",
      name: "Camiseta do teste",
    });
    const markup = html({
      products: [withCategory, product(2, { name: "Meia" })],
      total: 2,
    });
    expect(markup).toContain("Camiseta do teste");
    expect(markup).toContain("Roupas");
    expect(markup).toContain("Algodão, corte reto.");
    expect(markup).toContain("Sem categoria");
    expect(markup).toContain(">CA<");
    expect(markup).toContain(">ME<");
  });

  it("uma categoria que a lista não conhece aparece como 'Categoria vinculada', não some", () => {
    const markup = html({
      products: [
        product(1, { categoryId: "0199c2d0-0000-7000-8000-0000000000ff" }),
      ],
      total: 1,
    });
    expect(markup).toContain("Categoria vinculada");
  });

  it("o menu tem o nome do produto e fica ligado quando nada o trava", () => {
    const markup = html({ products: [product(1)], total: 1 });
    expect(markup).toContain('aria-label="Mais ações para Produto 1"');
    expect(menuTrigger(markup, "Produto 1")).not.toContain(OFF);
  });

  it("cada linha é achada pelo id do produto (o foco volta ao menu dela)", () => {
    const one = product(1);
    expect(html({ products: [one], total: 1 })).toContain(
      `data-product-id="${one.id}"`
    );
  });

  it("produto guardado no aparelho mostra o selo e diz por que as ações esperam; offline, a linha não repete o aviso da tela", () => {
    const saved = product(1);
    const waiting = html({
      products: [saved],
      syncStates: new Map([[saved.id, pending(saved.id, "pending")]]),
      total: 1,
    });
    expect(waiting).toContain("Aguardando envio");
    expect(waiting).toContain(
      "Disponível depois que o servidor confirmar o cadastro."
    );

    const offline = html({ isOffline: true, products: [product(2)], total: 1 });
    expect(offline).not.toContain("Disponível quando houver conexão.");
  });

  it("produto recusado pelo servidor tem o selo de erro e o caminho para Pendências", () => {
    const refused = product(1);
    const markup = html({
      products: [refused],
      syncStates: new Map([[refused.id, pending(refused.id, "rejected")]]),
      total: 1,
    });
    expect(markup).toContain("Recusado pelo servidor");
    expect(markup).toContain('href="/attention"');
    expect(markup).toContain("Resolver em Pendências");
  });

  it("arquivando ou restaurando, a linha diz o que faz, como status, e o menu desliga", () => {
    const one = product(1);
    const archiving = html({
      pendingAction: `archive:${one.id}`,
      products: [one],
      total: 1,
    });
    expect(archiving).toContain("Arquivando…");
    expect(menuTrigger(archiving, "Produto 1")).toContain(OFF);
    expect(
      html({ pendingAction: `restore:${one.id}`, products: [one], total: 1 })
    ).toContain("Restaurando…");
  });

  it("a ação de um produto não desliga o menu de outro", () => {
    const [one, two] = [product(1), product(2)];
    const markup = html({
      pendingAction: `archive:${one.id}`,
      products: [one, two],
      total: 2,
    });
    expect(menuTrigger(markup, "Produto 1")).toContain(OFF);
    expect(menuTrigger(markup, "Produto 2")).not.toContain(OFF);
  });
});

describe("o que trava as ações", () => {
  it("produto ainda não confirmado, sem conexão, ou livre", () => {
    expect(lockedReasonFor(pending("p", "pending"), false)).toBe(
      "Disponível depois que o servidor confirmar o cadastro."
    );
    expect(lockedReasonFor(undefined, true)).toBe(
      "Disponível quando houver conexão."
    );
    expect(lockedReasonFor(undefined, false)).toBeNull();
    // the unconfirmed product says its own reason even offline
    expect(lockedReasonFor(pending("p", "sending"), true)).toBe(
      "Disponível depois que o servidor confirmar o cadastro."
    );
  });
});
