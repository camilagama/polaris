import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acceptanceReturnPath,
  announceLegalAcceptance,
  isLegalAcceptancePath,
  isLegalAcceptanceRequired,
  legalAcceptancePath,
  markLegalAcceptanceRequired,
  subscribeLegalAcceptance,
} from "./legal-acceptance";

describe("legalAcceptancePath", () => {
  it("carries a valid page to come back to, with the slashes readable and the rest encoded", () => {
    expect(legalAcceptancePath("/vendas")).toBe("/aceite?voltar=/vendas");
    expect(legalAcceptancePath("/estoque/produtos")).toBe(
      "/aceite?voltar=/estoque/produtos"
    );
    expect(legalAcceptancePath("/vendas?aba=a&p=1")).toBe(
      "/aceite?voltar=/vendas%3Faba%3Da%26p%3D1"
    );
  });

  it("leaves out what is not a valid page of this app", () => {
    for (const invalid of [
      undefined,
      "",
      "https://evil.example/x",
      "//evil.example/x",
      "/\\evil.example",
      "vendas",
      "/rpc/x",
      "/entrar",
      "/aceite",
      "/aceite/",
      "/aceite?voltar=/vendas",
    ]) {
      expect(legalAcceptancePath(invalid)).toBe("/aceite");
    }
  });
});

describe("isLegalAcceptancePath", () => {
  it("is the acceptance screen, with or without a trailing slash", () => {
    expect(isLegalAcceptancePath("/aceite")).toBe(true);
    expect(isLegalAcceptancePath("/aceite/")).toBe(true);
    expect(isLegalAcceptancePath("/")).toBe(false);
    expect(isLegalAcceptancePath("/aceite/outra")).toBe(false);
    expect(isLegalAcceptancePath("/entrar")).toBe(false);
  });
});

describe("acceptanceReturnPath", () => {
  it("goes back to a valid voltar", () => {
    expect(acceptanceReturnPath("?voltar=/vendas")).toBe("/vendas");
    expect(acceptanceReturnPath("?voltar=%2Fvendas%3Faba%3Da")).toBe(
      "/vendas?aba=a"
    );
  });

  it("keeps the query and the fragment of a valid voltar", () => {
    expect(acceptanceReturnPath("?voltar=/vendas?aba=a#topo")).toBe(
      "/vendas?aba=a#topo"
    );
  });

  it("goes to the start when voltar is missing, invalid, external or the screen itself", () => {
    for (const search of [
      "",
      "?",
      "?voltar=",
      "?voltar=https://evil.example/x",
      "?voltar=//evil.example",
      "?voltar=/entrar",
      "?voltar=/aceite",
      "?voltar=/aceite?voltar=/vendas",
      "?outro=/vendas",
      "?voltar=javascript:alert(1)",
      "?voltar=data:text/html,x",
      "?voltar=/\\evil.example",
      "?voltar=\\\\evil.example",
      "?voltar=%2F%2Fevil.example",
      "?voltar=/%5Cevil.example",
      "?voltar=%20//evil.example",
      "?voltar=%0d%0a/vendas",
      "?voltar=/vendas%0d%0a",
      "?voltar=/../api/x",
    ]) {
      expect(acceptanceReturnPath(search)).toBe("/");
    }
  });
});

describe("the legal acceptance flag", () => {
  afterEach(() => {
    announceLegalAcceptance();
  });

  it("starts as not required", () => {
    expect(isLegalAcceptanceRequired()).toBe(false);
  });

  it("is set by a refusal, and tells its subscribers once", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLegalAcceptance(listener);
    markLegalAcceptanceRequired();
    expect(isLegalAcceptanceRequired()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    markLegalAcceptanceRequired(); // already set: nothing new to tell
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("is cleared by the announcement of the acceptance, and tells its subscribers", () => {
    markLegalAcceptanceRequired();
    const listener = vi.fn();
    const unsubscribe = subscribeLegalAcceptance(listener);

    announceLegalAcceptance();

    expect(isLegalAcceptanceRequired()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("stops telling a subscriber that unsubscribed", () => {
    const listener = vi.fn();
    subscribeLegalAcceptance(listener)();
    markLegalAcceptanceRequired();
    expect(listener).not.toHaveBeenCalled();
  });

  it("the announcement reaches the other tabs of the browser", async () => {
    const otherTab = new BroadcastChannel("polaris:legal-acceptance");
    const heard = new Promise((resolve) => {
      otherTab.onmessage = (event: MessageEvent) => resolve(event.data);
    });
    announceLegalAcceptance();
    await expect(heard).resolves.toBe("accepted");
    otherTab.close();
  });

  it("an acceptance announced by another tab clears the flag here", async () => {
    markLegalAcceptanceRequired();
    expect(isLegalAcceptanceRequired()).toBe(true);

    const otherTab = new BroadcastChannel("polaris:legal-acceptance");
    otherTab.postMessage("accepted");
    await vi.waitFor(() => expect(isLegalAcceptanceRequired()).toBe(false));
    otherTab.close();
  });
});
