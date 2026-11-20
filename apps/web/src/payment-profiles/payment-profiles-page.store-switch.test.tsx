// @vitest-environment happy-dom
import type { PaymentProfileReadModel } from "@polaris/contracts";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaymentProfilesPage } from "./payment-profiles-page";

interface PendingRead {
  organizationId: string;
  resolve: (value: { profiles: PaymentProfileReadModel[] }) => void;
}

const reads: PendingRead[] = [];
const formArguments: boolean[] = [];
let currentOrganizationId = "org-a";

vi.mock("../lib/current-organization", () => ({
  useCurrentOrganization: () => ({ organizationId: currentOrganizationId }),
}));
vi.mock("../lib/orpc", () => ({
  orpcClient: {
    paymentProfile: {
      list: ({ organizationId }: { organizationId: string }) =>
        new Promise((resolve) => {
          reads.push({ organizationId, resolve });
        }),
    },
  },
}));
vi.mock("../app-shell/connection-required-notice", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../app-shell/connection-required-notice")
  >()),
  useConnectionNoticeForm: (form: boolean) => {
    formArguments.push(form);
  },
}));
vi.mock("../lib/browser-connection", () => ({
  browserConnection: { probeNow: () => Promise.resolve("online") },
  useConnectionReturn: () => true,
  workerAnswers: () => Promise.resolve(true),
}));

const lastFormArgument = () => formArguments.at(-1);
const readOf = (organizationId: string) => {
  const read = reads.find((item) => item.organizationId === organizationId);
  if (!read) {
    throw new Error(`no read was started for ${organizationId}`);
  }
  return read;
};
const answer = async (organizationId: string) => {
  await act(async () => {
    readOf(organizationId).resolve({ profiles: [] });
    await Promise.resolve();
  });
};

beforeEach(() => {
  reads.length = 0;
  formArguments.length = 0;
  currentOrganizationId = "org-a";
});

afterEach(() => {
  cleanup();
});

describe("Formas de receber ao trocar de loja", () => {
  it("a lista lida de uma loja não vale para a outra: o aviso de conexão só diz que há formulário depois que a lista da loja nova é lida", async () => {
    const view = render(<PaymentProfilesPage />);
    expect(lastFormArgument()).toBe(false);

    await answer("org-a");
    expect(lastFormArgument()).toBe(true);

    currentOrganizationId = "org-b";
    view.rerender(<PaymentProfilesPage />);
    readOf("org-b");
    expect(lastFormArgument()).toBe(false);

    await answer("org-b");
    expect(lastFormArgument()).toBe(true);
  });
});
