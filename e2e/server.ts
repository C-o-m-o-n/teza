// Serves dist/ on a free localhost port, so the e2e runs need no dev server and no network. Every
// file goes out with the headers dist/_headers gives `/*` (the CSP), as Workers Static Assets sends
// them, so a CSP violation shows up as a console error in the e2e runs.
import { readFile } from "node:fs/promises";
import { createServer, Server } from "node:http";
import { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** The `/*` rule of a Static Assets `_headers` file: its `Name: value` lines. Throws if it has none. */
async function assetHeaders(root: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  let rule = "";
  for (const line of (await readFile(join(root, "_headers"), "utf8")).split("\n")) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) rule = line.trim();
    else if (rule === "/*") {
      const at = line.indexOf(":");
      headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
  }
  if (!headers["Content-Security-Policy"]) throw new Error("dist/_headers has no Content-Security-Policy for /*");
  return headers;
}

export async function serveDist(root: string): Promise<{ url: string; close: () => Promise<void> }> {
  const headers = await assetHeaders(root);
  const server: Server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    // No accounts server here: answer /api/* with an empty 204 so the game stays signed out
    // without a failed request showing up as a console error.
    if (path.startsWith("/api/")) return res.writeHead(204).end();
    const file = normalize(join(root, path === "/" ? "index.html" : path));
    if (!file.startsWith(root)) return res.writeHead(403).end();
    try {
      const body = await readFile(file);
      res.writeHead(200, { ...headers, "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
