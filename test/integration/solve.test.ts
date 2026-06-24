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

test(
  "solver fails fast with one clear error when the session has the wrong number of codes",
  { timeout: 60_000 },
  async () => {
    const mock = await startMockChallenge();
    try {
      // ?codes=29 makes the mock generate 29 codes instead of 30 — a stand-in
      // for the challenge format changing. prepareSession must reject this up
      // front with a single clear error rather than letting the step loop
      // submit `undefined` thirty times. This pins the documented contract
      // ("one clear error instead of thirty confusing per-step failures")
      // end-to-end through the real CLI, not just at the function level.
      const run = await runSolver(`${mock.url}/?codes=29`);
      const detail = transcript(run);

      assert.equal(run.exitCode, 1, `expected exit code 1${detail}`);
      assert.match(
        run.stderr,
        /Expected 30 string codes in wo_session, got 29 codes/,
        detail,
      );
      assert.match(run.stderr, /challenge format changed/, detail);
      // The whole point: one clear error, not a wall of per-step failures.
      assert.doesNotMatch(run.stdout + run.stderr, /Step \d+: FAILED/, detail);
      assert.doesNotMatch(run.stdout, /=== COMPLETE ===/, detail);
    } finally {
      await mock.close();
    }
  },
);

test(
  "solver recovers via its retry path when a step swallows the first submit",
  { timeout: 120_000 },
  async () => {
    const mock = await startMockChallenge();
    try {
      // ?flaky=20 makes step 20 ignore its first submit and accept the second,
      // simulating a transient flake. Step 20 is "strict" (ignores synthetic
      // onChange), so the retry has to re-run the fiber dispatch, not the
      // valueTracker fallback. submitStep's retry path is otherwise never hit
      // by these tests — every other step passes on the first try. The run
      // should still complete cleanly.
      const run = await runSolver(`${mock.url}/?flaky=20`);
      const detail = transcript(run);

      assert.equal(run.exitCode, 0, `expected exit code 0${detail}`);
      assert.match(run.stdout, /=== COMPLETE ===/, detail);
      assert.match(run.stdout, /Final URL: .*\/finish/, detail);
      // The retry succeeds, so no step is ever reported as FAILED.
      assert.doesNotMatch(run.stdout + run.stderr, /FAILED/, detail);
      // Teeth: prove the retry actually fired rather than the run trivially
      // completing. A normal step finishes in well under a second; step 20 can
      // only have taken seconds because the first submit was swallowed and the
      // solver waited out its 3s waitForURL timeout before retrying.
      const step20 = run.stdout.match(/Step 20: (\d+\.\d+)s/);
      assert.ok(step20, `expected a "Step 20" timing line${detail}`);
      assert.ok(
        Number(step20[1]) >= 1,
        `step 20 should have taken seconds (retry timeout), got ${step20[1]}s${detail}`,
      );
    } finally {
      await mock.close();
    }
  },
);

test(
  "solver reports a genuine step failure honestly (FAILED + exit 1, never a false COMPLETE)",
  { timeout: 120_000 },
  async () => {
    const mock = await startMockChallenge();
    try {
      // ?broken=30 makes step 30 reject every code — a step the solver cannot
      // pass, as if the challenge changed so the extracted code no longer
      // validates. Steps 1-29 still pass, isolating the failure to one step
      // (and keeping the run to one stuck step's ~6s of retry timeouts). This
      // pins the project's core "truthful outcomes" contract end-to-end: when
      // the run does not reach /finish it must say so and exit non-zero, never
      // a false COMPLETE. The other failure tests fail *before* the step loop
      // (404, malformed session); this is the only one that drives the loop to
      // a genuine FAILED.
      const run = await runSolver(`${mock.url}/?broken=30`);
      const detail = transcript(run);

      assert.equal(run.exitCode, 1, `expected exit code 1${detail}`);
      assert.match(run.stdout, /=== FAILED ===/, detail);
      assert.doesNotMatch(run.stdout, /=== COMPLETE ===/, detail);
      assert.match(run.stderr, /Step 30: FAILED/, detail);
      assert.match(run.stderr, /Steps that never confirmed: 30/, detail);
      // Teeth for the diagnostic: step 30 is strict (≥19), so the value can only
      // have been set via the fiber dispatch. The FAILED line must say so —
      // proving the failure is the site rejecting a set code, not the solver
      // failing to set the input. That distinction is the whole point of
      // surfacing the dispatch method on a redeployed challenge.
      assert.match(run.stderr, /set via React fiber/, detail);
    } finally {
      await mock.close();
    }
  },
);

