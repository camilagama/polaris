import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { describe, expect, it } from "vitest";
import { formatShortInstant } from "../lib/format";
import { signOfflineLease } from "../lib/offline-lease-token";
import {
  type AttentionItem,
  buildAttention,
  discardAttentionItem,
  discardWarning,
  resubmitAttentionItem,
} from "./attention";
import { createOfflineCustomer } from "./customer-create";
import { updateOfflineCustomer } from "./customer-update";
import { MemoryOutboxStorage } from "./outbox/memory-storage";
import { Outbox } from "./outbox/outbox";
import { createOfflineProduct } from "./product-create";
import { createOfflineSale } from "./sale-confirm";
import { countStockOffline, receiveStockOffline } from "./stock-commands";
import { FakeWriter } from "./test-support";

const SALE_TITLE = /^Venda de R\$ 20,00 · \d{2}\/\d{2} \d{2}:\d{2}$/;
const key = { id: "k1", secret: "s".repeat(40) };
const userId = "user-1";
const organizationId = "org-1";
const deviceId = "0199c2d0-0000-7000-8000-0000000000d1";
const variantId = "0199c2d0-0000-7000-8000-0000000000b2";
const productId = "0199c2d0-0000-7000-8000-0000000000f1";
const now = new Date("2026-10-14T12:30:00.000Z");
const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

async function setup() {
  const lease = await signOfflineLease(
    buildOfflineLeaseClaims({
      capabilities: ["sale:create", "inventory:adjust"],
      deviceId,
      epoch: 0,
      expiresAt: new Date(now.getTime() + 24 * 3_600_000),
      grantId: uuid(900),
      issuedAt: new Date(now.getTime() - 3_600_000),
      organizationId,
      userId,
    }),
    key
  );
  const outbox = new Outbox({
    deviceId,
    now: () => now,
    organizationId,
    storage: new MemoryOutboxStorage(),
    userId,
  });
  const writer = new FakeWriter();
  await writer.upsert("variants", [
    {
      id: variantId,
      isDefault: true,
      listPrice: "10.00",
      position: null,
      productId,
      sku: null,
      values: [],
    },
  ]);
  await writer.upsert("inventory", [
    {
      productId,
      quantity: 5,
      updatedAt: now.toISOString(),
      variantId,
      version: 1,
    },
  ]);
  let counter = 0;
  const id = () => {
    counter += 1;
    return uuid(100 + counter);
  };
  const refuse = async (commandId: string, code: string) => {
    await outbox.markSending(commandId);
    await outbox.reject(commandId, code);
  };
  const common = {
    deviceId,
    lease,
    newCommandId: id,
    now: () => now,
    organizationId,
    outbox,
    writer,
  };
  const sale = async () =>
    (
      await createOfflineSale({
        ...common,
        lines: [{ quantity: 2, variantId }],
        payment: { method: "pix" },
        reader: writer,
      })
    ).command;
  const product = async (name: string, sku?: string) =>
    (
      await createOfflineProduct({
        ...common,
        input: { name, sku: sku ?? null },
        newProductId: () => uuid(300 + counter),
        newVariantId: () => uuid(400 + counter),
      })
    ).command;
  const customer = async (name: string) =>
    (
      await createOfflineCustomer({
        ...common,
        input: { name, phone: "1" },
        newCustomerId: () => uuid(500 + counter),
      })
    ).command;
  const customerEdit = async (name: string) =>
    await updateOfflineCustomer({
      current: { id: uuid(700), version: 3 },
      deviceId,
      input: { name, phone: "1" },
      lease,
      newCommandId: id,
      organizationId,
      outbox,
    });
  const stockBase = {
    ...common,
    occurredOn: "2026-10-14",
    reader: writer,
    variantId,
  };
  return {
    customer,
    customerEdit,
    id,
    lease,
    outbox,
    product,
    refuse,
    sale,
    stockBase,
    writer,
  };
}

