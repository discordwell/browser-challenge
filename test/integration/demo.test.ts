/**
 * Smoke test for `npm run demo` (scripts/demo.ts): it must start the bundled
 * mock challenge, run the real solver against it, and exit with the solver's
 * exit code. This is what keeps the demo — the only way left to *watch* the
 * solver now the original deployment is gone — from rotting silently (a broken
 * server import, a stale spawn invocation, a mock the solver can no longer
 * pass).
 *
 * Run with `npm run test:integration`. Needs the Playwright Chromium build,
 * like the rest of this directory.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

test(
  "npm run demo solves the bundled mock challenge end-to-end",
  { timeout: 120_000 },
  async () => {
    // Spawn the demo script the way `npm run demo` does (tsx via node --import,
    // matching how solve.test.ts spawns the solver). HEADLESS=1 because the
    // demo is headed by default — the whole point interactively, but not in CI.
    // The solver grandchild inherits the demo's stdio, so its output lands in
    // the same pipes and one transcript covers both.
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/demo.ts"], {
      cwd: REPO_ROOT,
      env: { ...process.env, HEADLESS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const [exitCode] = (await once(child, "close")) as [number | null];
    const detail = `\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`;

    assert.equal(exitCode, 0, `expected exit code 0${detail}`);
    // The demo's own banner (it chose the port, so match the shape)…
    assert.match(
      stdout,
      /Mock challenge \(local replica\) running at http:\/\/127\.0\.0\.1:\d+/,
      detail,
    );
    // …then the solver's full run against that mock.
    assert.match(stdout, /=== COMPLETE ===/, detail);
    assert.match(stdout, /Final URL: .*\/finish/, detail);
    assert.doesNotMatch(stdout + stderr, /FAILED/, detail);
  },
);
