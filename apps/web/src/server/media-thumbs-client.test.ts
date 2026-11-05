import { describe, expect, it } from "vitest";
import {
  createThumbnailTransport,
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

const body = (...parts: string[]) =>
  new TextEncoder().encode(parts.join("")).buffer;
const text = async (blob: Blob | null | undefined) =>
  blob ? await blob.text() : blob;

describe("contrato da rota em lote com o cliente das miniaturas", () => {
  it("o servidor lê os ids que o cliente manda, e o cliente lê o cabeçalho que o servidor escreve", async () => {
    const url = thumbnailBatchUrl("org-1", [A, B, C], ORIGIN);
    expect(
      parseMediaThumbIds(url.searchParams.get("ids") ?? undefined)
    ).toEqual([A, B, C]);
    const header = mediaThumbsHeaderValue([
      { id: A, size: 3 },
      { id: B, size: null },
      { id: C, size: 2 },
    ]);
    const transport = createThumbnailTransport(
      () =>
        Promise.resolve(
          new Response(body("aaa", "cc"), {
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
      expect(await text(result.items.get(A))).toBe("aaa");
      expect(result.items.get(B)).toBeNull();
      expect(await text(result.items.get(C))).toBe("cc");
    }
  });
});
