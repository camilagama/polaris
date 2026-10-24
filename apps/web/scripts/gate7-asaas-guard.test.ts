import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EnvironmentReadings } from "../../../packages/db/scripts/environment-marker";
import {
  assertAsaasSandbox,
  assertGate7Database,
  assertGate7DatabaseUrl,
  assertSameDatabase,
  checkedLinkFile,
  cycleOf,
  Gate7RefusedError,
  refundReport,
} from "./gate7-asaas-guard";

const sandbox = {
  ASAAS_API_KEY: "$aact_hmlg_000000000000000000000000",
  ASAAS_BASE_URL: "https://api-sandbox.asaas.com/v3",
};

const markers = (readings: Partial<EnvironmentReadings>) => ({
  comment: null,
  current: null,
  stored: null,
  ...readings,
});

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

  it("accepts the database comment `polaris.environment=staging`, the marker Neon allows", () => {
    expect(() =>
      assertGate7Database(
        remote,
        markers({ comment: "polaris.environment=staging" })
      )
    ).not.toThrow();
    expect(() =>
      assertGate7Database(
        remote,
        markers({ comment: "polaris.environment=staging", current: "staging" })
      )
    ).not.toThrow();
  });

  it.each([
    ["another environment", "polaris.environment=preview"],
    ["a name that only starts like staging", "polaris.environment=staging-x"],
    ["a trailing space", "polaris.environment=staging "],
    ["a leading space", " polaris.environment=staging"],
    ["a capital letter", "polaris.environment=Staging"],
    ["a capital in the key", "Polaris.environment=staging"],
    ["a space around the equal sign", "polaris.environment = staging"],
    ["a line break", "polaris.environment=staging\n"],
    ["other text", "staging"],
    ["an empty comment", ""],
  ])("refuses a comment with %s on a remote host", (_label, comment) => {
    expect(
      refusal(() => assertGate7Database(remote, markers({ comment }))).code
    ).toBe("gate7_database_not_staging");
  });

  it("refuses a comment that says production or restore-drill, even on localhost, and when the session says staging", () => {
    for (const value of ["production", "restore-drill"]) {
      for (const url of [remote, local]) {
        expect(
          refusal(() =>
            assertGate7Database(
              url,
              markers({
                comment: `polaris.environment=${value}`,
                current: "staging",
              })
            )
          ).code
        ).toBe("gate7_database_not_staging");
      }
    }
  });

  it("refuses a comment that contradicts the stored setting, or a session that contradicts the comment", () => {
    expect(
      refusal(() =>
        assertGate7Database(
          remote,
          markers({
            comment: "polaris.environment=staging",
            stored: "preview",
          })
        )
      ).code
    ).toBe("gate7_database_not_staging");
    expect(
      refusal(() =>
        assertGate7Database(
          remote,
          markers({
            comment: "polaris.environment=staging",
            current: "preview",
          })
        )
      ).code
    ).toBe("gate7_database_not_staging");
  });

  it("accepts a local database with a comment that has nothing to do with the marker, refuses one that looks like it", () => {
    expect(() =>
      assertGate7Database(
        local,
        markers({ comment: "default administrative connection database" })
      )
    ).not.toThrow();
    expect(
      refusal(() =>
        assertGate7Database(
          local,
          markers({ comment: "polaris.environment=staging-x" })
        )
      ).code
    ).toBe("gate7_database_not_staging");
  });

  it("accepts a database marked staging", () => {
    expect(() =>
      assertGate7Database(remote, markers({ current: null, stored: "staging" }))
    ).not.toThrow();
    expect(() =>
      assertGate7Database(
        remote,
        markers({ current: "staging", stored: "staging" })
      )
    ).not.toThrow();
    expect(
      refusal(() =>
        assertGate7Database(remote, markers({ stored: " Staging " }))
      ).code
    ).toBe("gate7_database_not_staging");
  });

  it.each(["localhost", "127.0.0.1"])("accepts %s without a marker", (host) => {
    expect(() =>
      assertGate7Database(
        `postgres://postgres@${host}:5432/db`,
        markers({
          current: null,
          stored: null,
        })
      )
    ).not.toThrow();
    expect(() =>
      assertGate7Database(
        `postgres://postgres@${host}:5432/db`,
        markers({
          current: "",
          stored: "",
        })
      )
    ).not.toThrow();
  });

  it("refuses the production marker, even on localhost", () => {
    for (const url of [remote, local]) {
      expect(
        refusal(() =>
          assertGate7Database(
            url,
            markers({ current: null, stored: "production" })
          )
        ).code
      ).toBe("gate7_database_not_staging");
    }
  });

  it("refuses a remote host without a marker", () => {
    expect(
      refusal(() =>
        assertGate7Database(remote, markers({ current: null, stored: null }))
      ).code
    ).toBe("gate7_database_not_staging");
  });

  it("refuses any other marker", () => {
    expect(
      refusal(() =>
        assertGate7Database(
          remote,
          markers({ current: null, stored: "preview" })
        )
      ).code
    ).toBe("gate7_database_not_staging");
  });

  it.each([
    "mysql://root@localhost/db",
    "https://localhost/db",
    "not a url",
    "",
  ])("refuses %j, which is not a PostgreSQL URL", (url) => {
    expect(
      refusal(() =>
        assertGate7Database(url, markers({ current: null, stored: "staging" }))
      ).code
    ).toBe("gate7_database_url_invalid");
  });

  it("does not put the connection string in the error", () => {
    const error = refusal(() =>
      assertGate7Database(
        remote,
        markers({ current: null, stored: "production" })
      )
    );

    expect(error.message).not.toContain("pw");
    expect(error.message).not.toContain("neon.tech");
  });
});

