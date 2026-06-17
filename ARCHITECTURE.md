# Architecture

A Playwright script that completes all 30 steps of the Browser Navigation
Challenge in ~23s by extracting the answer codes instead of solving the puzzles.

## Layout

```
src/
  session.ts   # Pure logic: XOR cipher, decrypt/encrypt, code-for-step mapping. No browser, no I/O.
  solve.ts     # Orchestration: drives Chromium via Playwright, calls into session.ts.
test/
  session.test.ts  # Unit tests for session.ts (node:test).
  integration/
    solve.test.ts      # End-to-end: spawns the real solver CLI, asserts the exit-code contract.
    mock-challenge/
      app.js           # React 18 replica of the challenge's contract (plain JS, no bundler).
      index.html       # Shell that loads the React UMD builds + app.js.
      server.ts        # node:http server: UMD from node_modules, SPA catch-all to index.html.
```

`session.ts` holds everything that can be reasoned about and tested without a
browser. `solve.ts` owns all the browser-specific glue (launching Chromium,
clicking START, dispatching into React, navigating between steps). The split
exists so the trickiest logic — the cipher and the off-by-one index math — is
covered by fast, deterministic unit tests rather than only exercised against a
live website.

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
  implementation rather than against itself.
- `solve.test.ts` spawns the real CLI (`node --import tsx src/solve.ts`) as a
  child process with `CHALLENGE_URL` pointed at the mock and asserts the
  observable contract: exit 0 + `=== COMPLETE ===` + final URL `/finish` on a
  clean run, and exit 1 with the fail-fast message when the site answers 404.
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
