import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMediaThumbsEnabled } from "../lib/media-thumbs-flag";
import { MediaThumbnailScope } from "./media-thumbnail-scope";
import { ProductThumbnail, ThumbnailLoaderProvider } from "./product-thumbnail";
import { ThumbnailCache } from "./thumbnail-cache";
import { ThumbnailLoader } from "./thumbnail-queue";
import type { ThumbnailTransport } from "./thumbnail-transport";

/**
 * The scope that decides whether the lists of a store draw capas. The browser's part (the observer that tells a row
 * is on screen) is proved in e2e-pwa/product-thumbnail.e2e.ts; here the flag reaches the rows, and what a row on
 * screen asks of the transport (`show` is what the row calls when it becomes visible) is read from a spy.
 */
const organization = vi.hoisted(() => ({ mediaThumbs: false }));

vi.mock("../lib/current-organization", () => ({
  useOrganizationLoad: () => ({ mediaThumbs: organization.mediaThumbs }),
}));

vi.mock("../offline/runtime/runtime-context", () => ({
  useOfflineRuntime: () => null,
  useRuntimeSnapshot: () => null,
}));

const settle = async () => {
  for (let round = 0; round < 6; round += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each round lets the promises of the previous one run
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

const ERROR_TEXT = /erro|falha|…/i;
const COVER = "0199c2d0-0000-7000-8000-0000000000a1";

function Probe() {
  return <b>{useMediaThumbsEnabled() ? "on" : "off"}</b>;
}

beforeEach(() => {
  organization.mediaThumbs = false;
});

describe("MediaThumbnailScope", () => {
  it("sem escopo (tela montada sozinha), a flag está desligada", () => {
    expect(renderToStaticMarkup(<Probe />)).toBe("<b>off</b>");
  });

  it.each([
    [false, "off"],
    [true, "on"],
  ])("com mediaThumbs=%s, as listas abaixo leem %s", (flag, expected) => {
    organization.mediaThumbs = flag;
    expect(
      renderToStaticMarkup(
        <MediaThumbnailScope organizationId="org-1">
          <Probe />
        </MediaThumbnailScope>
      )
    ).toBe(`<b>${expected}</b>`);
  });

  it("desligado, a linha desenha só o marcador, sem imagem nem texto de erro", () => {
    organization.mediaThumbs = false;
    const markup = renderToStaticMarkup(
      <MediaThumbnailScope organizationId="org-1">
        <ProductThumbnail assetId={COVER} name="Boné azul" size={40} />
      </MediaThumbnailScope>
    );
    expect(markup).toContain('data-thumbnail="marker"');
    expect(markup).toContain(">BO<");
    expect(markup).not.toContain("<img");
  });
});

function loaderWith(transport: ThumbnailTransport) {
  let urls = 0;
  const cache = new ThumbnailCache({
    createUrl: () => {
      urls += 1;
      return `blob:https://polaris.test/thumb-${urls}`;
    },
    disk: null,
    now: () => 0,
    revokeUrl: () => undefined,
  });
  const loader = new ThumbnailLoader({
    cache,
    isOnline: () => true,
    organizationId: "org-1",
    random: () => 0.5,
    schedule: () => () => undefined,
    subscribeOnline: () => () => undefined,
    transport,
  });
  return { cache, loader };
}

function drawn(loader: ThumbnailLoader, assetId: string): string {
  return renderToStaticMarkup(
    <ThumbnailLoaderProvider loader={loader}>
      <ProductThumbnail assetId={assetId} name="Boné azul" size={40} />
    </ThumbnailLoaderProvider>
  );
}

describe("o que uma linha na tela pede ao transporte", () => {
  it("a primeira linha visível faz um único pedido com o id da capa; a segunda linha com o mesmo id não repete", async () => {
    const calls: string[][] = [];
    const { loader } = loaderWith(({ ids }) => {
      calls.push([...ids]);
      return Promise.resolve({
        items: new Map(
          ids.map((id) => [id, new Blob(["webp"], { type: "image/webp" })])
        ),
        kind: "ok" as const,
      });
    });

    loader.show(COVER);
    await settle();
    expect(calls).toEqual([[COVER]]);

    loader.show(COVER);
    await settle();
    expect(calls).toEqual([[COVER]]);
    expect(drawn(loader, COVER)).toContain('src="blob:');
  });

  it("duas linhas visíveis ao mesmo tempo com o mesmo id contam um pedido só, enquanto o primeiro está em voo", async () => {
    const calls: string[][] = [];
    const { loader } = loaderWith(({ ids }) => {
      calls.push([...ids]);
      return new Promise(() => undefined);
    });

    loader.show(COVER);
    loader.show(COVER);
    await settle();

    expect(calls).toEqual([[COVER]]);
  });

  it("transporte que falha deixa o marcador: sem imagem, sem ícone e sem texto de erro", async () => {
    const { loader } = loaderWith(() => Promise.resolve({ kind: "failed" }));
    loader.show(COVER);
    await settle();

    const markup = drawn(loader, COVER);
    expect(markup).toContain('data-thumbnail="marker"');
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("<svg");
    expect(markup).not.toMatch(ERROR_TEXT);
  });

  it("id que o servidor diz que não existe deixa o marcador e não é pedido de novo", async () => {
    const calls: string[][] = [];
    const { loader } = loaderWith(({ ids }) => {
      calls.push([...ids]);
      return Promise.resolve({
        items: new Map(ids.map((id) => [id, null])),
        kind: "ok" as const,
      });
    });
    loader.show(COVER);
    await settle();
    loader.show(COVER);
    await settle();

    expect(calls).toEqual([[COVER]]);
    const markup = drawn(loader, COVER);
    expect(markup).toContain('data-thumbnail="marker"');
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("<svg");
  });
});
