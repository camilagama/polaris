import {
  MAX_PRODUCT_MEDIA,
  ProductMediaLimitError,
} from "@polaris/domain/catalog/media";
import { describe, expect, it, vi } from "vitest";
import {
  assertProductCanReceiveMedia,
  createProductMediaAsset,
} from "./media-repository";
import type {
  TenantRequestIdentity,
  TenantRequestTransaction,
} from "./tenant-transaction";

// The plan limits have their own gate against a real database; here the scripted
// transaction only answers the technical ceiling.
vi.mock("./entitlement-enforcement", () => ({
  assertRoomFor: () => Promise.resolve(),
}));

const identity: TenantRequestIdentity = {
  capability: "product:update",
  organizationId: "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0",
  role: "owner",
  userId: "user-1",
};
const productId = "0199c2d0-0000-7000-8000-000000000001";

/** Answers each `select()` with the next scripted result, in call order. */
function scriptedTransaction(results: unknown[][]) {
  const insert = vi.fn();
  const select = vi.fn(() => {
    const result = results.shift() ?? [];
    const builder: Record<string, unknown> = {};
    for (const method of ["from", "innerJoin", "where", "limit", "for"]) {
      builder[method] = () => builder;
    }
    // biome-ignore lint/suspicious/noThenProperty: awaitable stand-in for a Drizzle query builder.
    builder.then = (
      resolve: (value: unknown[]) => unknown,
      reject: (reason: unknown) => unknown
    ) => Promise.resolve(result).then(resolve, reject);
    return builder;
  });

  return {
    insert,
    transaction: { insert, select } as unknown as TenantRequestTransaction,
  };
}

const uploadInput = {
  byteSize: 4,
  height: 200,
  inputFingerprint: "fingerprint",
  productId,
  storageKey: "media/key",
  uploadCommandId: "de305d54-75b4-431b-adb2-eb6b9e546014",
  variantIds: [],
  width: 600,
};

describe("product media ceiling", () => {
  it("refuses an upload at the ceiling before inserting anything", async () => {
    const { insert, transaction } = scriptedTransaction([
      [], // no earlier command with this id
      [{ deletedAt: null }], // product row under FOR UPDATE
      [], // still no committed command after the lock wait
      [{ total: MAX_PRODUCT_MEDIA }],
    ]);

    await expect(
      createProductMediaAsset(transaction, identity, uploadInput)
    ).rejects.toBeInstanceOf(ProductMediaLimitError);
    expect(insert).not.toHaveBeenCalled();
  });

  it("refuses the preflight at the ceiling and accepts one below it", async () => {
    const full = scriptedTransaction([
      [{ deletedAt: null }],
      [{ total: MAX_PRODUCT_MEDIA }],
    ]);
    await expect(
      assertProductCanReceiveMedia(
        full.transaction,
        identity.organizationId,
        productId
      )
    ).rejects.toMatchObject({ code: "product_media_limit" });

    const roomLeft = scriptedTransaction([
      [{ deletedAt: null }],
      [{ total: MAX_PRODUCT_MEDIA - 1 }],
    ]);
    await expect(
      assertProductCanReceiveMedia(
        roomLeft.transaction,
        identity.organizationId,
        productId
      )
    ).resolves.toBeUndefined();
  });
});
