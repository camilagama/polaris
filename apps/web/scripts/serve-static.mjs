// A tiny static server for the browser checks of the service worker: it reads the
// build directory on every request, so a test can rebuild the app while it runs
// ("a new version"), which `vite preview` does not survive. Single-page fallback
// like the Worker's static assets; the Worker's own paths answer 404. The headers
// are the build's own `_headers` file, applied the way Workers Static Assets does
// (every matching rule in order, `! Name` detaching a header), so the browser
// checks run under the shell's real Content-Security-Policy (ADR 0103, condition 2).
//   node scripts/serve-static.mjs <dir> <port>
import { createStaticServer } from "./static-server.mjs";

const [directory = "dist/pwa-e2e", port = "4174"] = process.argv.slice(2);
createStaticServer(directory).listen(Number(port), "127.0.0.1");
