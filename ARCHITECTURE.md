# Architecture

A Playwright script that completes all 30 steps of the Browser Navigation
Challenge in ~23s by extracting the answer codes instead of solving the puzzles.

## Layout

```
src/
  session.ts      # Pure logic: XOR cipher, decrypt/encrypt, code-for-step mapping. No browser, no I/O.
  navigation.ts   # Pure logic: anchored step/finish URL patterns + "page navigated" error classifier.
  diagnostics.ts  # Pure logic: dispatch-result types + the one-line "why did this step fail" message.
  solve.ts        # Orchestration: drives Chromium via Playwright, calls into the pure modules.
test/
  session.test.ts      # Unit tests for session.ts (node:test).
  navigation.test.ts   # Unit tests for navigation.ts (node:test).
  diagnostics.test.ts  # Unit tests for diagnostics.ts (node:test).
  integration/
    solve.test.ts      # End-to-end: spawns the real solver CLI, asserts the exit-code contract.
    mock-challenge/
      app.js           # React 18 replica of the challenge's contract (plain JS, no bundler).
      index.html       # Shell that loads the React UMD builds + app.js.
      server.ts        # node:http server: UMD from node_modules, SPA catch-all to index.html.
```

`session.ts`, `navigation.ts`, and `diagnostics.ts` hold everything that can be
reasoned about and tested without a browser. `solve.ts` owns all the
browser-specific glue (launching Chromium, clicking START, dispatching into
React, navigating between steps). The split exists so the trickiest logic — the
cipher, the off-by-one index math, the route matching, and the failure
diagnostic — is covered by fast, deterministic unit tests rather than only
exercised against a live website. (It is also load-bearing: `solve.ts` calls
`main()` at import time, so it cannot be imported into a unit test; the pure
logic has to live elsewhere to be testable in isolation.)

