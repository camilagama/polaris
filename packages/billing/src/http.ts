/**
 * The smallest `fetch` the provider clients need. It is injected, so the
 * package has no Worker types and a test drives the provider without a network.
 */
export interface FetchResponseLike {
  readonly status: number;
  text: () => Promise<string>;
}

export interface FetchInit {
  body?: string;
  headers: Record<string, string>;
  method: "DELETE" | "GET" | "POST" | "PUT";
  redirect: "manual";
  signal: AbortSignal;
}

export type FetchLike = (
  url: string,
  init: FetchInit
) => Promise<FetchResponseLike>;
