import { MEDIA_THUMBS_MAX_PER_REQUEST } from "@polaris/domain/catalog/media";
import { describe, expect, it } from "vitest";
import { ThumbnailCache } from "../catalog/thumbnail-cache";
import { ThumbnailLoader } from "../catalog/thumbnail-queue";
import {
  createThumbnailTransport,
  type ThumbnailTransport,
  thumbnailBatchUrl,
} from "../catalog/thumbnail-transport";
import {
  MEDIA_THUMBS_HEADER,
  mediaThumbsHeaderValue,
  parseMediaThumbIds,
} from "./media-thumbs";

/**
 * The batch route and its client agree on the format: the ids the client puts in the URL are the ones the route
 * reads, and the header the route writes is the one the client splits the body by.
 */
const A = "0199c2d0-0000-7000-8000-00000000000a";
const B = "0199c2d0-0000-7000-8000-00000000000b";
const C = "0199c2d0-0000-7000-8000-00000000000c";
const ORIGIN = "https://polaris.test";

const encoder = new TextEncoder();
/** A WebP container (RIFF, its length, WEBP) around a tag, told apart by the tag. */
const webp = (tag: string) => {
  const payload = encoder.encode(tag);
  const bytes = new Uint8Array(12 + payload.length);
  bytes.set(encoder.encode("RIFF"), 0);
  new DataView(bytes.buffer).setUint32(4, payload.length + 4, true);
  bytes.set(encoder.encode("WEBP"), 8);
  bytes.set(payload, 12);
  return bytes;
};
const tagOf = async (blob: Blob | null | undefined) =>
  blob ? new TextDecoder().decode((await blob.arrayBuffer()).slice(12)) : blob;

describe("contrato da rota em lote com o cliente das miniaturas", () => {
  it("o servidor lê os ids que o cliente manda, e o cliente lê o cabeçalho que o servidor escreve", async () => {
    const url = thumbnailBatchUrl("org-1", [A, B, C], ORIGIN);
    expect(
      parseMediaThumbIds(url.searchParams.get("ids") ?? undefined)
    ).toEqual([A, B, C]);
    const header = mediaThumbsHeaderValue([
      { id: A, size: 15 },
      { id: B, size: null },
      { id: C, size: 14 },
    ]);
    const transport = createThumbnailTransport(
      () =>
        Promise.resolve(
          new Response(new Blob([webp("aaa"), webp("cc")]), {
            headers: { [MEDIA_THUMBS_HEADER]: header },
            status: 200,
          })
        ),
      ORIGIN
    );
    const result = await transport({
      ids: [A, B, C],
      organizationId: "org-1",
      signal: new AbortController().signal,
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(await tagOf(result.items.get(A))).toBe("aaa");
      expect(result.items.get(B)).toBeNull();
      expect(await tagOf(result.items.get(C))).toBe("cc");
    }
  });
});

describe("teto do lote", () => {
  const list = Array.from(
    { length: MEDIA_THUMBS_MAX_PER_REQUEST * 4 + 3 },
    (_, index) =>
      `0199c2d0-0000-7000-8000-${index.toString(16).padStart(12, "0")}`
  );

  async function askAll(visible: readonly string[]) {
    const sizes: number[] = [];
    const parsed: string[][] = [];
    const transport: ThumbnailTransport = ({ ids, organizationId }) => {
      sizes.push(ids.length);
      const url = thumbnailBatchUrl(organizationId, ids, ORIGIN);
      try {
        parsed.push(
          parseMediaThumbIds(url.searchParams.get("ids") ?? undefined)
        );
      } catch {
        return Promise.resolve({ kind: "refused" });
      }
      return Promise.resolve({
        items: new Map(ids.map((id) => [id, null])),
        kind: "ok",
      });
    };
    const loader = new ThumbnailLoader({
      cache: new ThumbnailCache({
        createUrl: () => "blob:unused",
        disk: null,
        now: () => 0,
        revokeUrl: () => undefined,
      }),
      isOnline: () => true,
      organizationId: "org-1",
      random: () => 0.5,
      schedule: () => () => undefined,
      subscribeOnline: () => () => undefined,
      transport,
    });
    loader.setSequence(list);
    for (const id of visible) {
      loader.show(id);
    }
    for (let round = 0; round < 40; round += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each round lets the promises of the previous one run
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return { parsed, sizes };
  }

  it("nenhum lote do cliente passa do teto que o servidor aceita, com toda a lista na tela", async () => {
    const { parsed, sizes } = await askAll(list);
    expect(parsed).toHaveLength(sizes.length);
    expect(Math.max(...sizes)).toBe(MEDIA_THUMBS_MAX_PER_REQUEST);
    expect(parsed.flat().sort()).toEqual([...list].sort());
  });

  it("nem o lote completado com as próximas linhas da lista passa do teto", async () => {
    const { parsed, sizes } = await askAll(list.slice(0, 2));
    expect(parsed).toHaveLength(sizes.length);
    expect(sizes[0]).toBe(MEDIA_THUMBS_MAX_PER_REQUEST);
    expect(Math.max(...sizes)).toBe(MEDIA_THUMBS_MAX_PER_REQUEST);
  });

  it("o servidor recusa um id acima do teto", () => {
    expect(() =>
      parseMediaThumbIds(
        list.slice(0, MEDIA_THUMBS_MAX_PER_REQUEST + 1).join(",")
      )
    ).toThrow();
    expect(
      parseMediaThumbIds(list.slice(0, MEDIA_THUMBS_MAX_PER_REQUEST).join(","))
    ).toHaveLength(MEDIA_THUMBS_MAX_PER_REQUEST);
  });
});
