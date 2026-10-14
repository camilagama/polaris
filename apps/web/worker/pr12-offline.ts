interface OfflinePocBindings {
  ASSETS: Fetcher;
}

export default {
  async fetch(
    request: Request,
    environment: OfflinePocBindings
  ): Promise<Response> {
    if (new URL(request.url).pathname === "/health") {
      return Response.json(
        { status: "ok" },
        { headers: { "X-Robots-Tag": "noindex" } }
      );
    }

    const response = await environment.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set("X-Robots-Tag", "noindex");
    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  },
} satisfies ExportedHandler<OfflinePocBindings>;
