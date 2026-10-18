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
  }
}
