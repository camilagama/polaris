import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ProductThumbnail,
  type ProductThumbnailSize,
  ThumbnailLoaderProvider,
} from "./product-thumbnail";
import { ThumbnailCache } from "./thumbnail-cache";
import { ThumbnailLoader } from "./thumbnail-queue";

/**
 * The thumbnail drawn without a browser, in its six states: the box (size, corners, reserved width, height and
 * aspect ratio) is the same in all of them, the marker is the two initials and nothing else, and the photo is
 * decoration. The visibility and the fade are the browser's (e2e-pwa/product-thumbnail.e2e.ts).
 */
const BOX =
  /^<span aria-hidden="true" class="([^"]+)" data-thumbnail="(\w+)" style="([^"]+)">/;
const TAG = /<(\w+)/g;
const PRELOAD_HINT = /^<link rel="preload" as="image" href="[^"]+"\/>/;
const IMG_CLASS = /<img[^>]+class="([^"]+)"/;
const MOVING = /transition|duration|animate/;
const WARNING_LOOK = /border|destructive|warning/;
const ERROR_TEXT = /…|\.\.\.|erro|falha/i;
const DECORATIVE_IMG = /<img alt="" class="absolute inset-0/;
const FOCUS_OR_NAME = /tabindex|role=|aria-label/;
const TEXT_BETWEEN_TAGS = />([^<]+)</g;

function loaderWith(options: { cached: string[]; online: boolean }) {
  let made = 0;
  const cache = new ThumbnailCache({
    createUrl: () => {
      made += 1;
      return `blob:https://polaris.test/thumb-${made}`;
    },
    disk: null,
    now: () => 0,
    revokeUrl: () => undefined,
  });
  for (const id of options.cached) {
    cache.store(id, new Blob(["webp"], { type: "image/webp" }));
  }
  return new ThumbnailLoader({
    cache,
    isOnline: () => options.online,
    organizationId: "org-1",
    schedule: () => () => undefined,
    subscribeOnline: () => () => undefined,
    transport: () => new Promise(() => undefined),
  });
}

function draw(node: ReactNode, loader: ThumbnailLoader | null): string {
  return renderToStaticMarkup(
    loader ? (
      <ThumbnailLoaderProvider loader={loader}>{node}</ThumbnailLoaderProvider>
    ) : (
      node
    )
  );
}

function box(drawn: string) {
  // React's own hint for an image in markup rendered to a string; a browser render has no such tag
  const markup = drawn.replace(PRELOAD_HINT, "");
  const match = BOX.exec(markup);
  expect(match, markup).not.toBeNull();
  return {
    className: match?.[1],
    state: match?.[2],
    style: match?.[3],
    tags: [...markup.matchAll(TAG)].map((tag) => tag[1]),
    text: [...markup.matchAll(TEXT_BETWEEN_TAGS)]
      .map((part) => part[1])
      .join(""),
  };
}

function sixStates(size: ProductThumbnailSize) {
  const online = loaderWith({ cached: ["cached"], online: true });
  const offline = loaderWith({ cached: ["cached"], online: false });
  const thumb = (assetId: string | null) => (
    <ProductThumbnail assetId={assetId} name="Camiseta azul" size={size} />
  );
  return {
    carregando: draw(thumb("loading"), online),
    "com erro": draw(thumb("failed"), online),
    "em cache": draw(thumb("cached"), online),
    "offline com cache": draw(thumb("cached"), offline),
    "offline sem cache": draw(thumb("never-seen"), offline),
    "sem imagem": draw(thumb(null), online),
  };
}

describe("ProductThumbnail", () => {
  it.each([40, 32] as const)(
    "a caixa de %i px é a mesma nos seis estados, com largura, altura e proporção reservadas",
    (size) => {
      const states = Object.values(sixStates(size)).map(box);
      const [first] = states;
      for (const state of states) {
        expect(state.className).toBe(first?.className);
        expect(state.style).toBe(first?.style);
      }
      expect(first?.style).toBe(
        `aspect-ratio:1 / 1;height:${size}px;width:${size}px`
      );
      expect(first?.className).toContain(
        size === 40 ? "size-10 rounded-md" : "size-8 rounded-sm"
      );
      expect(first?.className).toContain("bg-muted");
    }
  );

  it("o marcador são as duas iniciais do produto e nada mais: sem ícone, sem texto de erro, sem borda de aviso", () => {
    const states = sixStates(40);
    for (const [name, markup] of Object.entries(states)) {
      const drawn = box(markup);
      expect(drawn.text, name).toBe("CA");
      expect(
        drawn.tags.filter((tag) => tag !== "span" && tag !== "img"),
        name
      ).toEqual([]);
      expect(drawn.className, name).not.toMatch(WARNING_LOOK);
      expect(markup, name).not.toMatch(ERROR_TEXT);
    }
  });

  it("com a foto no cache, ela vem por cima das iniciais, decorativa: alt vazio, sem foco e dentro de uma caixa escondida do leitor", () => {
    const states = sixStates(40);
    for (const name of ["em cache", "offline com cache"] as const) {
      const markup = states[name];
      expect(markup, name).toMatch(DECORATIVE_IMG);
      expect(markup, name).toContain("object-cover object-center");
      expect(markup, name).toContain('src="blob:');
      expect(markup, name).not.toMatch(FOCUS_OR_NAME);
    }
    for (const name of [
      "carregando",
      "com erro",
      "offline sem cache",
      "sem imagem",
    ] as const) {
      expect(states[name], name).not.toContain("<img");
    }
  });

  it("a foto aparece de uma vez no celular e com movimento reduzido; só o nível full anima a opacidade em 150 ms", () => {
    const markup = sixStates(40)["em cache"];
    const img = IMG_CLASS.exec(markup)?.[1] ?? "";
    const classes = img.split(" ");
    expect(classes).toContain("opacity-0");
    expect(classes).toContain("data-[loaded]:opacity-100");
    const moving = classes.filter((name) => MOVING.test(name));
    expect(moving).toEqual([
      "motion-full:transition-opacity",
      "motion-full:duration-150",
    ]);
  });

  it("sem provedor (tela que ainda não liga a miniatura), mostra o marcador e não pede nada", () => {
    const drawn = box(
      draw(<ProductThumbnail assetId="any" name="Boné" size={32} />, null)
    );
    expect(drawn.text).toBe("BO");
    expect(drawn.state).toBe("marker");
    expect(drawn.tags).toEqual(["span"]);
  });
});
