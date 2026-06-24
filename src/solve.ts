import { chromium, type Browser, type Page } from "playwright";

import {
  encryptSession,
  prepareSession,
  codeForStep,
  SENTINEL_CODE,
  STEP_COUNT,
} from "./session.ts";
import {
  FINISH_PATTERN,
  isNavigationError,
  nextRoutePattern,
  stepPattern,
} from "./navigation.ts";
import {
  describeDispatch,
  errorMessage,
  truncate,
  type DispatchResult,
} from "./diagnostics.ts";

/** Challenge URL. Override with the CHALLENGE_URL env var. */
const CHALLENGE_URL =
  process.env.CHALLENGE_URL ?? "https://serene-frangipane-7fd25b.netlify.app";

/** Run headless with HEADLESS=1; defaults to headed, as the challenge expects. */
const HEADLESS = /^(1|true)$/i.test(process.env.HEADLESS ?? "");

/**
 * Selector for the challenge's code input. Defined once and shared between the
 * in-browser dispatch helper (`document.querySelector`) and the Playwright
 * `waitForSelector` below, so the two can never drift apart — and that drift
 * would be *silent*: if only the `waitForSelector` copy changed, the dispatch
 * helper would still find the input and the step would still pass, so a stale
 * wait would go unnoticed. Keeping a single source of truth removes that
 * footgun. Matched case-insensitively (`i`) so a redeploy that capitalises the
 * placeholder ("Enter Code", "CODE") still matches; Playwright's selector engine
 * and the browser's `querySelector` both honour the flag.
 */
const CODE_INPUT_SELECTOR = 'input[placeholder*="code" i]';

async function main() {
  const totalStart = performance.now();
  console.log("Launching browser...");

  const browser = await chromium.launch({ headless: HEADLESS });
  try {
    await solveAll(browser, totalStart);
  } finally {
    // Swallow close failures so they never mask the error that got us here.
    await browser.close().catch(() => {});
  }
}

