/**
 * Local HTTP servers for the integration tests.
 *
 * `startMockChallenge` serves the mock challenge SPA (see app.js): React 18
 * UMD builds straight out of node_modules, the app script, and index.html as
 * the fallback for every other path — the same catch-all hosting a real SPA
 * deployment uses, which is what makes /step1…/step30 reachable after a
 * pushState navigation.
 *
 * `startStatusServer` answers every request with a fixed status code, for
 * testing the solver's fail-fast path now that the original deployment 404s.
 */
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/** Path to a file inside an npm package, bypassing its `exports` map. */
function packageFile(pkg: string, ...segments: string[]): string {
  return join(dirname(require.resolve(`${pkg}/package.json`)), ...segments);
}

const HERE = dirname(fileURLToPath(import.meta.url));

// React 19 dropped UMD builds, so the mock pins react@18 in devDependencies.
const STATIC_FILES: Record<string, { path: string; type: string }> = {
  "/vendor/react.js": {
    path: packageFile("react", "umd", "react.production.min.js"),
    type: "text/javascript",
  },
  "/vendor/react-dom.js": {
    path: packageFile("react-dom", "umd", "react-dom.production.min.js"),
    type: "text/javascript",
  },
  "/app.js": { path: join(HERE, "app.js"), type: "text/javascript" },
};
const INDEX_PATH = join(HERE, "index.html");

export interface TestServer {
  url: string;
  close(): Promise<void>;
}

async function listen(server: Server): Promise<TestServer> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error(`Expected an ephemeral TCP port, got ${JSON.stringify(address)}`);
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Chromium holds keep-alive connections; without this, close() hangs.
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export function startMockChallenge(): Promise<TestServer> {
  return listen(
    createServer(async (req, res) => {
      try {
        const path = new URL(req.url ?? "/", "http://localhost").pathname;
        const file = STATIC_FILES[path];
        if (file) {
          res.setHeader("content-type", file.type);
          res.end(await readFile(file.path));
        } else {
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end(await readFile(INDEX_PATH));
        }
      } catch (err) {
        res.statusCode = 500;
        res.end(String(err));
      }
    }),
  );
}

export function startStatusServer(statusCode: number): Promise<TestServer> {
  return listen(
    createServer((_req, res) => {
      res.statusCode = statusCode;
      res.end(`status ${statusCode}`);
    }),
  );
}
