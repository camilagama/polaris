interface ImportMetaEnv {
  /** The short SHA the Worker was built from, defined by `pwa/server-release.ts` outside the client; absent in tests. */
  readonly POLARIS_SERVER_RELEASE?: string;
}
