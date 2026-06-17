# Architecture

A Playwright script that completes all 30 steps of the Browser Navigation
Challenge in ~23s by extracting the answer codes instead of solving the puzzles.

## Layout

```
src/
  session.ts      # Pure logic: XOR cipher, decrypt/encrypt, code-for-step mapping. No browser, no I/O.
  navigation.ts   # Pure logic: anchored step/finish URL patterns + "page navigated" error classifier.
  solve.ts        # Orchestration: drives Chromium via Playwright, calls into session.ts + navigation.ts.
test/
  session.test.ts     # Unit tests for session.ts (node:test).
  navigation.test.ts  # Unit tests for navigation.ts (node:test).
  integration/
    solve.test.ts      # End-to-end: spawns the real solver CLI, asserts the exit-code contract.
    mock-challenge/
      app.js           # React 18 replica of the challenge's contract (plain JS, no bundler).
      index.html       # Shell that loads the React UMD builds + app.js.
      server.ts        # node:http server: UMD from node_modules, SPA catch-all to index.html.
```

`session.ts` and `navigation.ts` hold everything that can be reasoned about and
tested without a browser. `solve.ts` owns all the browser-specific glue
(launching Chromium, clicking START, dispatching into React, navigating between
steps). The split exists so the trickiest logic — the cipher, the off-by-one
index math, and the route matching — is covered by fast, deterministic unit
tests rather than only exercised against a live website.

`navigation.ts` builds the URL patterns the step loop waits on. They are
**anchored**: `stepPattern(2)` matches `/step2` but not `/step20`, so a
substring collision can't make `waitForURL` report success one step early. It
also classifies the Playwright errors that actually mean "the page navigated" —
a success for this solver — from the context-destroyed/detached signals
(`Execution context was destroyed …`, `frame got detached`), case-insensitively,
in one place instead of two slightly different inline checks. It deliberately
does *not* key on the bare word "navigation": a `waitForURL` timeout message
contains it too but means the page did *not* advance, which must stay loggable.

## How the solve works

The challenge stores all 30 step codes up front in `sessionStorage["wo_session"]`,
so no puzzle ever needs to be solved. Three things make a full run possible:

1. **Code extraction.** `wo_session` is `JSON → repeating-key XOR (key
   "WO_2024_CHALLENGE") → Base64`. `solve.ts` reads the raw blob out of the
   browser and decrypts it in Node via `prepareSession`, which also validates
   that exactly 30 codes came back (one clear error beats thirty confusing
   per-step failures if the challenge format ever changes).

2. **React fiber dispatch.** The code input is a React controlled component, so
   `input.value = ...` is ignored. `solve.ts` walks the fiber tree from the
   input to find the `useState` setter and calls it directly, then fires a
   native `submit` event that React intercepts.

3. **Step 30 off-by-one.** The app's `validateCode(step)` compares the submitted
   value against `codes.get(step + 1)` in a 1-indexed Map. For step 30 that is
   `codes.get(31)`, which the challenge never generates. Two coordinated pieces
   handle it, sharing the value `SENTINEL_CODE`:
   - `withStep30Sentinel` appends the sentinel so `codes[30]` exists to submit.
   - A `Map.prototype.get` patch (scoped to 30-entry maps) returns the sentinel
     for key 31 so the comparison matches.

   This off-by-one is also why `codeForStep(codes, step)` returns `codes[step]`
   (the code "belonging" to the *next* step) rather than `codes[step - 1]`.

## Data flow

```
goto CHALLENGE_URL (fail fast on non-2xx response)
START click → /step1
  page.evaluate: read sessionStorage["wo_session"]   (browser → Node)
  prepareSession = decrypt + validate 30 codes + sentinel   (Node, tested)
  encryptSession → page.evaluate: write it back     (Node → browser)
  page.evaluate: patch Map.prototype.get             (browser)
  for step 1..STEP_COUNT:
    wait for input → __dispatchAndSubmit(codeForStep(codes, step)) → wait for next URL
→ /finish
```

The finish page is only reachable by passing every step, so the final URL is
the ground truth for success: the process exits non-zero if the run does not
end on `/finish` (or if anything throws — the browser is closed via
`try/finally` either way).

The cipher runs in Node (not the browser) specifically so it is the same code
path the unit tests exercise. The browser is used only to read and write the raw
`wo_session` string.

## Integration tests (the mock challenge)

The original deployment is gone (HTTP 404 since mid-2026), so
`test/integration/` keeps `solve.ts` executable and verified locally:

- `mock-challenge/app.js` replicates exactly the contract the solver depends
  on: `wo_session` written at START with the same JSON → XOR → Base64
  encoding, pushState routing `/ → /step1 … /step30 → /finish`, a controlled
  React input, and `validateCode`'s off-by-one (step N checks the code of step
  N+1, so step 30 looks up a 31st code that doesn't exist). Steps 19+ ignore
  synthetic input events, as the original site did — those steps are only
  passable via the solver's fiber state dispatch, so a regression in that walk
  fails the run instead of being masked by the valueTracker fallback. The
  session encoding is implemented independently in the mock (not imported from
  `session.ts`) so the solver's crypto is checked against a second
  implementation rather than against itself. Two test-only knobs, read once
  from the initial page URL's query string (the solver navigates by pushState
  afterwards, so the query is captured at module load), let a test opt into a
  failure mode without disturbing the default happy path: `?codes=N` generates
  a different number of codes, and `?flaky=N` makes step N swallow its first
  submit.
- `solve.test.ts` spawns the real CLI (`node --import tsx src/solve.ts`) as a
  child process with `CHALLENGE_URL` pointed at the mock and asserts the
  observable contract over four scenarios:
  - a clean run — exit 0 + `=== COMPLETE ===` + final URL `/finish`;
  - the site gone (404) — exit 1 with the fail-fast goto message;
  - a malformed session (`?codes=29`) — exit 1 with `prepareSession`'s single
    "Expected 30 string codes" error and *no* per-step `FAILED` spam, pinning
    the "one clear error, not thirty failures" contract end-to-end;
  - a transient flake (`?flaky=20`) — the run still completes via `submitStep`'s
    retry, asserted with a timing check (step 20 takes seconds, the retry's 3s
    `waitForURL` timeout) so the test can't pass without the retry actually
    firing. Step 20 is "strict", so the retry exercises the fiber dispatch, not
    the fallback.
- The mock app is plain-JS `React.createElement` served with React 18 UMD
  builds straight from `node_modules` (React 19 dropped UMD), so there is no
  bundler in the loop. The puzzles, modals, and distractors of the real
  challenge are deliberately absent: the solver never interacted with them.

## Running

```bash
npm install
npm run solve            # run the solver (CHALLENGE_URL and HEADLESS env vars override defaults)
npm test                 # unit tests for session.ts
npm run test:integration # solver CLI vs the local mock challenge (needs Chromium installed)
npm run typecheck        # tsc --noEmit over src/ and test/
```

`solve.ts` is executed with `tsx` (no build step). `tsc` is used only for type
checking (`noEmit`).
