/**
 * Watch the solver work: `npm run demo`.
 *
 * The original challenge deployment is gone (HTTP 404 since mid-2026), so this
 * serves the bundled local replica (test/integration/mock-challenge/) on an
 * ephemeral port and runs the real solver CLI against it — the same entry
 * point, env handling, and exit code as `npm run solve`. Headed by default so
 * a browser window opens and flies through all 30 steps; set HEADLESS=1 to
 * hide it. Exits with the solver's own exit code, so this doubles as a smoke
 * test (see test/integration/demo.test.ts).
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { startMockChallenge } from "../test/integration/mock-challenge/server.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const mock = await startMockChallenge();
try {
  console.log(`Mock challenge (local replica) running at ${mock.url}`);
  console.log("Running the solver against it...\n");

  // Same invocation as the integration tests: the real CLI as a child process.
  // stdio is inherited so the solver's own log streams straight through.
  const child = spawn(process.execPath, ["--import", "tsx", "src/solve.ts"], {
    cwd: REPO_ROOT,
    env: { ...process.env, CHALLENGE_URL: mock.url },
    stdio: "inherit",
  });
  const [exitCode] = (await once(child, "close")) as [number | null];
  process.exitCode = exitCode ?? 1;
} finally {
  await mock.close();
}