const itemOf = async (outbox: Outbox, index = 0) =>
  buildAttention(await outbox.snapshot()).items[index] as AttentionItem;

describe("the attention summary", () => {
  it("is empty when nothing was refused, and pending commands alone are not attention", async () => {
    const { outbox, sale } = await setup();
    await sale();
    expect(buildAttention(await outbox.snapshot())).toEqual({
      items: [],
      waitingBehind: 0,
    });
  });

  it("explains a sale refused for stock, offers resubmit and discard, and counts what waits behind", async () => {
    const { outbox, refuse, sale } = await setup();
    const refused = await sale();
    await sale();
    await refuse(refused.commandId, "insufficient_stock");

    const summary = buildAttention(await outbox.snapshot());

    expect(summary.waitingBehind).toBe(1);
    expect(summary.items).toHaveLength(1);
    expect(summary.items[0]).toMatchObject({
      actions: ["resubmit", "discard"],
      blocksQueue: true,
      cause: "insufficient_stock",
      code: "insufficient_stock",
      commandId: refused.commandId,
      kind: "sale",
      title: `Venda de R$ 20,00 · ${formatShortInstant(now.toISOString())}`,
    });
    expect(summary.items[0]?.detail).toBe(
      "O estoque do servidor não cobre esta venda: o saldo mudou enquanto este aparelho estava sem rede. Receba o que falta e toque em Reenviar venda, ou descarte se a venda não aconteceu."
    );
  });

  it("covers the causes of the plan, each with its own words and actions", async () => {
    const { outbox, product, refuse, stockBase } = await setup();
    const cases: [string, string, string[]][] = [
      ["inventory_version_conflict", "version_conflict", ["discard"]],
      ["sku_conflict", "sku_conflict", ["discard"]],
      [
        "entitlement_changed",
        "entitlement_changed",
        ["open_subscription", "retry"],
      ],
      ["session_changed", "session_changed", ["sign_in_again", "retry"]],
      [
        "authorization_revoked",
        "authorization_revoked",
        ["sign_in_again", "discard"],
      ],
      ["lease_invalid", "authorization_revoked", ["sign_in_again", "discard"]],
      ["command_too_old", "command_too_old", ["discard"]],
      ["something_new", "other", ["discard"]],
    ];
    const details = new Set<string>();
    const queue = async (code: string) => {
      if (code !== "inventory_version_conflict") {
        return await product(`P ${code}`, code);
      }
      const counted = await countStockOffline({
        ...stockBase,
        newCommandId: () => crypto.randomUUID(),
        physicalQuantity: 3,
      });
      return counted.command;
    };
    for (const [code, cause, actions] of cases) {
      // biome-ignore lint/performance/noAwaitInLoops: one refused command at a time
      const queued = await queue(code);
      await refuse(queued.commandId, code);
      const item = await itemOf(outbox, 0);
      expect({ actions: item.actions, cause: item.cause }).toEqual({
        actions,
        cause,
      });
      details.add(item.detail);
      await outbox.discard(queued.commandId);
    }
    expect(details.size).toBeGreaterThanOrEqual(5);
  });

  it("never offers anything that forces the sync, and resubmit only for a sale that can recover", async () => {
    const { outbox, product, refuse, sale } = await setup();
    const tooOld = await sale();
    await refuse(tooOld.commandId, "sale_occurred_too_old");
    expect((await itemOf(outbox)).actions).toEqual(["discard"]);
    await outbox.discard(tooOld.commandId);

    const dup = await product("Camiseta", "CAM");
    await refuse(dup.commandId, "sku_conflict");
    const item = await itemOf(outbox);
    expect(item.actions).not.toContain("resubmit");
    const { items } = buildAttention(await outbox.snapshot());
    for (const shown of items) {
      expect(JSON.stringify(shown).toLowerCase()).not.toContain("forc");
    }
  });

  it("titles stock movements and customers by what they are", async () => {
    const { outbox, customer, refuse, stockBase } = await setup();
    const received = await receiveStockOffline({
      ...stockBase,
      newCommandId: () => crypto.randomUUID(),
      quantity: 7,
      unitCost: "1",
    });
    await refuse(received.command.commandId, "variant_not_found");
    expect((await itemOf(outbox)).title).toBe("Entrada de estoque: 7");
    await outbox.discard(received.command.commandId);
    const ana = await customer("Ana");
    await refuse(ana.commandId, "customer_id_conflict");
    expect((await itemOf(outbox)).title).toBe("Cliente Ana");
    expect((await itemOf(outbox)).cause).toBe("id_conflict");
  });
});