test(
  "solver recovers when a string useState precedes the code state (hook reordering)",
  { timeout: 120_000 },
  async () => {
    const mock = await startMockChallenge();
    try {
      // ?decoy=25 gives step 25 an extra string useState ahead of the code
      // state — a stand-in for a redeploy that reorders hooks (adds a name/hint
      // field, etc.). The code input is no longer the first string-typed
      // useState, so a solver that blindly dispatched into the first one would
      // send the code into the decoy, leave the input empty, and fail the step
      // with a misleading "set via React fiber" diagnostic. The solver instead
      // tries each candidate until the input's value actually takes the code, so
      // the run still completes. Step 25 is "strict" (ignores synthetic onChange),
      // so this can only pass via the fiber path — the resilience is genuinely
      // exercised, not papered over by the valueTracker fallback. This test has
      // teeth as a regression guard: reverting the solver to "first string state
      // only" makes step 25 stick and the run FAIL.
      const run = await runSolver(`${mock.url}/?decoy=25`);
      const detail = transcript(run);

      assert.equal(run.exitCode, 0, `expected exit code 0${detail}`);
      assert.match(run.stdout, /=== COMPLETE ===/, detail);
      assert.match(run.stdout, /Final URL: .*\/finish/, detail);
      assert.doesNotMatch(run.stdout + run.stderr, /FAILED/, detail);
    } finally {
      await mock.close();
    }
  },
);

test(
  "solver keeps its dispatch inside the input's component (never into the router)",
  { timeout: 120_000 },
  async () => {
    const mock = await startMockChallenge();
    try {
      // ?mismatch=22 makes step 22's displayed value never equal its `code`
      // state, so the solver's "did the input take the code?" check misses on
      // the input's own component and it keeps looking. The router (App) holds
      // its current path in a *string* useState too, so a solver that walked
      // past the input's component into ancestors would dispatch the extracted
      // code into the router, navigate to a bogus route, and unmount the form —
      // bricking the run. Because the solver scopes its candidates to the
      // input's own component, it instead submits the right code (which onSubmit
      // reads from state) and the run still completes. This has teeth: widening
      // the fiber walk back to ancestors makes step 22 dispatch into the router
      // and the run FAIL with no form/input found.
      const run = await runSolver(`${mock.url}/?mismatch=22`);
      const detail = transcript(run);

      assert.equal(run.exitCode, 0, `expected exit code 0${detail}`);
      assert.match(run.stdout, /=== COMPLETE ===/, detail);
      assert.match(run.stdout, /Final URL: .*\/finish/, detail);
      assert.doesNotMatch(run.stdout + run.stderr, /FAILED/, detail);
      // The run must never have been knocked onto the "Page not found" route by
      // a stray dispatch into the router's path state.
      assert.doesNotMatch(run.stdout + run.stderr, /no form to submit/, detail);
      assert.doesNotMatch(run.stdout + run.stderr, /no code input found/, detail);
    } finally {
      await mock.close();
    }
  },
);

test(
  "solver fills an uncontrolled input via the valueTracker fallback (no string useState)",
  { timeout: 120_000 },
  async () => {
    const mock = await startMockChallenge();
    try {
      // ?uncontrolled=12 makes step 12 render an uncontrolled input in a
      // component with NO string useState — the one shape that has no fiber
      // string-state candidate, so the only way to fill it is the solver's
      // valueTracker fallback (set inp.value via the native setter). The run
      // must still complete past step 12 to /finish. Two teeth here:
      //  - It exercises the fallback path end-to-end (every other step passes
      //    via the fiber dispatch, so the fallback is otherwise dead code).
      //  - It pins the walk's scoping: because the input's own component owns no
      //    string state, a walk that ascended "until it finds string state"
      //    would dispatch the code into the router's path useState, render
      //    "Page not found", and fail the run. Completing proves the walk stops
      //    at the input's own component and falls back instead.
      const run = await runSolver(`${mock.url}/?uncontrolled=12`);
      const detail = transcript(run);

      assert.equal(run.exitCode, 0, `expected exit code 0${detail}`);
      assert.match(run.stdout, /=== COMPLETE ===/, detail);
      assert.match(run.stdout, /Final URL: .*\/finish/, detail);
      assert.doesNotMatch(run.stdout + run.stderr, /FAILED/, detail);
      // A stray dispatch into the router would have unmounted the form and
      // surfaced these; their absence confirms the walk stayed scoped.
      assert.doesNotMatch(run.stdout + run.stderr, /no form to submit/, detail);
      assert.doesNotMatch(run.stdout + run.stderr, /no code input found/, detail);
    } finally {
      await mock.close();
    }
  },
);

