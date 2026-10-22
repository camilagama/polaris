import { describe, expect, it } from "vitest";
import {
  drawGraph,
  modelBecomes,
  type RoleEdge,
  type RoleGraph,
  seededRandom,
} from "./becomes-model";

const GROUP = /^polaris_.+_runtime$/;
const LOGIN = /^polaris_gate_runner_[0-9a-f]+$/;
const OWNER = "neondb_owner";

const edge = (
  member: string,
  role: string,
  options: Partial<Pick<RoleEdge, "admin" | "inherit" | "set">>
): RoleEdge => ({
  admin: false,
  inherit: false,
  member,
  role,
  set: false,
  ...options,
});

const graph = (
  edges: RoleEdge[],
  superusers: string[] = [],
  extra: string[] = []
): RoleGraph => ({
  databaseOwner: OWNER,
  edges,
  roles: [
    ...new Set([
      ...extra,
      ...edges.flatMap((item) => [item.member, item.role]),
    ]),
  ],
  superusers: new Set(superusers),
});

const becomes = (roles: RoleGraph) => modelBecomes(roles, GROUP, LOGIN);

describe("the closure becomes follows", () => {
  it("is the runtime group itself when it has no edge", () => {
    expect(becomes(graph([], [], ["polaris_a_runtime", "plain"]))).toEqual([
      "polaris_a_runtime->polaris_a_runtime",
    ]);
  });

  it("follows SET chains, not INHERIT alone", () => {
    expect(
      becomes(
        graph([
          edge("polaris_a_runtime", "b", { set: true }),
          edge("b", "c", { set: true }),
          edge("polaris_a_runtime", "d", { inherit: true }),
        ])
      )
    ).toEqual([
      "polaris_a_runtime->b",
      "polaris_a_runtime->c",
      "polaris_a_runtime->polaris_a_runtime",
    ]);
  });

  it("follows ADMIN OPTION held directly, through an inherited role and through a role it can become, to any depth", () => {
    expect(
      becomes(
        graph([
          edge("polaris_a_runtime", "b", { admin: true }),
          edge("b", "c", { inherit: true }),
          edge("c", "d", { admin: true }),
          edge("d", "e", { set: true }),
          edge("e", "f", { admin: true }),
        ])
      )
    ).toEqual([
      "polaris_a_runtime->b",
      "polaris_a_runtime->d",
      "polaris_a_runtime->f",
      "polaris_a_runtime->polaris_a_runtime",
    ]);
  });

  it("makes a member of a runtime group a runtime role, through any edge but the database owner's ADMIN-only one", () => {
    expect(
      becomes(
        graph([
          edge("login", "polaris_a_runtime", { admin: true }),
          edge(OWNER, "polaris_a_runtime", { admin: true }),
        ])
      )
    ).toEqual([
      "login->login",
      "login->polaris_a_runtime",
      "polaris_a_runtime->polaris_a_runtime",
    ]);
  });

  it("does not count the database owner's ADMIN-only edge as reach, but counts its edge with SET", () => {
    const rows = (options: Partial<RoleEdge>) =>
      becomes(
        graph([
          edge("polaris_a_runtime", OWNER, { inherit: true }),
          edge(OWNER, "target", { admin: true, ...options }),
        ])
      );
    expect(rows({})).not.toContain("polaris_a_runtime->target");
    expect(rows({ set: true })).toContain("polaris_a_runtime->target");
  });

  it("reaches a superuser but does not follow what pg_has_role says it has, and leaves a superuser runtime role out", () => {
    expect(
      becomes(
        graph(
          [
            edge("polaris_a_runtime", "root", { set: true }),
            // root's own edge counts (polaris_a_runtime can SET to root, which holds it)
            edge("root", "held", { admin: true }),
            // an edge root is not on: pg_has_role(root, other) is true for a superuser, and is not followed
            edge("other", "beyond", { admin: true }),
            edge("polaris_b_runtime", "x", { set: true }),
          ],
          ["root", "polaris_b_runtime"]
        )
      )
    ).toEqual([
      "polaris_a_runtime->held",
      "polaris_a_runtime->polaris_a_runtime",
      "polaris_a_runtime->root",
    ]);
  });
});

describe("the graphs the fuzz draws", () => {
  it("are the same for the same seed, have 4 to 7 roles, at least one runtime group and no cycle", () => {
    for (let seed = 1; seed <= 50; seed += 1) {
      const first = drawGraph(seededRandom(seed), "t", {
        allowSuperuser: true,
        databaseOwner: OWNER,
      });
      expect(
        drawGraph(seededRandom(seed), "t", {
          allowSuperuser: true,
          databaseOwner: OWNER,
        })
      ).toEqual(first);
      expect(first.names.length).toBeGreaterThanOrEqual(4);
      expect(first.names.length).toBeLessThanOrEqual(7);
      expect(first.names.some((name) => GROUP.test(name))).toBe(true);
      const roles = graph(first.edges, [], first.names);
      for (const name of first.names) {
        const reached = new Set<string>();
        const queue = [name];
        while (queue.length > 0) {
          const current = queue.shift() as string;
          for (const item of roles.edges) {
            if (item.member === current && !reached.has(item.role)) {
              reached.add(item.role);
              queue.push(item.role);
            }
          }
        }
        expect(reached.has(name)).toBe(false);
      }
    }
  });
});
