/**
 * End-to-end tests for the solver CLI, run against the local mock challenge
 * (see mock-challenge/app.js). The original deployment is gone, so this is
 * the only executable check of solve.ts — the fiber dispatch, the
 * Map.prototype.get patch, the step loop, and the exit-code contract.
 *
 * Run with `npm run test:integration`. Needs the Playwright Chromium build
 * (`npx playwright install chromium`); the plain `npm test` unit suite
 * deliberately does not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { startMockChallenge, startStatusServer } from "./mock-challenge/server.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

interface SolverRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run the real CLI (`node --import tsx src/solve.ts`) as a child process —
 * not an in-process import — so the test exercises the same entry point,
 * env handling, and exit code a user or CI script sees.
 */
async function runSolver(challengeUrl: string): Promise<SolverRun> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/solve.ts"], {
    cwd: REPO_ROOT,
    env: { ...process.env, CHALLENGE_URL: challengeUrl, HEADLESS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const [exitCode] = (await once(child, "close")) as [number | null];
  return { exitCode, stdout, stderr };
}

function transcript(run: SolverRun): string {
  return `\n--- stdout ---\n${run.stdout}\n--- stderr ---\n${run.stderr}`;
}

test(
  "solver completes all 30 steps against the mock challenge and exits 0",
  { timeout: 120_000 },
  async () => {
    const mock = await startMockChallenge();
    try {
      const run = await runSolver(mock.url);
      const detail = transcript(run);

      assert.equal(run.exitCode, 0, `expected exit code 0${detail}`);
      assert.match(run.stdout, /=== COMPLETE ===/, detail);
      assert.match(run.stdout, /Final URL: .*\/finish/, detail);
      // 30 decrypted codes + the appended step-30 sentinel.
      assert.match(run.stdout, /Decrypted 31 codes\./, detail);
      // A clean run confirms every step's navigation; FAILED anywhere means
      // the loop limped through on retries or misreported.
      assert.doesNotMatch(run.stdout + run.stderr, /FAILED/, detail);
    } finally {
      await mock.close();
    }
  },
);

test(
  "solver fails fast with exit code 1 when the site is gone (HTTP 404)",
  { timeout: 60_000 },
  async () => {
    const gone = await startStatusServer(404);
    try {
      const run = await runSolver(gone.url);
      const detail = transcript(run);

      assert.equal(run.exitCode, 1, `expected exit code 1${detail}`);
      assert.match(run.stderr, /HTTP 404/, detail);
      assert.match(run.stderr, /set CHALLENGE_URL to a live deployment/, detail);
      // It must fail on the goto response, not by timing out on a selector.
      assert.doesNotMatch(run.stderr, /Timeout.*waiting for/i, detail);
    } finally {
      await gone.close();
    }
  },
);
