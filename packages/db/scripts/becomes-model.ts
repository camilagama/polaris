/**
 * `becomes` (definer-hardening-checks.ts) computed without the database, for the fuzz of the definer-hardening gate: the
 * gate draws random graphs of throwaway roles, reads them back from pg_auth_members and compares what the CTE answers
 * with what this model answers. The rules, the ones the CTE is meant to follow:
 *
 * - a runtime role has a `*_runtime` name or a runtime login name, or reaches a `*_runtime` role through any chain of
 *   edges, except an edge of the database owner with ADMIN OPTION alone (no INHERIT, no SET);
 * - a runtime role that is neither a superuser nor the database owner becomes every role it can SET to (itself included:
 *   a chain of edges with SET), and then, to any depth, every role on which a role it becomes, or one that role can SET to
 *   or inherits (a chain of edges with INHERIT), has ADMIN OPTION; the database owner's ADMIN-only edge does not count;
 * - a superuser that is reached is not followed: PostgreSQL says it is a member of every role, so it is reported by its
 *   attributes instead.
 */
export interface RoleEdge {
  admin: boolean;
  inherit: boolean;
  member: string;
  role: string;
  set: boolean;
}

export interface RoleGraph {
  databaseOwner: string;
  edges: RoleEdge[];
  /** every role of the graph, the database owner included when it has an edge */
  roles: string[];
  superusers: ReadonlySet<string>;
}

function chain(
  graph: RoleGraph,
  from: string,
  follows: (edge: RoleEdge) => boolean
): Set<string> {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const edge of graph.edges) {
      if (edge.member === current && follows(edge) && !seen.has(edge.role)) {
        seen.add(edge.role);
        queue.push(edge.role);
      }
    }
  }
  return seen;
}

/** what pg_has_role answers for SET or USAGE (inherit): a superuser has every role */
function hasRole(
  graph: RoleGraph,
  from: string,
  option: "inherit" | "set"
): Set<string> {
  if (graph.superusers.has(from)) {
    return new Set(graph.roles);
  }
  return chain(graph, from, (edge) => edge[option]);
}

const ownerAdminOnly = (graph: RoleGraph, edge: RoleEdge) =>
  edge.member === graph.databaseOwner && !edge.inherit && !edge.set;

export function runtimeRoles(
  graph: RoleGraph,
  groupPattern: RegExp,
  loginPattern: RegExp
): Set<string> {
  const runtime = new Set<string>();
  for (const role of graph.roles) {
    const reached = chain(graph, role, (edge) => !ownerAdminOnly(graph, edge));
    reached.delete(role);
    if (
      groupPattern.test(role) ||
      loginPattern.test(role) ||
      [...reached].some((target) => groupPattern.test(target))
    ) {
      runtime.add(role);
    }
  }
  return runtime;
}

/** the roles on which `via`, or a role it can SET to or inherits, has ADMIN OPTION (not the database owner's ADMIN-only edge) */
function administered(graph: RoleGraph, via: string): string[] {
  if (graph.superusers.has(via)) {
    return [];
  }
  const holders = new Set([
    ...hasRole(graph, via, "set"),
    ...hasRole(graph, via, "inherit"),
  ]);
  return graph.edges
    .filter(
      (edge) =>
        edge.admin && !ownerAdminOnly(graph, edge) && holders.has(edge.member)
    )
    .map((edge) => edge.role);
}

/** `runtime->role` for every row `becomes` must have, sorted */
export function modelBecomes(
  graph: RoleGraph,
  groupPattern: RegExp,
  loginPattern: RegExp
): string[] {
  const rows: string[] = [];
  for (const runtime of runtimeRoles(graph, groupPattern, loginPattern)) {
    if (graph.superusers.has(runtime) || runtime === graph.databaseOwner) {
      continue;
    }
    const becomes = hasRole(graph, runtime, "set");
    const queue = [...becomes];
    while (queue.length > 0) {
      for (const role of administered(graph, queue.shift() as string)) {
        if (!becomes.has(role)) {
          becomes.add(role);
          queue.push(role);
        }
      }
    }
    for (const role of becomes) {
      rows.push(`${runtime}->${role}`);
    }
  }
  return rows.sort();
}

