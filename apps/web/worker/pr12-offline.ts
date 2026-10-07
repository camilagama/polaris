interface OfflinePocBindings {
  ASSETS: Fetcher;
}

export default {
  fetch(request: Request, environment: OfflinePocBindings): Promise<Response> {
    if (new URL(request.url).pathname === "/health") {
      return Promise.resolve(Response.json({ status: "ok" }));
    }

    return environment.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<OfflinePocBindings>;
