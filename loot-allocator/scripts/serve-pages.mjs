import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const root = new URL("../pages-dist/", import.meta.url).pathname;
const port = Number(process.env.PAGES_PORT || 5080);
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url || "/", `http://${request.headers.host}`).pathname);
  const relative = normalize(pathname).replace(/^([.][.][/\\])+/, "").replace(/^[/\\]+/, "");
  let path = join(root, relative || "index.html");
  try {
    if ((await stat(path)).isDirectory()) path = join(path, "index.html");
    response.setHeader("Content-Type", mimeTypes[extname(path)] || "application/octet-stream");
    createReadStream(path).pipe(response);
  } catch {
    response.statusCode = 404;
    response.end("Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Static publication: http://127.0.0.1:${port}`);
});