/** Park-Miller (minimal standard) generator: the same numbers in [0, 1) for the same seed, so the fuzz draws the same graphs */
export function seededRandom(seed: number): () => number {
  const modulus = 2_147_483_647;
  let state = (Math.abs(Math.trunc(seed)) % (modulus - 1)) + 1;
  return () => {
    state = (state * 48_271) % modulus;
    return (state - 1) / (modulus - 1);
  };
}

/**
 * The database owner's edges a graph sometimes gets: its ADMIN-only edge on one or two roles (what PostgreSQL 16+ gives the
 * creator of a role), and a role of the graph that is a member of the database owner (any options), so that the owner's
 * exemption is reached; never one that would close a cycle.
 */
function ownerEdges(
  random: () => number,
  names: string[],
  edges: RoleEdge[],
  owner: string
): RoleEdge[] {
  const added: RoleEdge[] = [];
  if (random() < 0.3) {
    const targets = new Set([
      names[Math.floor(random() * names.length)] as string,
      names[Math.floor(random() * names.length)] as string,
    ]);
    for (const role of targets) {
      added.push({
        admin: true,
        inherit: false,
        member: owner,
        role,
        set: false,
      });
    }
  }
  if (random() < 0.3) {
    // the roles the owner is already a member of, through any edge: granting the owner to one of them would be a cycle
    const above = new Set([owner]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const edge of [...edges, ...added]) {
        if (above.has(edge.member) && !above.has(edge.role)) {
          above.add(edge.role);
          grew = true;
        }
      }
    }
    const members = names.filter((name) => !above.has(name));
    if (members.length > 0) {
      added.push({
        admin: random() < 0.5,
        inherit: random() < 0.5,
        member: members[Math.floor(random() * members.length)] as string,
        role: owner,
        set: random() < 0.5,
      });
    }
  }
  return added;
}

export interface DrawnGraph {
  edges: RoleEdge[];
  names: string[];
  superuser: string | undefined;
}

/**
 * A random graph of 4 to 7 roles: about a third with a `*_runtime` name (at least one), an edge between two roles with
 * probability 0.45 and each of ADMIN, INHERIT and SET drawn on it (all three false included), only from a later role to an
 * earlier one in a shuffled order (PostgreSQL refuses a cycle), sometimes one superuser (when `allowSuperuser`) and, when
 * `databaseOwner` is given, sometimes the edges of `ownerEdges`.
 */
export function drawGraph(
  random: () => number,
  prefix: string,
  options: { allowSuperuser: boolean; databaseOwner?: string }
): DrawnGraph {
  const count = 4 + Math.floor(random() * 4);
  const names = Array.from({ length: count }, (_, index) =>
    random() < 0.35
      ? `polaris_gate_fz${prefix}_${index}_runtime`
      : `gate_fz${prefix}_${index}`
  );
  if (!names.some((name) => name.endsWith("_runtime"))) {
    names[0] = `polaris_gate_fz${prefix}_0_runtime`;
  }
  const order = [...names];
  for (let index = order.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [order[index], order[other]] = [
      order[other] as string,
      order[index] as string,
    ];
  }
  const edges: RoleEdge[] = [];
  for (let low = 0; low < order.length; low += 1) {
    for (let high = low + 1; high < order.length; high += 1) {
      if (random() < 0.45) {
        edges.push({
          admin: random() < 0.5,
          inherit: random() < 0.5,
          member: order[high] as string,
          role: order[low] as string,
          set: random() < 0.5,
        });
      }
    }
  }
  if (options.databaseOwner) {
    edges.push(...ownerEdges(random, names, edges, options.databaseOwner));
  }
  const superuser =
    options.allowSuperuser && random() < 0.25
      ? names[Math.floor(random() * names.length)]
      : undefined;
  return { edges, names, superuser };
}