`diagnostics.ts` turns the result of an in-browser dispatch attempt into the
one-line cause printed when a step gets stuck. The dispatch records *how* the
code input was set (React fiber, the valueTracker fallback, or nothing) and
*whether the input actually took the value* (`applied`). On a redeployed
challenge that lets a debugger split three causes apart: no input found, the
code dispatched into the wrong place so the input stayed empty (plumbing — the
fiber walk or selector needs updating), or the input took a value the site then
rejected (a code/format change). Only the last means "update the codes".

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
   `input.value = ...` is ignored. `solve.ts` walks the fiber tree up from the
   input to its *own component* (the first component fiber up the `.return`
   chain — host elements like `input`/`form` have a string `type`, so the walk
   skips them; a function component has a function `type`, and a `forwardRef`
   component has an object `type` carrying `$$typeof: Symbol(react.forward_ref)`,
   both of which count as a component), collects that component's string-typed
   `useState` dispatchers, and dispatches into each in turn (re-checking the
   value across a few frames) until the input's value actually becomes the code,
   then fires a native `submit` event (on the form the input belongs to —
   `inp.form`, not the first `<form>` on the page, so a distractor form ahead of
   the real one isn't the one submitted) that React intercepts. Three properties
   matter here:
   - It stops at the input's own component and never ascends into ancestors. A
     parent such as the SPA router holds its current path in a string `useState`
     too; dispatching the code into that would navigate to a bogus route and
     unmount the form. The input's controlled state lives in its own component,
     so that is the only safe place to dispatch. Stopping at the *component*
     (not at "the first component that owns string state") is what makes this
     hold even for an uncontrolled input: that component owns no string state,
     and a walk scoped on "first string state found" would skip past it into the
     router — so this scoping is load-bearing, not cosmetic. The "what counts as
     a component" test must include `forwardRef` (object `type`), not just
     functions: a `forwardRef`-wrapped input component still owns the input's
     hooks, so a `typeof type === "function"` check alone would skip past it into
     the router — the same brick. (`React.memo` of a function needs no special
     case: React resolves the memo fiber's `type` back to the inner function.)
   - Within that component it tries each candidate rather than blindly taking the
     first string state, which makes the solver resilient to a redeploy that
     adds a string `useState` ahead of the code state (hook reordering) —
     otherwise the code would go into the wrong state and the step would silently
     fail.
   - If the component owns no string `useState` (an uncontrolled input that reads
     its value from the DOM), there is no fiber candidate, so the solver falls
     back to the valueTracker trick (native `value` setter + `input`/`change`
     events). This is the one path that bypasses the fiber dispatch.

   The dispatch reports both *how* the value was set (`method`: fiber, fallback,
   or none) and whether it stuck (`applied`), which is what the failure
   diagnostic keys on (see `diagnostics.ts`).

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
    abort the loop if the URL hasn't advanced across MAX_STUCK_STEPS steps
→ /finish
```

The finish page is only reachable by passing every step, so the final URL is
the ground truth for success: the process exits non-zero if the run does not
end on `/finish` (or if anything throws — the browser is closed via
`try/finally` either way).

The per-step navigation wait is `STEP_TIMEOUT_MS` (default 3000, env-overridable)
applied twice per step (the initial submit and one retry). If the URL fails to
advance across `MAX_STUCK_STEPS` (2) consecutive steps the loop aborts early:
once a submitted code can't move us off the current page, every remaining step
would only burn its retry budget on the wrong page (~`STEP_COUNT` × the timeout
for an early stall), so the run reports `FAILED` in seconds instead of minutes.
The abort keys on the URL not advancing rather than on a step being reported
unconfirmed: a step can time out yet still have navigated a moment later, and
that leaves the URL advanced — counted as progress — so a single slow step never
trips the abort, only a genuine stall does.

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
  implementation rather than against itself. Eight test-only knobs, read once
  from the initial page URL's query string (the solver navigates by pushState
  afterwards, so the query is captured at module load), let a test opt into a
  failure mode without disturbing the default happy path: `?codes=N` generates
  a different number of codes, `?flaky=N` makes step N swallow its first
  submit, `?broken=N` makes step N reject every code, `?decoy=N` gives step N
  an extra string `useState` ahead of the code state (hook reordering),
  `?mismatch=N` makes step N's input value never equal its `code` state (a
  trailing space is appended) so the solver's value-took-the-code check always
  misses on the input's own component, `?uncontrolled=N` renders step N's
  input as an uncontrolled element in a component with no string `useState`, so
  the fiber walk finds no candidate and the solver must use the valueTracker
  fallback, `?forwardref=N` wraps step N's component in `React.forwardRef`
  so the input's owning fiber has an object `type` instead of a function, which
  the walk must still recognise as a component boundary or it walks into the
  router, and `?distractor=N` renders a decoy `<form>` ahead of step N's real
  one so the first form on the page is no longer the code form (the solver must
  submit the form its code input belongs to). Each knob defaults off, so the
  other scenarios are untouched.
- `solve.test.ts` spawns the real CLI (`node --import tsx src/solve.ts`) as a
  child process with `CHALLENGE_URL` pointed at the mock and asserts the
  observable contract over twelve scenarios:
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
  - a genuinely unpassable step (`?broken=30`) — the step loop drives to a real
    `FAILED`: exit 1, `=== FAILED ===`, "Steps that never confirmed: 30", and
    *no* false `=== COMPLETE ===`, pinning the "final URL is the ground truth"
    contract end-to-end (the other failure tests fail *before* the loop). It
    also asserts the FAILED line reports the code was "set via React fiber" —
    step 30 is strict, so this proves the failure is the site rejecting a set
    code, not the solver failing to set the input. That is the distinction
    `describeDispatch` exists to surface when the challenge is redeployed.
  - a genuine cascade (`?broken=2`, `STEP_TIMEOUT_MS=500`) — step 2 rejects every
    code, so once step 1 advances to `/step2` the run stalls there: step 2 sticks
    and step 3 (run from `/step2`) sticks too. Two consecutive non-advancing
    steps trip the early-abort, so the loop stops before step 4 instead of
    grinding 4..30 on the wrong page. Asserts exit 1, `=== FAILED ===`, the
    `Aborting: no navigation across 2 consecutive steps` line, "Steps that never
    confirmed: 2, 3" (not 2..30), and — the teeth — that "Step 4" never appears.
    Without the abort the loop runs all 30 steps; the absent "Step 4" is the
    proof it fired. (Where `?broken=30` breaks the *last* step so the abort never
    fires, this breaks an *early* one so it must.)
  - hook reordering (`?decoy=25`) — step 25 has a string `useState` ahead of the
    code state, so a solver that dispatched into the first string state would
    send the code to the wrong place and fail. The run still completes (exit 0,
    `=== COMPLETE ===`, `/finish`), proving the dispatch loop tries each
    candidate until the input takes the code. Step 25 is strict, so the recovery
    can only happen via the fiber path. The test has teeth as a regression
    guard: reverting the loop to "first string state only" makes step 25 stick
    and the run fail.
  - router safety (`?mismatch=22`) — step 22's input value never equals its
    `code` state, so the solver's value check always misses on the input's own
    component and it keeps looking. Because the walk is scoped to that component,
    it stays clear of the router (whose path is also a string `useState`) and
    still submits the right code (read from state), so the run completes. Teeth:
    widening the walk back into ancestors makes step 22 dispatch the code into
    the router, unmount the form, and the run fails with "no form to submit" /
    "no code input found".
  - valueTracker fallback (`?uncontrolled=12`) — step 12's input is uncontrolled
    and its component owns no string `useState`, so the fiber walk finds no
    candidate and the solver must fill the input via the valueTracker fallback
    (native `value` setter). The run still completes. This is the only scenario
    that exercises the fallback — every other step passes via the fiber dispatch
    — and it is a second guard on the walk's scoping: a walk that ascended "until
    it finds string state" would reach the router (the stateless input component
    owns none), dispatch the code as a route, and fail. Teeth: reverting the
    walk to that ascent makes step 12 render "Page not found" and the run fails.
  - forwardRef component (`?forwardref=23`) — step 23's component is wrapped in
    `React.forwardRef`, so the input's nearest component fiber has an object
    `type` (`{$$typeof: react.forward_ref}`) rather than a function, and that
    fiber is where the `code` state lives. A walk that recognises components only
    by `typeof type === "function"` skips past it into the router, dispatches the
    code as a route, and bricks the run; the solver instead treats the forwardRef
    fiber as a component boundary and completes. Step 23 is strict, so this can
    only pass via the fiber path. Teeth: dropping the forwardRef branch from the
    component check makes step 23 dispatch into the router and the run fails with
    "no form to submit" / "no code input found".
  - distractor form (`?distractor=24`) — a decoy `<form>` (a search box) is
    rendered ahead of step 24's real code form, so `document.querySelector("form")`
    returns the decoy. A solver that submits the first form on the page submits
    the decoy, whose onSubmit does nothing, so step 24 never advances (and every
    later step is then stuck on `/step24`). The solver instead submits the form
    its code input belongs to (`inp.form`) and the run completes. Step 24 is
    strict, so the value still comes from the fiber dispatch; the distractor only
    changes which form is submitted, and the code selector still picks the real
    input (the decoy's "Search" placeholder has no "code" in it). Teeth: reverting
    the submit target to `document.querySelector("form")` makes step 24 submit the
    decoy, stick, and the run FAIL.
  - fallback diagnostic (`?uncontrolled=30&broken=30`) — step 30 is an
    uncontrolled input that also rejects every code. Steps 1-29 pass; step 30
    fills via the fallback but never validates, so the run FAILs and the FAILED
    line must report the value was "set via valueTracker fallback" (method
    "fallback", `applied` true). This pins `describeDispatch`'s last unexercised
    branch end-to-end — proving the fallback both ran and actually filled the
    input, not that the solver failed to set it. (The uncontrolled step holds no
    `useState` at all — only a `useRef` — so the component can never own a
    string-typed state and the reported method can't drift to `fiber` on a
    retry; its broken submit simply swallows without navigating.)
- The mock app is plain-JS `React.createElement` served with React 18 UMD
  builds straight from `node_modules` (React 19 dropped UMD), so there is no
  bundler in the loop. The puzzles, modals, and distractors of the real
  challenge are deliberately absent: the solver never interacted with them.

## Running

```bash
npm install
npm run solve            # run the solver (CHALLENGE_URL, HEADLESS, STEP_TIMEOUT_MS env vars override defaults)
npm test                 # unit tests for session.ts
npm run test:integration # solver CLI vs the local mock challenge (needs Chromium installed)
npm run typecheck        # tsc --noEmit over src/ and test/
```

`solve.ts` is executed with `tsx` (no build step). `tsc` is used only for type
checking (`noEmit`).
