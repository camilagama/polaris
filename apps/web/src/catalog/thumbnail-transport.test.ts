import { describe, expect, it } from "vitest";
import {
  createThumbnailTransport,
  parseThumbnailBatch,
  thumbnailBatchUrl,
} from "./thumbnail-transport";

/**
 * The client of `GET /api/media/thumbs`: the URL it asks, how it splits the body by `X-Polaris-Thumbs`, and what each
 * answer of the server means to the queue. The server is simulated with plain `Response` objects.
 */
const A = "0199c2d0-0000-7000-8000-00000000000a";
const B = "0199c2d0-0000-7000-8000-00000000000b";
const C = "0199c2d0-0000-7000-8000-00000000000c";
const ORIGIN = "https://polaris.test";

const encoder = new TextEncoder();
const body = (...parts: string[]) => encoder.encode(parts.join("")).buffer;
const text = async (blob: Blob | null | undefined) =>
  blob ? await blob.text() : blob;

function server(response: () => Response | Promise<Response>) {
  const asked: { init: RequestInit; url: URL }[] = [];
  const transport = createThumbnailTransport((url, init) => {
    asked.push({ init, url });
    return Promise.resolve(response());
  }, ORIGIN);
  return { asked, transport };
}

const call = (
  transport: ReturnType<typeof createThumbnailTransport>,
  ids: string[]
) =>
  transport({
    ids,
    organizationId: "org-1",
    signal: new AbortController().signal,
  });

describe("thumbnailBatchUrl", () => {
  it("pede a rota em lote com a loja e os ids separados por vírgula, nunca a rota por imagem", () => {
    const url = thumbnailBatchUrl("org-1", [A, B], ORIGIN);
    expect(url.pathname).toBe("/api/media/thumbs");
    expect(url.searchParams.get("organizationId")).toBe("org-1");
    expect(url.searchParams.get("ids")).toBe(`${A},${B}`);
    expect(url.searchParams.has("size")).toBe(false);
  });
});

describe("parseThumbnailBatch", () => {
  it("corta o corpo na ordem do cabeçalho e deixa missing como null", async () => {
    const items = parseThumbnailBatch(
      [A, B, C],
      `${A}:3,${B}:missing,${C}:2`,
      body("aaa", "cc")
    );
    expect(items).not.toBeNull();
    expect(await text(items?.get(A))).toBe("aaa");
    expect(items?.get(B)).toBeNull();
    expect(await text(items?.get(C))).toBe("cc");
    expect(items?.get(A)?.type).toBe("image/webp");
  });

  it("todos missing: corpo vazio", () => {
    const items = parseThumbnailBatch([A], `${A}:missing`, new ArrayBuffer(0));
    expect(items?.get(A)).toBeNull();
  });

  it("recusa o que não bate: sem cabeçalho, outra ordem, id a menos, tamanho que não fecha com o corpo", () => {
    expect(parseThumbnailBatch([A], null, body("a"))).toBeNull();
    expect(parseThumbnailBatch([A, B], `${B}:1,${A}:1`, body("ab"))).toBeNull();
    expect(parseThumbnailBatch([A, B], `${A}:2`, body("ab"))).toBeNull();
    expect(parseThumbnailBatch([A], `${A}:3`, body("ab"))).toBeNull();
    expect(parseThumbnailBatch([A], `${A}:1`, body("ab"))).toBeNull();
    expect(parseThumbnailBatch([A], `${A}:-1`, body("a"))).toBeNull();
    expect(parseThumbnailBatch([A], `${A}:0`, body(""))).toBeNull();
  });
});

describe("createThumbnailTransport", () => {
  it("id que não é UUID não vai ao servidor (que recusaria o lote inteiro) e fica sem miniatura", async () => {
    const { asked, transport } = server(
      () =>
        new Response(body("aaa"), {
          headers: { "X-Polaris-Thumbs": `${A}:3` },
          status: 200,
        })
    );
    const result = await call(transport, ["galeria", A]);
    expect(asked[0]?.url.searchParams.get("ids")).toBe(A);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.items.get("galeria")).toBeNull();
      expect(await text(result.items.get(A))).toBe("aaa");
    }
    expect((await call(transport, ["x"])).kind).toBe("ok");
    expect(asked).toHaveLength(1);
  });

  it("200 com cabeçalho e corpo: ok, com a sessão do próprio site", async () => {
    const { asked, transport } = server(
      () =>
        new Response(body("xy"), {
          headers: { "X-Polaris-Thumbs": `${A}:2,${B}:missing` },
          status: 200,
        })
    );
    const result = await call(transport, [A, B]);
    expect(result.kind).toBe("ok");
    expect(asked[0]?.init.credentials).toBe("same-origin");
    expect(asked[0]?.url.pathname).toBe("/api/media/thumbs");
  });

  it("401, 403 e 400 são recusa; 429, 500 e 503 são falha para tentar depois", async () => {
    const kinds: Record<number, string> = {};
    for (const status of [400, 401, 403, 429, 500, 503]) {
      const { transport } = server(() => new Response(null, { status }));
      // biome-ignore lint/performance/noAwaitInLoops: one status after the other
      kinds[status] = (await call(transport, [A])).kind;
    }
    expect(kinds).toEqual({
      400: "refused",
      401: "refused",
      403: "refused",
      429: "failed",
      500: "failed",
      503: "failed",
    });
  });

  it("sem rede, ou corpo que não bate com o cabeçalho: falha", async () => {
    const offline = createThumbnailTransport(
      () => Promise.reject(new TypeError("Failed to fetch")),
      ORIGIN
    );
    expect((await call(offline, [A])).kind).toBe("failed");
    const { transport } = server(
      () =>
        new Response(body("x"), {
          headers: { "X-Polaris-Thumbs": `${A}:5` },
          status: 200,
        })
    );
    expect((await call(transport, [A])).kind).toBe("failed");
  });
});
