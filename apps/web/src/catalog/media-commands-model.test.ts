import { describe, expect, it } from "vitest";
import { MediaUploadHttpError } from "../lib/media-upload";
import {
  describeMediaFailure,
  imageActionAvailability,
  imageActionLabel,
  isMediaSessionEnded,
  movedAssetOrder,
  movedNotice,
  removeConfirmationText,
  removedNotice,
  replaceConfirmationText,
} from "./media-commands-model";

const ids = ["a", "b", "c"];
const priceWords = /R\$|preço|pagar|assin/i;

describe("movedAssetOrder", () => {
  it("moves an image one place earlier or later, keeping the rest", () => {
    expect(movedAssetOrder(ids, 1, "earlier")).toEqual(["b", "a", "c"]);
    expect(movedAssetOrder(ids, 1, "later")).toEqual(["a", "c", "b"]);
    expect(movedAssetOrder(ids, 2, "earlier")).toEqual(["a", "c", "b"]);
  });

  it("does not mutate the list it was given", () => {
    const original = [...ids];
    movedAssetOrder(original, 0, "later");
    expect(original).toEqual(ids);
  });

  it("answers null at the ends and for an unknown position", () => {
    expect(movedAssetOrder(ids, 0, "earlier")).toBeNull();
    expect(movedAssetOrder(ids, 2, "later")).toBeNull();
    expect(movedAssetOrder(ids, -1, "later")).toBeNull();
    expect(movedAssetOrder(ids, 3, "earlier")).toBeNull();
    expect(movedAssetOrder([], 0, "later")).toBeNull();
    expect(movedAssetOrder(["a"], 0, "later")).toBeNull();
  });
});

describe("imageActionAvailability", () => {
  it("disables moving past the ends of the list", () => {
    expect(
      imageActionAvailability({ busy: false, count: 3, index: 0 })
    ).toEqual({
      moveEarlier: false,
      moveLater: true,
      remove: true,
      replace: true,
    });
    expect(
      imageActionAvailability({ busy: false, count: 3, index: 1 })
    ).toEqual({
      moveEarlier: true,
      moveLater: true,
      remove: true,
      replace: true,
    });
    expect(
      imageActionAvailability({ busy: false, count: 3, index: 2 })
    ).toEqual({
      moveEarlier: true,
      moveLater: false,
      remove: true,
      replace: true,
    });
  });

  it("disables moving when there is a single image", () => {
    expect(
      imageActionAvailability({ busy: false, count: 1, index: 0 })
    ).toEqual({
      moveEarlier: false,
      moveLater: false,
      remove: true,
      replace: true,
    });
  });

  it("disables every action while a command runs", () => {
    expect(imageActionAvailability({ busy: true, count: 3, index: 1 })).toEqual(
      {
        moveEarlier: false,
        moveLater: false,
        remove: false,
        replace: false,
      }
    );
  });
});

describe("imageActionLabel", () => {
  it("names each action with the 1-based position of the image", () => {
    expect(imageActionLabel("moveEarlier", 1)).toBe(
      "Mover imagem 2 para antes"
    );
    expect(imageActionLabel("moveLater", 0)).toBe("Mover imagem 1 para depois");
    expect(imageActionLabel("remove", 2)).toBe("Remover imagem 3");
    expect(imageActionLabel("replace", 2)).toBe("Substituir imagem 3");
  });
});

describe("confirmation and result texts", () => {
  it("says the image leaves the product and frees a place in the plan", () => {
    const text = removeConfirmationText({ position: 2, variantCount: 0 });
    expect(text).toContain("imagem 2");
    expect(text).toContain("sai do produto");
    expect(text).toContain("libera um lugar");
    expect(text).not.toContain("variantes");
  });

  it("mentions the variants that use the image", () => {
    expect(removeConfirmationText({ position: 1, variantCount: 2 })).toContain(
      "variantes"
    );
    expect(replaceConfirmationText({ position: 1, variantCount: 2 })).toContain(
      "variantes"
    );
  });

  it("warns that a replacement abandoned later leaves one image fewer", () => {
    const text = replaceConfirmationText({ position: 1, variantCount: 0 });
    expect(text).toContain("removida do produto agora");
    expect(text).toContain("uma imagem a menos");
  });

  it("announces a move and a removal, even one that was already done", () => {
    expect(movedNotice({ from: 2, to: 1 })).toBe(
      "Imagem 2 movida para a posição 1."
    );
    expect(removedNotice(true, 2)).toContain("Imagem 2 removida");
    expect(removedNotice(false, 2)).toContain("já tinha sido removida");
  });
});