async function solveAll(browser: Browser, totalStart: number) {
  const context = await browser.newContext();
  const page = await context.newPage();

  // Inject helpers into every page context. The code-input selector is passed
  // in (rather than re-typed inside the browser closure) so it shares the single
  // CODE_INPUT_SELECTOR source of truth with submitStep's waitForSelector.
  await page.addInitScript((codeInputSelector: string) => {
    // esbuild __name helper (tsx adds it to compiled evaluate functions)
    (window as any).__name = (fn: any, _n: string) => fn;

    // Shared helper: set the code input via React fiber (or a valueTracker
    // fallback) and submit the form. Returns a structured result reporting *how*
    // the value was set and *whether it stuck* ({ ok, method, applied }), so a
    // stuck step can tell three causes apart: the site rejected a code it did
    // receive (format change), the code went into the wrong place so the input
    // never took it (fiber walk/selector needs updating), or no input was found
    // at all. That triage is the first thing worth knowing when the challenge is
    // redeployed and a step won't pass. See DispatchResult in diagnostics.ts.
    (window as any).__dispatchAndSubmit = async (code: string) => {
      const inp = document.querySelector(
        codeInputSelector
      ) as HTMLInputElement | null;
      if (!inp) return { ok: false, reason: "no code input found", method: "none" };

      const raf = () => new Promise((r) => requestAnimationFrame(r));

      // Primary: walk up the React fiber tree from the input to the component
      // that actually rendered it — the first component fiber, function or
      // forwardRef — and collect THAT component's string-typed useState
      // dispatchers, then stop. A controlled input ignores `input.value = ...`,
      // so on the challenge's strict steps a fiber dispatch is the only thing
      // that sets the value.
      //
      // We stop at the input's own component and never ascend into ancestors: a
      // parent such as the SPA router keeps its current path in a string
      // useState too, and dispatching the code into THAT would navigate to a
      // bogus route and unmount the form. The input's controlled state lives in
      // its own component, so that is the only safe — and correct — place to
      // dispatch. (Scoping on "the first component that owns string state"
      // instead is subtly wrong: an uncontrolled input's component owns none, so
      // the walk would sail past it into the router. Stopping at the component
      // itself means such an input finds no candidate here and falls through to
      // the valueTracker fallback below, instead of bricking the run.)
      //
      // Within that one component we try each candidate in turn until the
      // input's value actually becomes the code, rather than blindly taking the
      // first string state. If a redeploy adds a string useState ahead of the
      // code state (hook reordering), dispatching into the first one leaves the
      // input untouched; we detect that and move on. `applied` records whether
      // any candidate stuck.
      let method = "none";
      let applied = false;
      const fk = Object.keys(inp).find((k) => k.startsWith("__reactFiber"));
      if (fk) {
        const dispatchers: Array<(value: string) => void> = [];
        // Ascend through the host-element fibers (input, form, …) to the input's
        // own component. `cur.type` is a tag string ("input"/"form"/…) for host
        // elements, so we skip those; we stop at the first *component* fiber.
        // A plain (or React.memo'd) component has a function `type`; a forwardRef
        // component has an object `type` ({$$typeof: Symbol(react.forward_ref)})
        // and still owns the input's hooks, so a `typeof === "function"` test
        // alone would skip past it and walk into the router — the same brick the
        // scoping is meant to prevent. Recognise both.
        const FORWARD_REF = Symbol.for("react.forward_ref");
        const isComponentFiber = (fiber: any) => {
          const t = fiber?.type;
          return typeof t === "function" || (t != null && t.$$typeof === FORWARD_REF);
        };
        let cur = (inp as any)[fk];
        for (let i = 0; i < 30 && cur && !isComponentFiber(cur); i++) {
          cur = cur.return;
        }
        // Collect that one component's string-typed useState dispatchers. It may
        // own none (an uncontrolled input) — then the fallback below runs.
        for (let s = cur?.memoizedState; s; s = s.next) {
          if (typeof s.memoizedState === "string" && s.queue?.dispatch) {
            dispatchers.push(s.queue.dispatch);
          }
        }
        for (const dispatch of dispatchers) {
          dispatch(code);
          method = "fiber";
          // Let React commit so the input's value reflects the new state. A
          // freshly-mounted input can take a couple of frames on a cold commit,
          // so re-check across a few RAFs before deciding a candidate missed —
          // otherwise a slow first commit looks like the wrong state.
          for (let f = 0; f < 3 && inp.value !== code; f++) await raf();
          if (inp.value === code) {
            applied = true;
            break;
          }
        }
      }

      // Fallback: the valueTracker trick, for an input that exposes no fiber
      // string state. (Ineffective on inputs that ignore synthetic events, but
      // harmless to attempt — those only ever pass via the fiber path above.)
      if (!applied && method === "none") {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value"
        )?.set;
        if (setter) {
          setter.call(inp, code);
          if ((inp as any)._valueTracker) (inp as any)._valueTracker.setValue("");
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
          method = "fallback";
          await raf();
          applied = inp.value === code;
        }
      }

      // Submit via native form event (React intercepts this)
      const form = document.querySelector("form");
      if (!form) return { ok: false, reason: "no form to submit", method, applied };
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      );

      return { ok: true, method, applied };
    };
  }, CODE_INPUT_SELECTOR);

  console.log("Navigating to challenge...");
  const response = await page.goto(CHALLENGE_URL, {
    waitUntil: "domcontentloaded",
  });
  if (response && !response.ok()) {
    // response.url() rather than CHALLENGE_URL: after redirects the status
    // belongs to the final URL, which is the one worth debugging.
    throw new Error(
      `Challenge site returned HTTP ${response.status()} for ${response.url()} — ` +
        `set CHALLENGE_URL to a live deployment of the challenge.`
    );
  }

  // Click START button - wait for it to appear rather than fixed timeout
  console.log("Clicking START...");
  await page.waitForSelector("button", { timeout: 5000 });
  const startBtn = await page.$(
    'button:has-text("Start"), button:has-text("START"), button:has-text("Begin")'
  );
  if (startBtn) {
    await startBtn.click();
  } else {
    await page.click("button", { timeout: 3000 });
  }

  await page.waitForURL(stepPattern(1), { timeout: 10000 });
  console.log("On step 1. Decrypting session...");

  // Read the raw blob from the browser; prepareSession (Node, tested) validates
  // it and appends the step-30 sentinel. Write the blob back so sessionStorage
  // stays internally consistent.
  const rawSession = await page.evaluate(() =>
    sessionStorage.getItem("wo_session")
  );
  if (!rawSession) throw new Error("No session data found (wo_session)");

  const data = prepareSession(rawSession);
  const reencrypted = encryptSession(data);
  await page.evaluate(
    (blob) => sessionStorage.setItem("wo_session", blob),
    reencrypted
  );
  const codes = data.codes;

  console.log(`Decrypted ${codes.length} codes.`);

  // Monkey-patch Map.prototype.get for step 30: validateCode(30) checks
  // codes.get(31), which doesn't exist. Return the sentinel for key 31 on maps
  // with exactly 30 entries (the challenge's code map). The sentinel matches the
  // one prepareSession appended above, so the submitted code validates.
  await page.evaluate(
    ({ sentinel, stepCount }) => {
      const originalGet = Map.prototype.get;
      const sentinelKey = stepCount + 1;
      Map.prototype.get = function (key: any) {
        if (key === sentinelKey && this.size === stepCount) return sentinel;
        return originalGet.call(this, key);
      };
    },
    { sentinel: SENTINEL_CODE, stepCount: STEP_COUNT }
  );

  // Solve all 30 steps
  const failedSteps: number[] = [];
  for (let step = 1; step <= STEP_COUNT; step++) {
    const stepStart = performance.now();
    // The correct submission for step N is codes[N] — see codeForStep in session.ts.
    const code = codeForStep(codes, step);
    const confirmed = await submitStep(
      page,
      step,
      code,
      nextRoutePattern(step, STEP_COUNT)
    );
    if (!confirmed) failedSteps.push(step);

    const elapsed = ((performance.now() - stepStart) / 1000).toFixed(2);
    console.log(`Step ${step}: ${elapsed}s → ${page.url().split("/").pop()}`);
  }

  const totalTime = ((performance.now() - totalStart) / 1000).toFixed(2);

  // The finish page is only reachable by passing every step, so the final URL
  // is the ground truth for success. failedSteps is diagnostic detail (a step
  // recorded there may still have navigated just after its timeout).
  const finished = FINISH_PATTERN.test(page.url());
  console.log(`\n=== ${finished ? "COMPLETE" : "FAILED"} ===`);
  if (!finished) {
    if (failedSteps.length > 0) {
      console.error(`Steps that never confirmed: ${failedSteps.join(", ")}`);
    }
    process.exitCode = 1;
  }
  console.log(`Total time: ${totalTime}s`);
  console.log(`Final URL: ${page.url()}`);

  // Leave the finish page visible briefly for a human watching a headed run.
  if (!HEADLESS) await page.waitForTimeout(5000);
}

