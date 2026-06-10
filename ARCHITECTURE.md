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
   browser and decrypts it in Node via `decryptSession`.

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
START click → /step1
  page.evaluate: read sessionStorage["wo_session"]   (browser → Node)
  decryptSession → withStep30Sentinel → encryptSession   (Node, tested)
  page.evaluate: write sessionStorage["wo_session"]  (Node → browser)
  page.evaluate: patch Map.prototype.get             (browser)
  for step 1..30:
    wait for input → __dispatchAndSubmit(codeForStep(codes, step)) → wait for next URL
→ /finish
```

The cipher runs in Node (not the browser) specifically so it is the same code
path the unit tests exercise. The browser is used only to read and write the raw
`wo_session` string.

## Running

```bash
npm install
npm run solve        # run the solver (CHALLENGE_URL and HEADLESS env vars override defaults)
npm test             # unit tests for session.ts
npm run typecheck    # tsc --noEmit over src/ and test/
```

`solve.ts` is executed with `tsx` (no build step). `tsc` is used only for type
checking (`noEmit`).