test(
  "solver recognises a forwardRef-wrapped input component (never walks into the router)",
  { timeout: 120_000 },
  async () => {
    const mock = await startMockChallenge();
    try {
      // ?forwardref=23 wraps step 23's component in React.forwardRef, so the
      // input's nearest component fiber has an *object* type ({$$typeof:
      // react.forward_ref}) instead of a function — and that fiber is where the
      // code state lives. A solver that recognises the input's component only by
      // `typeof type === "function"` walks straight past the forwardRef fiber
      // into the router (App's path useState), dispatches the extracted code as a
      // route, unmounts the form, and bricks the run. The solver instead treats
      // the forwardRef fiber as a component boundary, dispatches into its `code`
      // state, and the run completes. Step 23 is strict (≥19), so this can only
      // pass via the fiber path — the valueTracker fallback can't rescue it.
      // Teeth: removing the forwardRef branch from the walk's component check
      // makes step 23 dispatch into the router and the run FAIL with "no form to
      // submit" / "no code input found".
      const run = await runSolver(`${mock.url}/?forwardref=23`);
      const detail = transcript(run);

      assert.equal(run.exitCode, 0, `expected exit code 0${detail}`);
      assert.match(run.stdout, /=== COMPLETE ===/, detail);
      assert.match(run.stdout, /Final URL: .*\/finish/, detail);
      assert.doesNotMatch(run.stdout + run.stderr, /FAILED/, detail);
      // A stray dispatch into the router would have unmounted the form and
      // surfaced these; their absence confirms the walk stopped at the forwardRef.
      assert.doesNotMatch(run.stdout + run.stderr, /no form to submit/, detail);
      assert.doesNotMatch(run.stdout + run.stderr, /no code input found/, detail);
    } finally {
      await mock.close();
    }
  },
);

test(
  "solver submits the code input's own form, not a distractor form ahead of it",
  { timeout: 120_000 },
  async () => {
    const mock = await startMockChallenge();
    try {
      // ?distractor=24 renders a decoy <form> (a search box) AHEAD of step 24's
      // real code form. document.querySelector("form") returns the first form —
      // the decoy — whose onSubmit does nothing, so a solver that submits "the
      // first form on the page" submits the decoy and step 24 never advances
      // (then every later step is stuck on /step24 too). The solver instead
      // submits the form its code input actually belongs to (`inp.form`), so the
      // run completes. Step 24 is strict (≥19), so the value is set via the fiber
      // dispatch; the distractor only changes which form gets submitted, and the
      // code selector still picks the real input (the decoy's "Search" placeholder
      // has no "code" in it). Teeth: reverting the submit target to
      // document.querySelector("form") makes step 24 submit the decoy, stick, and
      // the run FAIL with a non-zero exit.
      const run = await runSolver(`${mock.url}/?distractor=24`);
      const detail = transcript(run);

      assert.equal(run.exitCode, 0, `expected exit code 0${detail}`);
      assert.match(run.stdout, /=== COMPLETE ===/, detail);
      assert.match(run.stdout, /Final URL: .*\/finish/, detail);
      assert.doesNotMatch(run.stdout + run.stderr, /FAILED/, detail);
    } finally {
      await mock.close();
    }
  },
);

test(
  "solver's failure diagnostic reports the valueTracker fallback when an uncontrolled input is rejected",
  { timeout: 120_000 },
  async () => {
    const mock = await startMockChallenge();
    try {
      // ?uncontrolled=30&broken=30 makes step 30 an uncontrolled input that
      // rejects every code. Steps 1-29 pass; step 30 fills via the fallback
      // (no fiber string state) but never validates, so the run FAILs. This
      // pins the last unexercised branch of describeDispatch end-to-end: the
      // FAILED line must report the value was "set via valueTracker fallback"
      // (method "fallback", applied true) — proving the fallback both ran and
      // actually filled the input, not that the solver failed to set it.
      // Teeth: against a solver whose walk ascends past the stateless input
      // component into the router, step 30 dispatches the code as a route and
      // the diagnostic is "no form to submit" instead — the assertion below
      // only holds with the scoped walk + reachable fallback.
      const run = await runSolver(`${mock.url}/?uncontrolled=30&broken=30`);
      const detail = transcript(run);

      assert.equal(run.exitCode, 1, `expected exit code 1${detail}`);
      assert.match(run.stdout, /=== FAILED ===/, detail);
      assert.doesNotMatch(run.stdout, /=== COMPLETE ===/, detail);
      assert.match(run.stderr, /Step 30: FAILED/, detail);
      assert.match(run.stderr, /Steps that never confirmed: 30/, detail);
      assert.match(run.stderr, /set via valueTracker fallback/, detail);
    } finally {
      await mock.close();
    }
  },
);
