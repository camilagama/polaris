import type { CategoryReadModel, ProductReadModel } from "@polaris/contracts";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MediaThumbsFlagProvider } from "../lib/media-thumbs-flag";
import type { PendingProduct } from "../offline/product-create";
import { lockedReasonFor, ProductList } from "./product-list";
import { ThumbnailLoaderProvider } from "./product-thumbnail";
import { ThumbnailCache } from "./thumbnail-cache";
import { ThumbnailLoader } from "./thumbnail-queue";

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

/** The button that opens a product from its row, as drawn: its opening tag. */
function rowOpen(markup: string, name: string): string {
  const tag = new RegExp(
    `<button[^>]*data-row-open=""[^>]*>(?:(?!</button>).)*<span class="sr-only">Editar </span>${name}<`,
    "s"
  ).exec(markup);
  if (!tag) {
    throw new Error(`no row button for ${name}`);
  }
  return tag[0];
}

const ROW_BUTTON_PRODUTO_1 =
  /<button[^>]*data-row-open=""[^>]*>(?:(?!<\/button>).)*<span class="sr-only">Editar <\/span>Produto 1<\/span>/s;
/** A button that opens before the one before it closed. */
const BUTTON_IN_BUTTON = /<button(?:(?!<\/button>).)*<button/s;

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