describe("resolving an item", () => {
  it("discards a refused customer with its local row, a product with its rows, and a stock movement", async () => {
    const { customer, outbox, product, refuse, stockBase, writer } =
      await setup();
    const ana = await customer("Ana");
    const camisa = await product("Camisa", "CAM");
    const received = (
      await receiveStockOffline({
        ...stockBase,
        newCommandId: () => crypto.randomUUID(),
        quantity: 1,
        unitCost: "1",
      })
    ).command;
    await refuse(ana.commandId, "customer_id_conflict");
    expect(writer.data.customers.size).toBe(1);
    await discardAttentionItem(await itemOf(outbox), { outbox, writer });
    expect(writer.data.customers.size).toBe(0);

    await refuse(camisa.commandId, "sku_conflict");
    await discardAttentionItem(await itemOf(outbox), { outbox, writer });
    expect(writer.data.products.size).toBe(0);

    await refuse(received.commandId, "variant_not_found");
    await discardAttentionItem(await itemOf(outbox), { outbox, writer });
    expect((await outbox.snapshot()).commands).toEqual([]);
  });

  it("resubmits a refused sale as a new command and refuses actions the item does not offer", async () => {
    const { lease, outbox, refuse, sale, writer } = await setup();
    const refused = await sale();
    await refuse(refused.commandId, "insufficient_stock");
    const item = await itemOf(outbox);

    await resubmitAttentionItem(item, { lease, outbox });

    const after = await outbox.snapshot();
    expect(after.commands).toHaveLength(1);
    expect(after.commands[0]?.commandId).not.toBe(refused.commandId);
    expect(after.commands[0]?.status).toBe("pending");

    const account = { ...item, actions: ["sign_in_again" as const] };
    await expect(
      discardAttentionItem(account, { outbox, writer })
    ).rejects.toThrow("action_not_available");
    await expect(
      resubmitAttentionItem(account, { lease, outbox })
    ).rejects.toThrow("action_not_available");
  });

  it("sends the very same command again after a refusal that was only about the plan", async () => {
    const { lease, outbox, refuse, sale } = await setup();
    const refused = await sale();
    await refuse(refused.commandId, "entitlement_changed");
    const item = await itemOf(outbox);
    expect(item.actions).toContain("retry");

    await resubmitAttentionItem(item, { lease, outbox });

    const after = await outbox.snapshot();
    expect(after.commands).toHaveLength(1);
    expect(after.commands[0]?.commandId).toBe(refused.commandId);
    expect(after.commands[0]?.status).toBe("pending");
    expect(after.commands[0]?.rejection).toBeNull();
  });

  it("keeps the command, with the same ID, after another account's session sent it", async () => {
    const { lease, outbox, refuse, sale } = await setup();
    const refused = await sale();
    await refuse(refused.commandId, "session_changed");
    const item = await itemOf(outbox);
    expect(item.cause).toBe("session_changed");
    expect(item.actions).toEqual(["sign_in_again", "retry"]);
    expect(item.actions).not.toContain("discard");

    await resubmitAttentionItem(item, { lease, outbox });

    const after = await outbox.snapshot();
    expect(after.commands).toHaveLength(1);
    expect(after.commands[0]?.commandId).toBe(refused.commandId);
    expect(after.commands[0]?.status).toBe("pending");
  });

  it("says a sale refused as authorization_revoked is not sent by itself, and never says the access may come back", async () => {
    const { outbox, refuse, sale } = await setup();
    const refused = await sale();
    await refuse(refused.commandId, "authorization_revoked");

    const item = await itemOf(outbox);

    expect(item.title).toBe(
      `Venda de R$ 20,00 · ${formatShortInstant(now.toISOString())}`
    );
    expect(item.detail).toBe(
      "O servidor recusou esta venda porque a permissão deste aparelho mudou. Ela não é enviada sozinha. Se a venda aconteceu, toque em Refazer esta venda e, depois de confirmar a nova, descarte esta. Se o seu acesso mudou, use Sair e entrar de novo."
    );
    expect(item.detail).not.toContain("não o recebeu");
    expect(item.detail).not.toContain("se o acesso não voltar");
    expect(item.actions).toEqual(["redo_sale", "sign_in_again", "discard"]);
    expect(item.redone).toBe(false);
    expect(item.detail).not.toContain("registre a venda de novo e depois");
  });

  it("offers only the discard of the refused sale, said as such, once the new sale exists", async () => {
    const { outbox, refuse, sale } = await setup();
    const refused = await sale();
    await refuse(refused.commandId, "authorization_revoked");

    const [item] = buildAttention(
      await outbox.snapshot(),
      new Set([refused.commandId])
    ).items;

    expect(item?.redone).toBe(true);
    expect(item?.actions).toEqual(["discard"]);
    expect(item?.detail).toContain("Você já refez esta venda");
    expect(discardWarning(item as AttentionItem)).toContain(
      "A venda refeita já está registrada ou guardada e não muda"
    );
  });

  it("offers no redo for a sale refused for another account code, nor for a product", async () => {
    const { outbox, product, refuse, sale } = await setup();
    const wrong = await sale();
    await refuse(wrong.commandId, "wrong_device");
    expect((await itemOf(outbox)).actions).toEqual([
      "sign_in_again",
      "discard",
    ]);
    await outbox.discard(wrong.commandId);

    const queued = await product("Camiseta", "CAM");
    await refuse(queued.commandId, "authorization_revoked");
    expect((await itemOf(outbox)).actions).toEqual([
      "sign_in_again",
      "discard",
    ]);
  });

  it("tells, before a discard of a sale refused for authorization, to redo it first", () => {
    const base: AttentionItem = {
      actions: ["redo_sale", "discard"],
      blocksQueue: true,
      cause: "authorization_revoked",
      code: "authorization_revoked",
      commandId: uuid(1),
      detail: "",
      kind: "sale",
      redone: false,
      title: "",
    };
    expect(discardWarning(base)).toContain("use Refazer esta venda antes");
    expect(discardWarning({ ...base, code: "wrong_device" })).not.toContain(
      "Refazer"
    );
  });

  it("keeps the words about the access coming back for the other account codes, and sends them to sign in again", async () => {
    const { outbox, refuse, sale } = await setup();
    const wrong = await sale();
    await refuse(wrong.commandId, "wrong_device");
    const item = await itemOf(outbox);
    expect(item.detail).toContain("se o acesso não voltar");
    expect(item.detail).toContain("Sair e entrar de novo");
  });

  it("titles every refused sale with its value and moment, so two of them are told apart", async () => {
    const { outbox, refuse, sale } = await setup();
    const first = await sale();
    const second = await sale();
    await refuse(first.commandId, "sale_occurred_too_old");
    await outbox.markSending(second.commandId);
    await outbox.reject(second.commandId, "insufficient_stock");
    const [one, two] = buildAttention(await outbox.snapshot()).items;
    const expected = `Venda de R$ 20,00 · ${formatShortInstant(now.toISOString())}`;
    expect([one?.title, two?.title]).toEqual([expected, expected]);
    expect(expected).toMatch(SALE_TITLE);
  });

  it("falls back to the count of items when the sale cannot be priced", async () => {
    const { outbox, refuse, sale } = await setup();
    const refused = await sale();
    await refuse(refused.commandId, "insufficient_stock");
    const snapshot = await outbox.snapshot();
    const unpriced = {
      ...snapshot,
      commands: snapshot.commands.map((command) => ({
        ...command,
        payload: {
          ...(command.payload as object),
          items: [{ quantity: "x", unitPrice: "y" }],
        },
      })),
    };
    expect(buildAttention(unpriced).items[0]?.title).toBe(
      `Venda de 1 item · ${formatShortInstant(now.toISOString())}`
    );
  });

  it("says a refused non-sale as redo-it", async () => {
    const { outbox, product, refuse } = await setup();
    const queued = await product("Camiseta", "CAM");
    await refuse(queued.commandId, "authorization_revoked");
    const item = await itemOf(outbox);
    expect(item.detail).toBe(
      "O servidor recusou este registro: a permissão deste aparelho mudou depois que ele foi feito (por exemplo, a loja foi encerrada e reaberta). Ele não é enviado sozinho. Se ainda valer, anote o que ele tinha, descarte este e faça o registro de novo. Se o seu acesso mudou, use Sair e entrar de novo."
    );
  });

  it("says what a discard loses, per kind", () => {
    const base = {
      actions: ["discard"],
      blocksQueue: true,
      cause: "other",
      code: "x",
      commandId: uuid(1),
      detail: "",
      redone: false,
      title: "",
    } as const;
    for (const kind of [
      "sale",
      "product",
      "customer",
      "customer_update",
      "stock",
    ] as const) {
      expect(discardWarning({ ...base, actions: ["discard"], kind })).toContain(
        "apagad"
      );
    }
  });
});