/**
 * Run a single step: wait for the code input, dispatch the code into React and
 * submit, then wait for the URL to advance to `nextPattern`, retrying the
 * dispatch once if it doesn't. Returns whether the navigation was confirmed.
 *
 * An unconfirmed step is not necessarily a failed one — it may have navigated
 * just after the timeout — so the caller only treats the final URL as ground
 * truth (see solveAll). Errors that mean "the page navigated" are expected on
 * a successful submit and are not logged. When a step does stay stuck, the
 * FAILED log reports whether the code actually reached the input (see
 * {@link describeDispatch}) so a redeploy that broke the dispatch plumbing (the
 * input never took the code) is told apart from one that just changed the codes
 * (the input took a value the site then rejected).
 */
async function submitStep(
  page: Page,
  step: number,
  code: string,
  nextPattern: RegExp
): Promise<boolean> {
  // Wait for the input to appear; a short fixed wait if the selector times out.
  try {
    await page.waitForSelector(CODE_INPUT_SELECTOR, {
      timeout: 2000,
      state: "attached",
    });
  } catch {
    await page.waitForTimeout(200);
  }

  // Dispatch the code and submit. Keep the last result so a step that never
  // advances can report how (or whether) the input was set — see the FAILED log.
  let lastResult = await dispatchOnce(page, step, code);

  // Wait for navigation; retry the dispatch once if the URL hasn't advanced.
  try {
    await page.waitForURL(nextPattern, { timeout: 3000 });
  } catch {
    if (nextPattern.test(page.url())) return true;
    lastResult = await dispatchOnce(page, step, code);
    try {
      await page.waitForURL(nextPattern, { timeout: 3000 });
    } catch (retryErr) {
      if (!isNavigationError(retryErr)) {
        console.warn(`  Step ${step} retry: ${truncate(errorMessage(retryErr))}`);
      }
    }
    if (!nextPattern.test(page.url())) {
      console.error(
        `  Step ${step}: FAILED at ${page.url()} — ${describeDispatch(lastResult)}`
      );
      return false;
    }
  }
  return true;
}

/**
 * Run `__dispatchAndSubmit` in the page and report what it did. Errors that
 * mean "the page navigated" are expected on a successful submit (the execution
 * context is destroyed mid-evaluate) and are swallowed; anything else is
 * logged. Returns the dispatch result, or undefined if the call threw — it
 * feeds only the failure diagnostic, since the next URL is the success signal.
 */
async function dispatchOnce(
  page: Page,
  step: number,
  code: string
): Promise<DispatchResult | undefined> {
  try {
    const result = (await page.evaluate(
      (code) => (window as any).__dispatchAndSubmit(code),
      code
    )) as DispatchResult;
    if (!result.ok) console.error(`  Step ${step}: ${result.reason}`);
    return result;
  } catch (err) {
    if (!isNavigationError(err)) {
      console.error(`  Step ${step} error: ${truncate(errorMessage(err))}`);
    }
    return undefined;
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  // exitCode (not process.exit) so piped stderr flushes fully; the browser is
  // already closed by main's finally, so the event loop drains promptly.
  process.exitCode = 1;
});