const DESCRIBED_BY = /aria-describedby="([^"]*)"/;
/** The text of the elements a tag points to with aria-describedby, in order. */
function describedByText(markup: string, tag = ""): string[] {
  const ids = DESCRIBED_BY.exec(tag)?.[1]?.split(" ") ?? [];
  return ids.map((id) => {
    const text = new RegExp(`id="${id}"[^>]*>([^<]*)<`).exec(markup)?.[1];
    return text ?? "";
  });
}

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
    expect(markup).not.toContain("Cadastre o primeiro");
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
    expect(markup).toContain("Roupas · Algodão, corte reto.");
    expect(markup).toContain(">Sem categoria<");
    expect(markup).toContain(">CA<");
    expect(markup).toContain(">ME<");
  });

  it("a linha de apoio é uma só, de uma linha, e a data de atualização não está na lista", () => {
    const markup = html({
      products: [
        product(1, {
          categoryId: clothes.id,
          description: "Algodão,\n\ncorte   reto.",
        }),
      ],
      total: 1,
    });
    expect(markup).toContain("Roupas · Algodão, corte reto.");
    expect(markup).toContain("line-clamp-1");
    expect(markup).not.toContain("Atualizado");
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

  it("a linha abre o produto: o nome é um botão 'Editar …', fora do menu e sem botão dentro de botão", () => {
    const markup = html({ products: [product(1)], total: 1 });
    const open = rowOpen(markup, "Produto 1");
    expect(open).not.toContain("aria-disabled=");
    expect(markup).toMatch(ROW_BUTTON_PRODUTO_1);
    // the row button and the menu are siblings: no button opens before the row button closes
    expect(markup).not.toMatch(BUTTON_IN_BUTTON);
  });

  it("a linha travada continua focável, diz o motivo e não abre", () => {
    const saved = product(1);
    const waiting = html({
      products: [saved],
      syncStates: new Map([[saved.id, pending(saved.id, "pending")]]),
      total: 1,
    });
    const tag = rowOpen(waiting, "Produto 1");
    expect(tag).toContain('aria-disabled="true"');
    expect(tag).toContain(
      `aria-describedby="product-support-${saved.id} product-locked-${saved.id}"`
    );
    expect(waiting).toContain(`id="product-locked-${saved.id}"`);
    expect(tag).not.toContain(OFF);

    const offline = rowOpen(
      html({ isOffline: true, products: [product(2)], total: 1 }),
      "Produto 2"
    );
    expect(offline).toContain('aria-disabled="true"');
    expect(offline).toContain(
      `aria-describedby="product-support-${product(2).id} products-offline-notice"`
    );

    const archiving = rowOpen(
      html({
        pendingAction: `archive:${saved.id}`,
        products: [saved],
        total: 1,
      }),
      "Produto 1"
    );
    expect(archiving).toContain('aria-disabled="true"');
    expect(archiving).toContain(
      `aria-describedby="product-support-${saved.id} product-pending-${saved.id}"`
    );
  });

  it("a linha que espera uma ação liga o botão ao texto do que roda, junto do motivo que já houver", () => {
    const [one, two] = [product(1), product(2)];
    const markup = html({
      pendingAction: `archive:${one.id}`,
      products: [one, two],
      total: 2,
    });
    expect(describedByText(markup, rowOpen(markup, "Produto 1"))).toContain(
      "Arquivando…"
    );
    expect(rowOpen(markup, "Produto 2")).toBe(
      rowOpen(html({ products: [two], total: 1 }), "Produto 2")
    );
    expect(rowOpen(markup, "Produto 2")).not.toContain("product-pending-");

    const both = html({
      pendingAction: `archive:${one.id}`,
      products: [one],
      syncStates: new Map([[one.id, pending(one.id, "pending")]]),
      total: 1,
    });
    expect(rowOpen(both, "Produto 1")).toContain(
      `aria-describedby="product-support-${one.id} product-locked-${one.id} product-pending-${one.id}"`
    );
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

const COVER = "0199c2d0-0000-7000-8000-0000000000c1";
const THUMB_BOX =
  /<span aria-hidden="true" class="[^"]*size-10 rounded-md[^"]*"/g;
const MARKER_CIRCLE = /rounded-full/g;

function idleLoader(): ThumbnailLoader {
  return new ThumbnailLoader({
    cache: new ThumbnailCache({ disk: null, now: () => 0 }),
    isOnline: () => true,
    organizationId: "org",
    schedule: () => () => undefined,
    subscribeOnline: () => () => undefined,
    transport: () => new Promise(() => undefined),
  });
}

const withThumbs = (props: Partial<Props>) =>
  renderToStaticMarkup(
    <MediaThumbsFlagProvider value>
      <ThumbnailLoaderProvider loader={idleLoader()}>
        <ProductList {...base} {...props} />
      </ThumbnailLoaderProvider>
    </MediaThumbsFlagProvider>
  );

describe("a capa na lista, atrás da flag", () => {
  const products = [
    product(1, { coverAssetId: COVER }),
    product(2, { coverAssetId: null }),
    product(3),
  ];

  it("sem escopo, cada linha tem o círculo de iniciais de hoje e nenhuma caixa de miniatura", () => {
    const markup = html({ products, total: 3 });
    expect(markup.match(MARKER_CIRCLE)).toHaveLength(3);
    expect(markup).toContain("size-9");
    expect(markup).not.toContain("data-thumbnail");
    expect(markup).not.toContain("<img");
  });

  it("com a flag ligada, cada linha tem a caixa de 40 px arredondada, decorativa e com o marcador", () => {
    const markup = withThumbs({ products, total: 3 });
    expect(markup.match(THUMB_BOX)).toHaveLength(3);
    expect(markup.match(/data-thumbnail="marker"/g)).toHaveLength(3);
    expect(markup).not.toContain("size-9");
    expect(markup).not.toMatch(MARKER_CIRCLE);
    expect(markup).not.toContain("<img");
    expect(markup).toContain(">PR<");
  });

  it("o nome acessível e a ordem dos elementos da linha são os mesmos com e sem a flag", () => {
    const off = html({ products, total: 3 });
    const on = withThumbs({ products, total: 3 });
    for (const name of ["Produto 1", "Produto 2", "Produto 3"]) {
      expect(rowOpen(on, name)).toContain(`Editar </span>${name}<`);
      expect(menuTrigger(on, name)).toBe(menuTrigger(off, name));
    }
    const order = (markup: string) =>
      [
        "data-row-open",
        "Editar ",
        "Produto 1",
        "Mais ações para Produto 1",
      ].map((needle) => markup.indexOf(needle));
    const sorted = (list: number[]) => [...list].sort((a, b) => a - b);
    expect(order(on)).toEqual(sorted(order(on)));
    expect(order(off)).toEqual(sorted(order(off)));
  });

  it("com a flag ligada, o que fica sob o texto da linha recua para o fim da caixa maior", () => {
    const saved = product(1, { coverAssetId: COVER });
    const syncStates = new Map([[saved.id, pending(saved.id, "pending")]]);
    const on = withThumbs({ products: [saved], syncStates, total: 1 });
    const off = html({ products: [saved], syncStates, total: 1 });
    expect(on).toContain("pb-2.5 pl-13");
    expect(off).toContain("pb-2.5 pl-12");
  });
});