describe("a customer edit that the server refused", () => {
  it("says the customer changed elsewhere and offers only to discard, changing no local row", async () => {
    const { customerEdit, outbox, refuse, writer } = await setup();
    const edit = await customerEdit("Ana Lima");
    await refuse(edit.commandId, "customer_version_conflict");
    const item = await itemOf(outbox);

    expect(item).toMatchObject({
      actions: ["discard"],
      cause: "version_conflict",
      code: "customer_version_conflict",
      kind: "customer_update",
      title: "Alteração do cliente Ana Lima",
    });
    expect(item.detail).toContain("nada foi sobrescrito");
    expect(item.detail).not.toContain("saldo");
    expect(discardWarning(item)).toContain("cadastro continua");

    await discardAttentionItem(item, { outbox, writer });
    expect((await outbox.snapshot()).commands).toEqual([]);
  });

  it("says the customer no longer exists", async () => {
    const { customerEdit, outbox, refuse } = await setup();
    await refuse((await customerEdit("Ana")).commandId, "customer_not_found");
    const item = await itemOf(outbox);
    expect(item.cause).toBe("unavailable");
    expect(item.detail).toContain("não existe mais");
  });
});

describe("a sale refused for its payment profile", () => {
  it.each([
    ["payment_profile_changed", "profile_changed"],
    ["payment_profile_unavailable", "profile_unavailable"],
  ])(
    "%s offers resubmit without the profile and discard, never a plain resubmit",
    async (code, cause) => {
      const { lease, outbox, refuse, sale } = await setup();
      const refused = await sale();
      await refuse(refused.commandId, code);
      const item = await itemOf(outbox);

      expect(item.cause).toBe(cause);
      expect(item.actions).toEqual(["resubmit_without_profile", "discard"]);
      expect(item.detail).toContain("sem perfil de pagamento");

      await resubmitAttentionItem(item, { lease, outbox });
      const after = await outbox.snapshot();
      expect(after.commands).toHaveLength(1);
      expect(after.commands[0]?.commandId).not.toBe(refused.commandId);
      expect(after.commands[0]?.status).toBe("pending");
      expect(after.commands[0]?.payload).not.toHaveProperty("paymentProfile");
    }
  );
});
