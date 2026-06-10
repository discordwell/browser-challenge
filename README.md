# Browser Challenge Speed Solver

Solves all 30 steps of the [Browser Navigation Challenge](https://serene-frangipane-7fd25b.netlify.app) in under 25 seconds using Playwright.

## Quick Start

```bash
npm install
npm run solve        # or: npx tsx src/solve.ts
```

Override the target or run headless with env vars:

```bash
CHALLENGE_URL=https://example.com HEADLESS=1 npm run solve
```

### Development

```bash
npm test         # unit tests for the session crypto / index logic
npm run typecheck   # tsc --noEmit over src/ and test/
```

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
input.__reactFiber → walk .return chain → find memoizedState with string type → queue.dispatch(code)
```

### 3. Native Form Submit

After dispatching the code, we fire a native `submit` event on the form element. React intercepts this and processes it through its event system, triggering the validation and navigation.

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
  session.ts   # Pure logic: XOR cipher, decrypt/encrypt, code-for-step mapping. No browser.
  solve.ts     # Orchestration: drives Chromium, dispatches into React, navigates steps.
test/
  session.test.ts   # Unit tests for session.ts (node:test)
```

The browser glue stays in one file (`solve.ts`); only the pure, easily-mistaken
logic is split out. The XOR cipher and the step-30 off-by-one index math are the
parts most likely to break silently, so they live in `session.ts` where they're
covered by unit tests instead of only being exercised against a live website.
An earlier version inlined the crypto inside `page.evaluate`; it was moved to
Node so the tests and the solver run the exact same code path.

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
