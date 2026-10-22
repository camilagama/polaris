import { createServer, type Server } from "node:net";
import type { Client } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { disposableHostPattern, isAllowedGateHost } from "./gate-hosts";
import {
  assertDisposableEnvironment,
  connectToGateTarget,
  validateGateTarget,
} from "./gate-target";

const branch = "pr0-ci-gate";
const database = "polaris_gate";
const neonDirect = "ep-cool-wave-a5b6c7d8.c-2.sa-east-1.aws.neon.tech";
const refused = /direct disposable Neon endpoint/;
const protectedRefusal = /protected environment/;

const urlFor = (host: string, port = 5432) =>
  `postgresql://owner:secret@${host}:${port}/${database}`;

describe("the list of hosts a gate may connect to", () => {
  it("allows a direct Neon endpoint in São Paulo, in CI or not", () => {
    expect(isAllowedGateHost(neonDirect, true)).toBe(true);
    expect(isAllowedGateHost(neonDirect, false)).toBe(true);
  });

  it("allows the local Postgres only inside CI", () => {
    for (const host of ["localhost", "127.0.0.1"]) {
      expect(isAllowedGateHost(host, true)).toBe(true);
      expect(isAllowedGateHost(host, false)).toBe(false);
    }
  });

  it("refuses everything else", () => {
    for (const host of [
      "ep-cool-wave-a5b6c7d8-pooler.c-2.sa-east-1.aws.neon.tech",
      "ep-cool-wave-a5b6c7d8.c-2.us-east-2.aws.neon.tech",
      "ep-cool-wave-a5b6c7d8.c-2.sa-east-1.aws.neon.tech.evil.example",
      "evil.example/ep-a.c-2.sa-east-1.aws.neon.tech",
      "localhost.evil.example",
      "postgres",
      "db.internal.example",
      "10.0.0.5",
      "",
    ]) {
      expect(isAllowedGateHost(host, true), host).toBe(false);
    }
  });
});

describe("the pattern form of the list", () => {
  it("says the same as the function for the hosts the gates see", () => {
    for (const host of [
      neonDirect,
      "ep-cool-wave-a5b6c7d8-pooler.c-2.sa-east-1.aws.neon.tech",
      "localhost",
      "127.0.0.1",
      "postgres",
      "db.example.com",
    ]) {
      expect(disposableHostPattern.test(host), host).toBe(
        isAllowedGateHost(host, process.env.CI === "true")
      );
    }
  });
});

describe("validateGateTarget", () => {
  it("accepts the CI service and a disposable Neon endpoint", () => {
    expect(
      validateGateTarget({
        branch,
        ci: true,
        database,
        url: urlFor("localhost"),
      }).hostname
    ).toBe("localhost");
    expect(
      validateGateTarget({
        branch,
        ci: false,
        database,
        url: urlFor(neonDirect),
      }).hostname
    ).toBe(neonDirect);
  });

  it("refuses a URL that names an allowed host and connects to another", () => {
    for (const url of [
      `postgresql://owner:secret@localhost:5432/${database}?host=db.example.com`,
      `postgresql://owner:secret@localhost:5432/${database}?hostaddr=10.0.0.5`,
      `postgresql://owner:secret@${neonDirect}/${database}?host=db.example.com`,
      `socket://owner:secret@localhost/${database}`,
      "/var/run/postgresql polaris_gate",
    ]) {
      expect(() =>
        validateGateTarget({ branch, ci: true, database, url })
      ).toThrow();
    }
  });

  it("refuses a host outside the list, a wrong database and a wrong branch", () => {
    expect(() =>
      validateGateTarget({
        branch,
        ci: true,
        database,
        url: urlFor("db.example.com"),
      })
    ).toThrow(refused);
    expect(() =>
      validateGateTarget({
        branch,
        ci: true,
        database: "other",
        url: urlFor("localhost"),
      })
    ).toThrow("does not match");
    expect(() =>
      validateGateTarget({
        branch: "main",
        ci: true,
        database,
        url: urlFor("localhost"),
      })
    ).toThrow("POLARIS_GATE_BRANCH");
  });
});

