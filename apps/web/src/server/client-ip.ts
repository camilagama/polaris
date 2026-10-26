/**
 * The identity every per-IP limit of the server counts a client by (the RPC and upload buckets and the
 * sign-in, Google, e-mail-link and e-mail-send ones), so that no limit reads the address in a way of its own.
 * It comes from `cf-connecting-ip`, which Cloudflare sets at the edge; nothing else the client sends is read.
 */

const IPV4_ADDRESS = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const IPV6_GROUP = /^[0-9a-f]{1,4}$/i;
const MAX_ADDRESS_LENGTH = 64;

/** The eight 16-bit groups of an IPv6 address, or undefined for text that is not one (a zone after `%` is dropped). */
function ipv6Groups(address: string): number[] | undefined {
  let text = address.split("%", 1)[0] ?? "";
  const tailStart = text.lastIndexOf(":") + 1;
  if (text.includes(".")) {
    const octets = ipv4Octets(text.slice(tailStart));
    if (octets === undefined) {
      return undefined;
    }
    // a dotted tail stands for the last two groups
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    text = `${text.slice(0, tailStart)}${(a * 256 + b).toString(16)}:${(c * 256 + d).toString(16)}`;
  }
  const halves = text.split("::");
  const groupsOf = (half: string | undefined) => (half ? half.split(":") : []);
  const before = groupsOf(halves[0]);
  const after = groupsOf(halves[1]);
  const missing = 8 - before.length - after.length;
  if (
    halves.length > 2 ||
    (halves.length === 2 ? missing < 1 : missing !== 0)
  ) {
    return undefined;
  }
  const all = [
    ...before,
    ...Array.from({ length: Math.max(missing, 0) }, () => "0"),
    ...after,
  ];
  return all.every((group) => IPV6_GROUP.test(group))
    ? all.map((group) => Number.parseInt(group, 16))
    : undefined;
}

function ipv4Octets(text: string): number[] | undefined {
  if (!IPV4_ADDRESS.test(text)) {
    return undefined;
  }
  const octets = text.split(".").map(Number);
  return octets.every((octet) => octet <= 255) ? octets : undefined;
}

/**
 * What an IPv6 address counts as: its /64 (the first four groups, lowercase, without leading zeros), or the
 * IPv4 address itself for an IPv4-mapped one (`::ffff:a.b.c.d`, in any spelling). Undefined for text that is not
 * an IPv6 address.
 */
function ipv6Identity(address: string): string | undefined {
  const groups = ipv6Groups(address);
  if (groups === undefined) {
    return undefined;
  }
  const [g0, g1, g2, g3, g4, g5, g6 = 0, g7 = 0] = groups;
  if (
    g0 === 0 &&
    g1 === 0 &&
    g2 === 0 &&
    g3 === 0 &&
    g4 === 0 &&
    g5 === 0xff_ff
  ) {
    return [
      Math.floor(g6 / 256),
      g6 % 256,
      Math.floor(g7 / 256),
      g7 % 256,
    ].join(".");
  }
  return `${[g0, g1, g2, g3].map((group) => (group ?? 0).toString(16)).join(":")}::/64`;
}

/**
 * The address the IP bucket counts: an IPv4 address whole, an IPv6 address by its /64 (one subscriber holds
 * a whole /64, so its addresses are one client). Text that is neither counts as no address.
 */
export function clientIp(request: Request): string | undefined {
  const value = request.headers.get("cf-connecting-ip")?.trim();
  if (!value || value.length > MAX_ADDRESS_LENGTH) {
    return undefined;
  }
  return value.includes(":")
    ? ipv6Identity(value)
    : ipv4Octets(value)?.join(".");
}