describe("describeMediaFailure", () => {
  const http = (code: string, status = 409) =>
    new MediaUploadHttpError(code, status);

  it("asks to retry after reloading when the order is out of date", () => {
    const failure = describeMediaFailure(
      "reorder",
      http("invalid_media_order")
    );
    expect(failure.reloadList).toBe(true);
    expect(failure.message).toContain("mudou em outro lugar");
    expect(failure.message).toContain("Recarregamos a lista");
  });

  it("explains the plan limit on upload without a price and reloads", () => {
    const failure = describeMediaFailure(
      "upload",
      http("entitlement_limit_reached")
    );
    expect(failure.reloadList).toBe(true);
    expect(failure.message).toContain("limite de imagens");
    expect(failure.message).toContain("Remova uma imagem");
    expect(failure.message).not.toMatch(priceWords);
  });

  it("explains that uploads are paused for the month when Images is over quota", () => {
    const failure = describeMediaFailure(
      "upload",
      http("media_transform_quota_exceeded", 503)
    );
    expect(failure.reloadList).toBe(false);
    expect(failure.message).toContain("pausado");
    expect(failure.message).toContain("Nada foi perdido");
    expect(failure.message).not.toMatch(priceWords);
  });

  it("explains the per-product limit on upload", () => {
    const failure = describeMediaFailure("upload", http("product_media_limit"));
    expect(failure.message).toContain("máximo de imagens");
    expect(failure.reloadList).toBe(true);
  });

  it("reloads when the product or image is not found", () => {
    expect(
      describeMediaFailure("remove", http("not_found", 404))
    ).toMatchObject({ reloadList: true });
  });

  it("explains permission and session failures", () => {
    expect(
      describeMediaFailure("remove", http("forbidden", 403)).message
    ).toContain("permissão");
    expect(
      describeMediaFailure("reorder", http("tenant_access_denied", 403)).message
    ).toContain("permissão");
  });

  it("says only what did not happen when the session is over (the notice says the rest)", () => {
    expect(
      describeMediaFailure("upload", http("session_required", 401)).message
    ).toBe("A foto não foi enviada.");
    // a 401 with any body is the same
    expect(describeMediaFailure("upload", http("whatever", 401)).message).toBe(
      "A foto não foi enviada."
    );
    expect(
      describeMediaFailure("remove", http("session_required", 401)).message
    ).toBe("A imagem não foi removida.");
    expect(isMediaSessionEnded(http("session_required", 401))).toBe(true);
    expect(isMediaSessionEnded(http("forbidden", 403))).toBe(false);
    expect(isMediaSessionEnded(new TypeError("Failed to fetch"))).toBe(false);
  });

  it("turns a network error into a try-again message", () => {
    for (const context of ["list", "remove", "reorder", "upload"] as const) {
      const failure = describeMediaFailure(
        context,
        new TypeError("Failed to fetch")
      );
      expect(failure.message).toContain("Sem conexão");
      expect(failure.message).toContain("tente novamente");
      expect(failure.reloadList).toBe(false);
    }
  });

  it("falls back to a message for the action, never the raw code", () => {
    const remove = describeMediaFailure(
      "remove",
      http("media_remove_failed", 500)
    );
    expect(remove.message).toBe(
      "Não foi possível remover a imagem. Tente novamente."
    );
    const reorder = describeMediaFailure(
      "reorder",
      http("invalid_media_response", 502)
    );
    expect(reorder.message).toBe(
      "Não foi possível mudar a ordem das imagens. Tente novamente."
    );
    expect(reorder.message).not.toContain("invalid_media_response");
    expect(describeMediaFailure("remove", new Error("boom")).message).toBe(
      remove.message
    );
  });

  it("keeps the existing upload messages", () => {
    expect(
      describeMediaFailure("upload", http("media_image_too_large", 413)).message
    ).toContain("20 MB");
    expect(
      describeMediaFailure("upload", http("unsupported_media_image", 415))
        .message
    ).toContain("JPEG, PNG ou WebP");
    expect(
      describeMediaFailure("upload", http("media_processing_unavailable", 503))
        .message
    ).toContain("indisponível");
    expect(
      describeMediaFailure("upload", http("something_else", 500)).message
    ).toBe("Não foi possível carregar a imagem. Tente novamente.");
  });

  it("does not treat a preparation error as a network failure", () => {
    expect(
      describeMediaFailure("prepare", new TypeError("x")).message
    ).toContain("Escolha outro arquivo");
  });
});
