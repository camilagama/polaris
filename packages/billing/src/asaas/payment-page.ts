/**
 * The hosts of Asaas's payment page (`invoiceUrl`) the owner may be sent to (ADR 0104, decision 3): compared by
 * exact equality, never by suffix, so `asaas.com.evil` and `evilasaas.com` are not Asaas. The sandbox's host is
 * allowed only with the sandbox's API (`api-sandbox.asaas.com`), never in production.
 */
const PRODUCTION_PAGE_HOSTS: ReadonlySet<string> = new Set([
  "asaas.com",
  "www.asaas.com",
]);
const SANDBOX_PAGE_HOST = "sandbox.asaas.com";

/**
 * The address of the payment page as it may reach the client, or null when it is not one: `https:`, a host of the
 * list, no user or password and no port. Anything else the provider answers is not passed on.
 */
export function asaasPaymentPageUrl(
  value: unknown,
  options: { sandbox: boolean }
): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const url = URL.parse(value);
  if (
    url === null ||
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== ""
  ) {
    return null;
  }
  const allowed =
    PRODUCTION_PAGE_HOSTS.has(url.hostname) ||
    (options.sandbox && url.hostname === SANDBOX_PAGE_HOST);
  return allowed ? url.href : null;
}
