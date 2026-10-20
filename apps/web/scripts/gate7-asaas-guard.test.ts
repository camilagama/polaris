import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertAsaasSandbox,
  assertGate7Database,
  checkedLinkFile,
  cycleOf,
  Gate7RefusedError,
} from "./gate7-asaas-guard";

const sandbox = {
  ASAAS_API_KEY: "$aact_hmlg_000000000000000000000000",
  ASAAS_BASE_URL: "https://api-sandbox.asaas.com/v3",
};

function refusal(action: () => void): Gate7RefusedError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(Gate7RefusedError);
    return error as Gate7RefusedError;
  }
  throw new Error("expected the guard to refuse");
}

describe("assertAsaasSandbox", () => {
  it("accepts a homologation key with the sandbox host", () => {
    expect(() => assertAsaasSandbox(sandbox)).not.toThrow();
  });

  it.each([
    ["an empty key (the `$` was expanded by the shell)", ""],
    ["a missing key", undefined],
    ["a production key", "$aact_prod_000000000000000000000000"],
    ["a key without its `$`", "aact_hmlg_000000000000000000000000"],
  ])("refuses %s, and the error never holds the key", (_label, key) => {
    const error = refusal(() =>
      assertAsaasSandbox({ ...sandbox, ASAAS_API_KEY: key })
    );

    expect(error.code).toBe("gate7_sandbox_key_required");
    expect(`${error.message} ${error.code} ${error.name}`).not.toContain(
      "aact_"
    );
  });

  it.each([
    ["the production host", "https://api.asaas.com/v3"],
    ["http", "http://api-sandbox.asaas.com/v3"],
    [
      "a host that only ends like the sandbox",
      "https://api-sandbox.asaas.com.evil.test/v3",
    ],
    [
      "a host that only starts like the sandbox",
      "https://evil.test/api-sandbox.asaas.com",
    ],
    ["a missing URL", undefined],
    ["something that is not a URL", "api-sandbox.asaas.com"],
  ])("refuses %s", (_label, baseUrl) => {
    const error = refusal(() =>
      assertAsaasSandbox({ ...sandbox, ASAAS_BASE_URL: baseUrl })
    );

    expect(error.code).toBe("gate7_sandbox_url_required");
  });

  it("never puts a refused production key in the error", () => {
    const key = "$aact_prod_SECRETVALUE";

    const error = refusal(() =>
      assertAsaasSandbox({ ...sandbox, ASAAS_API_KEY: key })
    );

    expect(
      JSON.stringify({ code: error.code, message: error.message })
    ).not.toContain("SECRETVALUE");
  });
});

describe("assertGate7Database", () => {
  const remote = "postgresql://user:pw@ep-fake.sa-east-1.aws.neon.tech/neondb";
  const local = "postgresql://postgres@localhost:5432/polaris_gate";

  it("accepts a database marked staging", () => {
    expect(() => assertGate7Database(remote, "staging")).not.toThrow();
    expect(() => assertGate7Database(remote, " Staging ")).not.toThrow();
  });

  it.each(["localhost", "127.0.0.1"])("accepts %s without a marker", (host) => {
    expect(() =>
      assertGate7Database(`postgres://postgres@${host}:5432/db`, null)
    ).not.toThrow();
    expect(() =>
      assertGate7Database(`postgres://postgres@${host}:5432/db`, "")
    ).not.toThrow();
  });

  it("refuses the production marker, even on localhost", () => {
    for (const url of [remote, local]) {
      expect(refusal(() => assertGate7Database(url, "production")).code).toBe(
        "gate7_database_not_staging"
      );
    }
  });

  it("refuses a remote host without a marker", () => {
    expect(refusal(() => assertGate7Database(remote, null)).code).toBe(
      "gate7_database_not_staging"
    );
  });

  it("refuses any other marker", () => {
    expect(refusal(() => assertGate7Database(remote, "preview")).code).toBe(
      "gate7_database_not_staging"
    );
  });

  it.each([
    "mysql://root@localhost/db",
    "https://localhost/db",
    "not a url",
    "",
  ])("refuses %j, which is not a PostgreSQL URL", (url) => {
    expect(refusal(() => assertGate7Database(url, "staging")).code).toBe(
      "gate7_database_url_invalid"
    );
  });

  it("does not put the connection string in the error", () => {
    const error = refusal(() => assertGate7Database(remote, "production"));

    expect(error.message).not.toContain("pw");
    expect(error.message).not.toContain("neon.tech");
  });
});

describe("checkedLinkFile", () => {
  const root = "/home/dev/wt/polaris";

  it("accepts an absolute path outside the repository", () => {
    expect(checkedLinkFile("/home/dev/tasks/link.txt", root)).toBe(
      "/home/dev/tasks/link.txt"
    );
  });

  it("accepts a sibling whose name only starts like the repository's", () => {
    expect(checkedLinkFile(`${root}-other/link.txt`, root)).toBe(
      `${root}-other/link.txt`
    );
  });

  it("refuses a relative path", () => {
    expect(refusal(() => checkedLinkFile("link.txt", root)).code).toBe(
      "gate7_link_file_must_be_absolute"
    );
  });

  it.each([
    join(root, "link.txt"),
    join(root, "deep/er/link.txt"),
    `${root}/a/../link.txt`,
    `${root}/../polaris/link.txt`,
  ])("refuses %s, inside the repository", (path) => {
    expect(refusal(() => checkedLinkFile(path, root)).code).toBe(
      "gate7_link_file_inside_repository"
    );
  });

  it("refuses the repository root itself", () => {
    expect(refusal(() => checkedLinkFile(root, root)).code).toBe(
      "gate7_link_file_inside_repository"
    );
  });

  it("refuses a file inside the repository whose name starts with two dots", () => {
    expect(
      refusal(() => checkedLinkFile(`${root}/..link.txt`, root)).code
    ).toBe("gate7_link_file_inside_repository");
  });
});

describe("cycleOf", () => {
  it.each([
    ["1", 1],
    ["6", 6],
    ["12", 12],
  ])("reads %s as the cycle %i", (value, cycle) => {
    expect(cycleOf(value)).toBe(cycle);
  });

  it.each([undefined, "", "3", "01", "12 ", "abc", "1.0"])(
    "refuses %j",
    (value) => {
      expect(refusal(() => cycleOf(value)).code).toBe("gate7_cycle_invalid");
    }
  );
});
