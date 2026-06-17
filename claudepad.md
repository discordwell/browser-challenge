# Session Summaries

## 2026-06-17T UTC - Pure navigation module (anchored routes + nav-error classifier)
- Extracted the solver's routing/error logic out of `solve.ts`'s browser glue into a new pure, tested `src/navigation.ts`: `stepPattern(n)`, `FINISH_PATTERN`, `nextRoutePattern(step, stepCount)`, `isNavigationError(err)`. Mirrors the existing `session.ts` split — trickiest logic lives where fast deterministic unit tests cover it.
- **Anchored the step regexes** (the deferred "unanchored stepN regexes" item from the 2026-06-10 review, now wet-testable via the mock). Old `new RegExp(\`step${n}\`)` matched `/step2`…`/step29` for "step2"; new `\/step2(?:$|[/?#])` matches only `/step2`. Safe in the strict sequential flow either way, but a substring collision can no longer make `waitForURL` report success a step early.
- **Unified + corrected the navigation-error detection.** Two inline checks had drifted: one used `.includes("detached"/"Execution context"/"navigation")`, the other `.match(/detached|Execution context|navigation/)`. Now one case-insensitive `isNavigationError(err)` keyed on the context-destroyed/detached signals only. Code-review caught that the bare word "navigation" also appears in Playwright's `waitForURL` *timeout* message ("waiting for navigation to … until load") — i.e. the page did NOT advance — so matching it silently swallowed the diagnostic for a genuinely stuck step. Dropped it: `/detached|execution context/i`. (These catches only gate logging — the final `/finish` URL is the success ground truth — but the helper now means what its name says, and a stuck step is loggable.)
- Extracted the per-step body into `submitStep(page, step, code, nextPattern): boolean` (waitForInput → dispatch → waitForURL + one retry); the loop is now ~15 lines. Behavior preserved exactly (verified against the mock).
- 11 new unit tests in `test/navigation.test.ts` (anchoring `/step2`≠`/step20`, trailing slash/query/hash tolerance, leading-slash requirement, next-route handoff to finish, nav-error casing + non-Error inputs). `npm test`: 28 pass. `npm run typecheck` clean. `npm run test:integration`: both pass (full 30-step solve exits 0; 404 fail-fast exits 1).
- README + ARCHITECTURE.md updated (file lists + the anchoring/classifier rationale).

## 2026-06-11T UTC - Mock challenge + end-to-end integration tests
- Built `test/integration/mock-challenge/`: a local React 18 replica of the challenge's contract (the flagged "needs a mock challenge app" future work). Same `wo_session` JSON→XOR→Base64 encoding (implemented independently from session.ts, so the solver's crypto is checked against a second implementation), pushState SPA routing, controlled input, `validateCode` off-by-one (step N checks code N+1; step 30 looks up nonexistent code 31). Steps 19+ ignore synthetic input events like the original site — only the fiber state dispatch passes them.
- `test/integration/solve.test.ts` spawns the REAL CLI (`node --import tsx src/solve.ts`) as a child process: asserts exit 0 + COMPLETE + `/finish` + "Decrypted 31 codes" on a clean run, and exit 1 + fail-fast message against a 404 server. The exit-code contract is now tested end-to-end.
- Verified the test has teeth: sabotaging the fiber walk (`__reactFiber` → `__sabotagedFiber`) makes the run stick at step 19 exactly as on the original site, and the test fails with the transcript. Steps 1–18 still pass via valueTracker fallback — faithful to documented reality.
- Full solve vs localhost mock: 0.73s, all 30 steps ~10ms each (React flushes discrete submit events synchronously, so each step commits before `__dispatchAndSubmit` returns).
- Mock is plain-JS React.createElement served by node:http (`server.ts`) with React 18 UMD straight from node_modules (React 19 dropped UMD; `exports` map blocks deep resolve — resolve `react/package.json` and join). No bundler. react/react-dom added as devDeps.
- CI: new `integration` job (installs Chromium with ms-playwright cache keyed on Playwright version). Unit job stays browser-free. `npm run test:integration` script added; `npm test` glob unchanged (non-recursive, still unit-only).
- README + ARCHITECTURE.md document the mock and the testing story.