describe("the database checks before connecting", () => {
  const remote = "postgresql://user:pw@ep-fake.sa-east-1.aws.neon.tech/neondb";

  it.each([
    `${remote}?host=prod.example`,
    `${remote}?hostaddr=10.0.0.1`,
    `${remote}?options=-c%20polaris.environment%3Dstaging`,
    `${remote}?service=prod`,
    `${remote}?port=6543`,
    `${remote}?database=other`,
    `${remote}?sslmode=require&user=postgres`,
  ])("refuses %s, which connects elsewhere or fakes the marker", (url) => {
    expect(refusal(() => assertGate7DatabaseUrl(url)).code).toBe(
      "gate7_database_url_invalid"
    );
  });

  it("accepts the TLS parameters of a Neon URL", () => {
    expect(() =>
      assertGate7DatabaseUrl(
        `${remote}?sslmode=require&channel_binding=require`
      )
    ).not.toThrow();
  });

  it("refuses a staging marker of the session alone, and a session that hides a protected one", () => {
    expect(
      refusal(() =>
        assertGate7Database(
          remote,
          markers({ current: "staging", stored: null })
        )
      ).code
    ).toBe("gate7_database_not_staging");
    expect(
      refusal(() =>
        assertGate7Database(
          remote,
          markers({ current: "", stored: "production" })
        )
      ).code
    ).toBe("gate7_database_not_staging");
    expect(
      refusal(() =>
        assertGate7Database(
          "postgres://postgres@localhost/db",
          markers({
            current: "",
            stored: "staging-old",
          })
        )
      ).code
    ).toBe("gate7_database_not_staging");
  });

  it("asks the tenant and the billing URLs for the same database", () => {
    const billing =
      "postgresql://billing:pw@ep-fake.sa-east-1.aws.neon.tech/neondb";
    expect(() => assertSameDatabase(remote, billing)).not.toThrow();
    expect(
      refusal(() =>
        assertSameDatabase(
          remote,
          "postgresql://billing:pw@ep-other.sa-east-1.aws.neon.tech/neondb"
        )
      ).code
    ).toBe("gate7_databases_differ");
    expect(
      refusal(() =>
        assertSameDatabase(
          remote,
          "postgresql://billing:pw@ep-fake.sa-east-1.aws.neon.tech/other"
        )
      ).code
    ).toBe("gate7_databases_differ");
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

describe("refundReport", () => {
  it("prints the renewal cancelled also when the refund found nothing to refund", () => {
    expect(refundReport("nothing_to_refund", true)).toEqual({
      refund: "nothing_to_refund",
      renovacao: "renovação cancelada",
    });
    expect(refundReport("refund_requested", true).renovacao).toBe(
      "renovação cancelada"
    );
  });

  it("says the renewal is alive when the record shows it so", () => {
    expect(refundReport("not_linked", false)).toEqual({
      refund: "not_linked",
      renovacao: "renovação ativa",
    });
  });
});
