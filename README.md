# Browser Challenge Speed Solver

Solves all 30 steps of the [Browser Navigation Challenge](https://serene-frangipane-7fd25b.netlify.app) in under 25 seconds using Playwright.

> **Status (June 2026):** the original Netlify deployment currently returns
> HTTP 404. The solver detects this and fails fast with a clear error; point
> `CHALLENGE_URL` at a live deployment of the challenge to run it, or run
> `npm run demo` to watch it beat the bundled local replica. The solver
> itself stays verifiable end-to-end against that replica —
> see `npm run test:integration` below.

## Quick Start

```bash
npm install
npx playwright install chromium   # once, for the browser build
npm run demo         # serve the bundled replica locally and watch the solver beat it
npm run solve        # run against a live deployment (see Status note above)
```

Override the target, run headless, or tune the per-step navigation timeout with
env vars:

```bash
CHALLENGE_URL=https://example.com HEADLESS=1 STEP_TIMEOUT_MS=3000 npm run solve
```

The process exits non-zero if the run does not end on the finish page, so it
can be scripted/CI'd. If a step genuinely stalls — the URL stops advancing
across two consecutive steps, e.g. the codes no longer validate — the solver
aborts the loop rather than grinding every remaining step through its full
`STEP_TIMEOUT_MS` retry budget on the wrong page, so a broken run reports
`FAILED` in seconds instead of minutes. (A step that navigated just after its
timeout still counts as progress, so a single slow step never trips the abort.)

### Development

```bash
npm test                 # unit tests for the session crypto / index logic
npm run typecheck        # tsc --noEmit over src/, test/, and scripts/
npm run test:integration # the real solver CLI vs a local mock challenge
```

The integration suite spins up a local replica of the challenge
(`test/integration/mock-challenge/`) — a real React 18 SPA with the same
sessionStorage encryption, the same `validateCode` off-by-one, and steps 19+
ignoring synthetic input events as the original site did — then runs the
actual solver CLI against it and asserts the exit-code contract. It covers a
clean 30-step run, the fail-fast on a dead site (404), the fail-fast on a
malformed session (one clear error, not thirty per-step failures), recovery
via the retry path when a step drops its first submit, recovery from hook
reordering when a string `useState` is added ahead of the code state, the
dispatch staying scoped to the input's own component (never the router) when
the value check misses, an uncontrolled input with no string `useState`
(the only shape that exercises the valueTracker fallback — and another guard
that the scoped walk never reaches the router), a `forwardRef`-wrapped input
component (whose owning fiber has an object type, not a function — the walk has
to recognise it as a component boundary or it walks into the router), a decoy
`<form>` rendered ahead of the real one (the solver has to submit the form its
code input belongs to, not the first form on the page, or it submits the decoy
and the step never advances), a code input the selector can no longer find
(the placeholder loses the word "code", as a redeploy might rename it — the
run reports `no code input found` on both the per-attempt log and the step's
FAILED line, the triage signal that the *selector* needs updating, then aborts
once genuinely stalled), and a
genuinely unpassable step — the run reports it as `FAILED`, lists it under
"Steps that never confirmed", and exits non-zero rather than printing a false
`COMPLETE`, its diagnostic line separating a code the site *rejected* (which
was set fine — change the codes) from one the input *never took* (change the
fiber walk or selector) — and a genuine cascade (an *early* step that stalls), where the
solver aborts the loop after two consecutive non-advancing steps instead of
grinding all the way to step 30 on the wrong page. The suite also smoke-tests
`npm run demo` end-to-end, so the one runnable showcase left can't rot
silently. It needs the Playwright
Chromium build (`npx playwright install chromium`).

Everything runs in CI on pushes to `main` and on pull requests
(`.github/workflows/ci.yml`); the unit-test job is pure Node and needs no
Playwright browsers, the integration job installs Chromium.

## How It Works

The challenge presents 30 steps, each with a different browser puzzle (modals, canvas drawing, timers, drag-and-drop, etc.) that reveals a code to enter before advancing. The intended path takes several minutes of manual interaction.

This solver bypasses all of it.

### 1. Session Storage Decryption

All 30 codes are stored in `sessionStorage` from the moment the challenge starts, encrypted with XOR + Base64:

```
sessionStorage["wo_session"] → Base64 decode → XOR with "WO_2024_CHALLENGE" → JSON
```

We decrypt them on step 1 and never need to interact with any puzzle. The script reads the raw blob out of the browser and decrypts it in Node, using the tested helpers in `src/session.ts`.

### 2. React Fiber State Dispatch

The code input is a React controlled component. Native value setting (`input.value = ...`) doesn't work because React ignores it. Instead, we walk the React fiber tree from the input element to find the `useState` dispatcher and call it directly:

```
input.__reactFiber → walk .return to the input's own component → collect its string-typed useState dispatchers
                   → dispatch into each until the input's value actually becomes the code
```

We collect the string-typed `useState` dispatchers of the *input's own component* and try them in order until the input's value actually takes the code, rather than blindly dispatching into the first one. Two things make this robust:

- **Stay in the input's component.** We stop the walk at the input's own component — the first component up the tree from the input element — and never ascend into ancestors. A parent like the SPA router keeps its current path in a string `useState` too, and dispatching the code into *that* would navigate to a bogus route and unmount the form — so an unscoped walk could brick a run. The input's controlled state lives in its own component, so that's the only safe — and correct — place to look. (Scoping instead on "the first component that *owns string state*" is subtly wrong: an uncontrolled input's component owns none, so that walk would sail past it into the router. Stopping at the component itself means such an input simply finds no candidate and falls through to the fallback below.) "Component" here means a function component *or* a `forwardRef` one: a `forwardRef`'s fiber has an object `type` (`{$$typeof: Symbol(react.forward_ref)}`), not a function, yet it still owns the input's hooks — so a `typeof type === "function"` test alone would skip past it into the router. (A `React.memo`'d function component needs no special case: React resolves its fiber `type` back to the inner function.)
- **Try each candidate.** If the challenge is redeployed with a string `useState` ahead of the code state (hook reordering — e.g. an added name/hint field), dispatching into the first state would leave the input empty and silently fail the step; trying each candidate (re-checking the value across a few frames so a slow first commit isn't mistaken for a miss) recovers from that.

If the input's component exposes no string `useState` at all (an uncontrolled input that reads its value from the DOM), there's no fiber candidate to dispatch into, so we fall back to the *valueTracker* trick: set `input.value` via the native setter and fire `input`/`change`. This is the only path that doesn't go through a fiber dispatch; it's covered end-to-end by the `?uncontrolled=N` mock scenario.

The dispatch result records whether the code actually stuck (`applied`), so a stuck step's diagnostic can tell "the input never took the code" (plumbing broke) apart from "the site rejected a code it did receive" (codes changed).

### 3. Native Form Submit

After dispatching the code, we fire a native `submit` event on the form element. React intercepts this and processes it through its event system, triggering the validation and navigation. We submit the form the code input actually belongs to (`inp.form`), not the first `<form>` on the page — the real challenge is littered with distractor widgets, so a decoy form ahead of the real one would otherwise swallow the event and the step would never advance. This is the same precision the input selector and the fiber walk already apply, carried through to the submit.

### 4. Step 30 Edge Case

The app's `validateCode(N)` has an off-by-one: it checks `codes.get(N+1)` instead of `codes.get(N)`. For step 30, this means it looks up `codes.get(31)` which doesn't exist (only 30 codes are generated). We monkey-patch `Map.prototype.get` to return `"FINISH"` when key 31 is requested on a 30-entry map.

## Optimizations

### From 48s to 23s

The initial working version completed all 30 steps in ~48 seconds. Here's what got it under 25:

| Optimization | Time Saved | Detail |
|---|---|---|
| Single RAF instead of double RAF + 50ms | ~20s | The original used `requestAnimationFrame(() => requestAnimationFrame(r))` plus a 50ms `setTimeout` between dispatch and submit. React processes the state update within a single animation frame, so one `requestAnimationFrame` is sufficient. |
| Event-driven START wait | ~0.3s | Replaced a fixed 500ms `waitForTimeout` with `waitForSelector('button')` which returns as soon as the button renders. |
| Reduced input wait timeout | variable | Lowered `waitForSelector` timeout from 5s to 2s. The input renders quickly on every step; the timeout only matters when something goes wrong. |
| Extracted shared helper via `addInitScript` | reliability | Moved the fiber dispatch + submit logic into a `window.__dispatchAndSubmit` function injected via `addInitScript`. Eliminates code duplication between the primary and retry paths, fixing a bug where the retry path could dispatch to multiple fiber nodes. |
| Scoped Map monkey-patch | reliability | Added `this.size === 30` guard so the `Map.prototype.get` patch only triggers on the challenge's code map, not on unrelated Maps used by React internals. |
| Pre-applied Map patch | ~0.05s | Apply the monkey-patch once at startup instead of checking `if (step === 30)` on every iteration. |

### What Didn't Work

- **`queueMicrotask` for submit**: Tried scheduling the form submit as a microtask instead of waiting for RAF. React doesn't process `dispatch` synchronously in microtasks — it needs the animation frame cycle.
- **Modal killer script**: An `addInitScript` that auto-dismissed popups on a 100ms interval. It crashed the React app by manipulating the DOM during React's commit phase on route changes.
- **`button.click()` for submission**: Native button clicks don't propagate correctly through React's synthetic event system in this app. `form.dispatchEvent(new Event("submit"))` works.

## Architecture

```
src/
  session.ts      # Pure logic: XOR cipher, decrypt/encrypt, code-for-step mapping. No browser.
  navigation.ts   # Pure logic: anchored step/finish URL patterns + "page navigated" error classifier.
  diagnostics.ts  # Pure logic: dispatch-result types + the one-line "why did this step fail" message.
  solve.ts        # Orchestration: drives Chromium, dispatches into React, navigates steps.
test/
  session.test.ts      # Unit tests for session.ts (node:test)
  navigation.test.ts   # Unit tests for navigation.ts (node:test)
  diagnostics.test.ts  # Unit tests for diagnostics.ts (node:test)
  integration/
    solve.test.ts   # Runs the real solver CLI against the mock challenge
    demo.test.ts    # Smoke-tests `npm run demo` end-to-end
    mock-challenge/ # Local React 18 replica of the challenge's contract
scripts/
  demo.ts           # npm run demo: serve the replica locally, run the solver at it
```

The browser glue stays in one file (`solve.ts`); only the pure, easily-mistaken
logic is split out. The XOR cipher and the step-30 off-by-one index math
(`session.ts`), the route matching (`navigation.ts`), and the failure-diagnostic
message (`diagnostics.ts`) are the parts most likely to break silently, so they
live in pure modules where they're covered by unit tests instead of only being
exercised against a live website. The step URL patterns are anchored —
`/step2` won't match `/step20` — so a substring collision can't make the step
loop think it advanced early. An earlier version inlined the crypto inside
`page.evaluate`; it was moved to Node so the tests and the solver run the exact
same code path. (`solve.ts` can't be imported in a unit test — it runs `main()`
on import — which is the concrete reason the pure logic lives in its own
modules.)

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full data flow.

## Typical Run

```
Launching browser...
Navigating to challenge...
Clicking START...
On step 1. Decrypting session...
Decrypted 31 codes.
Step 1: 0.66s → step2
Step 2: 1.57s → step3
Step 3: 0.70s → step4
...
Step 29: 0.65s → step30
Step 30: 0.65s → finish

=== COMPLETE ===
Total time: 23.04s
Final URL: https://serene-frangipane-7fd25b.netlify.app/finish
```