describe("connectToGateTarget", () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (server) {
        server.close(() => resolve());
      } else {
        resolve();
      }
    });
    server = undefined;
  });

  /** A TCP listener that counts connections and hangs up on each one. */
  async function listen(): Promise<{
    connections: () => number;
    port: number;
  }> {
    let count = 0;
    const listener = createServer((socket) => {
      count += 1;
      socket.destroy();
    });
    server = listener;
    await new Promise<void>((resolve) =>
      listener.listen(0, "127.0.0.1", resolve)
    );
    const address = listener.address();
    if (address === null || typeof address === "string") {
      throw new Error("no port");
    }
    return { connections: () => count, port: address.port };
  }

  it("opens no connection to a host outside the list", async () => {
    const { connections, port } = await listen();
    // 127.0.0.1 is the listener, but outside CI it is not on the list
    await expect(
      connectToGateTarget({
        branch,
        ci: false,
        database,
        url: urlFor("127.0.0.1", port),
      })
    ).rejects.toThrow(refused);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(connections()).toBe(0);
  });

  it("does open one to a host on the list (the listener sees it)", async () => {
    const { connections, port } = await listen();
    await expect(
      connectToGateTarget({
        branch,
        ci: true,
        database,
        url: urlFor("127.0.0.1", port),
      })
    ).rejects.not.toThrow(refused);
    expect(connections()).toBe(1);
  });
});

describe("the environment marker of the target", () => {
  /** A client that answers the marker query with the given values and records its calls. */
  function fakeClient(
    current: string | null,
    stored: string | null = null,
    comment: string | null = null
  ) {
    const calls: string[] = [];
    const client = {
      connect: () => {
        calls.push("connect");
        return Promise.resolve();
      },
      end: () => {
        calls.push("end");
        return Promise.resolve();
      },
      query: (sql: string) => {
        calls.push(sql.includes("polaris.environment") ? "marker" : "other");
        return Promise.resolve({ rows: [{ comment, current, stored }] });
      },
    };
    return { calls, client: client as unknown as Client };
  }

  const target = { branch, ci: true, database, url: urlFor("localhost") };

  for (const value of ["production", "staging", "restore-drill"]) {
    it(`refuses a database marked '${value}' and closes the connection`, async () => {
      const { calls, client } = fakeClient(value);
      await expect(connectToGateTarget(target, () => client)).rejects.toThrow(
        protectedRefusal
      );
      expect(calls).toEqual(["connect", "marker", "end"]);
    });

    it(`refuses '${value}' when only the stored marker says so`, async () => {
      const { client } = fakeClient("", value);
      await expect(assertDisposableEnvironment(client)).rejects.toThrow(
        protectedRefusal
      );
    });
  }

  for (const value of ["production", "staging", "restore-drill"]) {
    it(`refuses '${value}' when only the database comment says so (the marker Neon allows)`, async () => {
      const { calls, client } = fakeClient(
        null,
        null,
        `polaris.environment=${value}`
      );
      await expect(connectToGateTarget(target, () => client)).rejects.toThrow(
        protectedRefusal
      );
      expect(calls).toEqual(["connect", "marker", "end"]);
    });
  }

  it("refuses the comment with other case or spaces, which would not be a marker to accept", async () => {
    const comments = [
      " polaris.environment=Production",
      "polaris.environment=staging ",
    ];
    await Promise.all(
      comments.map((comment) =>
        expect(
          assertDisposableEnvironment(fakeClient("", null, comment).client)
        ).rejects.toThrow(protectedRefusal)
      )
    );
  });

  it("allows a comment that is not a protected marker (control)", async () => {
    const comments = [
      "default administrative connection database",
      "polaris.environment=staging-x",
      "production",
    ];
    await Promise.all(
      comments.map((comment) =>
        expect(
          assertDisposableEnvironment(fakeClient("", null, comment).client)
        ).resolves.toBeUndefined()
      )
    );
  });

  it("refuses the marker with other case or spaces", async () => {
    await expect(
      assertDisposableEnvironment(fakeClient(" Production ").client)
    ).rejects.toThrow(protectedRefusal);
  });

  it("allows an empty or missing marker (the disposable branch)", async () => {
    const markers = [
      [null, null],
      ["", null],
      ["", ""],
    ] as const;
    const runs = await Promise.all(
      markers.map(async ([current, stored]) => {
        const { calls, client } = fakeClient(current, stored);
        const connected = await connectToGateTarget(target, () => client);
        return { admin: connected.admin, calls, client };
      })
    );
    for (const { admin, calls, client } of runs) {
      expect(admin).toBe(client);
      expect(calls).toEqual(["connect", "marker"]);
    }
  });

  it("allows a marker that is not a protected environment", async () => {
    await expect(
      assertDisposableEnvironment(fakeClient("gate").client)
    ).resolves.toBeUndefined();
  });
});
