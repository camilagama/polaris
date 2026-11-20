// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const formDeclared = vi.hoisted(() => ({ values: [] as boolean[] }));
const server = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
}));

vi.mock("../app-shell/connection-required-notice", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../app-shell/connection-required-notice")
  >()),
  useConnectionNoticeForm: (form: boolean) => {
    formDeclared.values.push(form);
  },
}));
vi.mock("../lib/browser-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/browser-connection")>()),
  useConnectionReturn: () => true,
  workerAnswers: () => Promise.resolve(false),
}));
vi.mock("../lib/current-organization", () => ({
  useCurrentOrganization: () => ({
    organization: { role: "owner", timezone: "America/Sao_Paulo" },
    organizationId: "org-a",
  }),
}));
vi.mock("../lib/orpc", () => ({
  orpcClient: {
    paymentProfile: {
      create: server.create,
      list: server.list,
    },
  },
}));
vi.mock("../lib/read-with-retry", () => ({
  readWithRetry: (read: () => Promise<unknown>) => read(),
}));
vi.mock("../app-shell/screen-title", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app-shell/screen-title")>()),
  useTabActive: () => true,
}));

const { PaymentProfilesPage } = await import("./payment-profiles-page");

const NO_ANSWER = new TypeError("Failed to fetch");
const NEW_PROFILE = { name: "Novo perfil" };
const NAME_FIELD = "Nome do perfil";
const CLOSE = { name: "Fechar" };
const CANCEL = { name: "Cancelar" };
const CREATE = { name: "Criar perfil" };
const lastDeclared = () => formDeclared.values.at(-1);

async function openAndType(name: string) {
  fireEvent.click(screen.getByRole("button", NEW_PROFILE));
  fireEvent.change(await screen.findByLabelText(NAME_FIELD), {
    target: { value: name },
  });
}

async function closeKeepingDraft() {
  fireEvent.keyDown(document.activeElement ?? document.body, {
    code: "Escape",
    key: "Escape",
  });
  await waitFor(() => expect(screen.queryByLabelText(NAME_FIELD)).toBeNull());
}

describe("a faixa sem conexão de Formas de receber e o rascunho guardado", () => {
  beforeEach(() => {
    formDeclared.values.length = 0;
    server.list.mockReset();
    server.create.mockReset();
    server.list.mockRejectedValue(NO_ANSWER);
  });
  afterEach(cleanup);

  it("sem lista lida e sem rascunho, a tela não declara formulário", async () => {
    render(<PaymentProfilesPage />);
    await waitFor(() => expect(server.list).toHaveBeenCalled());
    await act(async () => undefined);
    expect(lastDeclared()).toBe(false);
  });

  it("fechar com rascunho guardado passa a declarar formulário, e descartar desfaz", async () => {
    render(<PaymentProfilesPage />);
    await waitFor(() => expect(server.list).toHaveBeenCalled());
    await openAndType("Link de pagamento");
    expect(lastDeclared()).toBe(false);

    await closeKeepingDraft();
    expect(lastDeclared()).toBe(true);

    fireEvent.click(screen.getByRole("button", NEW_PROFILE));
    expect(
      ((await screen.findByLabelText(NAME_FIELD)) as HTMLInputElement).value
    ).toBe("Link de pagamento");
    expect(lastDeclared()).toBe(false);

    fireEvent.click(screen.getByRole("button", CANCEL));
    await waitFor(() => expect(screen.queryByLabelText(NAME_FIELD)).toBeNull());
    expect(lastDeclared()).toBe(false);
  });

  it("fechar com rascunho guardado e salvar depois volta a não declarar formulário", async () => {
    server.create.mockResolvedValue({});
    render(<PaymentProfilesPage />);
    await waitFor(() => expect(server.list).toHaveBeenCalled());
    await openAndType("Link de pagamento");
    await closeKeepingDraft();
    expect(lastDeclared()).toBe(true);

    fireEvent.click(screen.getByRole("button", NEW_PROFILE));
    await screen.findByLabelText(NAME_FIELD);
    fireEvent.click(screen.getByRole("button", CREATE));
    await waitFor(() => expect(server.create).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByLabelText(NAME_FIELD)).toBeNull());
    expect(lastDeclared()).toBe(false);
  });

  it("fechar o formulário sem digitar nada não declara formulário", async () => {
    render(<PaymentProfilesPage />);
    await waitFor(() => expect(server.list).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", NEW_PROFILE));
    await screen.findByLabelText(NAME_FIELD);
    await closeKeepingDraft();
    expect(lastDeclared()).toBe(false);
  });

  it("o botão Fechar também guarda o rascunho", async () => {
    render(<PaymentProfilesPage />);
    await waitFor(() => expect(server.list).toHaveBeenCalled());
    await openAndType("Link de pagamento");
    fireEvent.click(screen.getAllByRole("button", CLOSE)[0] as HTMLElement);
    await waitFor(() => expect(screen.queryByLabelText(NAME_FIELD)).toBeNull());
    expect(lastDeclared()).toBe(true);
  });
});
