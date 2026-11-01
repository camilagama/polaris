/**
 * The bindings of the public catalog Worker. The Hyperdrive configuration must
 * use the public catalog role's login (a member of polaris_catalog_runtime) with
 * query caching disabled: every answer depends on the plan at that moment.
 */
// biome-ignore lint/style/noNamespace: the Workers types are extended by merging into the global Cloudflare namespace
declare namespace Cloudflare {
  interface Env {
    CATALOG_HYPERDRIVE: Hyperdrive;
    /** The origin public pages are addressed by (canonical links), e.g. https://catalogo.example. */
    CATALOG_ORIGIN: string;
    /** The private media bucket, only ever read (ADR 0069). */
    MEDIA_BUCKET: R2Bucket;
    /**
     * The address of the Polaris site the footer links to. Not a secret; empty (or not a plain https address)
     * means the footer is only text. Declared in every environment of wrangler.jsonc.
     */
    POLARIS_SITE_URL?: string;
    /**
     * Exactly `true` makes `/robots.txt` declare the commit the Worker was built from (`X-Polaris-Release`, ADR 0098
     * amended); absent or any other value sends no release. `true` only in `env.staging`.
     */
    RELEASE_HEADER_ENABLED?: string;
  }
}
