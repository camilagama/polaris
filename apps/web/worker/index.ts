export default {
  fetch(request: Request) {
    const { pathname } = new URL(request.url);

    if (pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    if (pathname.startsWith("/api/")) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler;