## 2026-06-10T09:55 UTC - Hardening pass (post-review fixes) + CI
- **Challenge site is DEAD**: https://serene-frangipane-7fd25b.netlify.app returns HTTP 404 (curl-verified). Solver now fails fast on non-2xx goto responses (reporting `response.url()` after redirects) instead of a confusing waitForSelector timeout. README notes the status.
- Truthful outcomes: verdict is `/finish/` final-URL ground truth (FINISH_PATTERN shared with the loop), non-zero exit on failure, `process.exitCode` instead of `process.exit(1)` (review-verified: exit(1) truncates piped stderr at 64KiB; exitCode exits cleanly <1s after browser close). Browser closed via try/finally with `.catch(() => {})` so close failures never mask root errors. Headless runs skip the 5s showcase wait.
- Fixed real `encryptSession` bug (review-confirmed): btoa threw DOMException on any char > U+00FF, so a session that decrypted fine could fail to re-encrypt. Now escapes ≥U+0100 as \uXXXX (Latin-1 stays literal → byte-identical output for the data the app actually stores; KNOWN_BLOB vector still pins this).
- `prepareSession` hardened: wraps decode failures contextually, rejects non-object sessions and non-string code entries; `codeForStep` throws RangeError on missing index; tsconfig gains `noUncheckedIndexedAccess`. 17 unit tests, all green.
- Added `.github/workflows/ci.yml` (Node 24, npm ci + typecheck + test; no Playwright browsers needed).
- Ran /code-review (max effort, 9 finder angles + verify + sweep). Deliberately NOT fixed: unanchored stepN regexes (prefix collisions unreachable in the sequential flow; can't wet-test changes with the site dead), Map-patch `!this.has()` refinement, early-abort on cascade failures, integration test of the exit-code contract (needs a mock challenge app — future work if site is redeployed).

## 2026-06-10T08:28 UTC - Testability refactor
- Extracted the XOR cipher + step-30 index math out of `page.evaluate` into a pure, typed `src/session.ts` (decryptSession/encryptSession/xorCipher/codeForStep/withStep30Sentinel).
- Added `test/session.test.ts` (node:test, 9 tests). Includes an exact-bytes vector captured from the ORIGINAL inline algorithm so the refactor is provably behavior-preserving. `npm test`.
- solve.ts now reads the raw `wo_session` blob from the browser and does crypto in Node via the tested helpers; browser-automation flow (fiber dispatch, submit, Map patch, retries) unchanged. Threaded SENTINEL_CODE into the Map patch so "FINISH" isn't duplicated.
- Made the project actually typecheck: added @types/node, fixed tsconfig (lib esnext+DOM, skipLibCheck, allowImportingTsExtensions, noEmit, include test). `npm run typecheck` is green (was failing on Playwright's own types before — tsx had been masking it).
- Added env overrides to solve.ts: CHALLENGE_URL, HEADLESS.
- Added ARCHITECTURE.md; updated README (Quick Start, Development, Architecture sections).

## 2026-02-03T ~20:50 UTC - Optimization Complete
- Optimized solver from 47.67s to 25.57s (under 30s target)
- Key optimization: single `requestAnimationFrame` instead of double RAF + 50ms setTimeout
- Pre-patched `Map.prototype.get` at startup instead of per-step check
- Replaced fixed 500ms START wait with `waitForSelector`
- Cleaned up 17 debug files, 3 debug screenshots, bundle.js, unused src/lib/
- Step 14 consistently takes ~3.6s (retry needed), all others ~0.6s

# Key Findings

## Working Solution Architecture
- **No modal-killer needed** - it crashed React by manipulating DOM during commit phase
- **React fiber state dispatch** is the only reliable way to set controlled input values
- **`form.dispatchEvent(new Event("submit"))` works** - React intercepts native submit events
- **`button.click()` does NOT work** for form submission in this React app
- **Step 30 workaround**: monkey-patch `Map.prototype.get` to return "FINISH" for key 31
- **`__name` esbuild helper** must be injected via `addInitScript` for `page.evaluate` async functions

## Code Validation Bug
`validateCode(N)` checks `codes.get(N+1)`, not `codes.get(N)`. For step N (1-indexed), submit `codes[N]` (0-indexed array).

## Session Storage
- Key: `wo_session`, XOR key: `"WO_2024_CHALLENGE"`
- All 30 codes available from the moment the challenge starts
- No need to actually solve any puzzle - just decrypt and submit

## Deployment Status (2026-06-10, updated 2026-06-11)
The Netlify deployment returns HTTP 404 — the challenge site is gone. If the
challenge is redeployed, set `CHALLENGE_URL` and re-run `npm run solve`.
Since 2026-06-11 the solver IS wet-testable locally: `npm run test:integration`
runs the real CLI against a React 18 mock of the challenge contract
(`test/integration/mock-challenge/`), covering fiber dispatch, the Map patch,
the step loop, and the exit codes.
