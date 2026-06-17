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

/** Challenge URL. Override with the CHALLENGE_URL env var. */
const CHALLENGE_URL =
  process.env.CHALLENGE_URL ?? "https://serene-frangipane-7fd25b.netlify.app";

/** Run headless with HEADLESS=1; defaults to headed, as the challenge expects. */
const HEADLESS = /^(1|true)$/i.test(process.env.HEADLESS ?? "");

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

  // Inject helpers into every page context
  await page.addInitScript(() => {
    // esbuild __name helper (tsx adds it to compiled evaluate functions)
    (window as any).__name = (fn: any, _n: string) => fn;

    // Shared helper: set the code input via React fiber (or a valueTracker
    // fallback) and submit the form. Returns a structured result reporting *how*
    // the value was set ({ ok, method } / { ok, reason, method }), so a stuck
    // step can distinguish "the site rejected the code" from "we never managed
    // to set the input at all" — the first thing worth knowing when the
    // challenge is redeployed and a step won't pass. See DispatchResult below.
    (window as any).__dispatchAndSubmit = async (code: string) => {
      const inp = document.querySelector(
        'input[placeholder*="code"], input[placeholder*="Code"]'
      ) as HTMLInputElement | null;
      if (!inp) return { ok: false, reason: "no code input found", method: "none" };

      // Primary: walk the React fiber tree from the input to the nearest
      // string-typed useState and call its dispatcher directly. A controlled
      // input ignores `input.value = ...`, so on the challenge's strict steps
      // this is the only thing that sets the value.
      let method = "none";
      const fk = Object.keys(inp).find((k) => k.startsWith("__reactFiber"));
      if (fk) {
        let cur = (inp as any)[fk];
        for (let i = 0; i < 30 && cur; i++) {
          if (cur.memoizedState) {
            let s = cur.memoizedState;
            while (s) {
              if (
                typeof s.memoizedState === "string" &&
                s.queue?.dispatch
              ) {
                s.queue.dispatch(code);
                method = "fiber";
                break;
              }
              s = s.next;
            }
            if (method === "fiber") break;
          }
          cur = cur.return;
        }
      }

      // Fallback: the valueTracker trick, for an input that exposes no fiber
      // string state. (Ineffective on inputs that ignore synthetic events, but
      // harmless to attempt — those only ever pass via the fiber path above.)
      if (method === "none") {
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
        }
      }

      // Wait one RAF for React to process the state update
      await new Promise((r) => requestAnimationFrame(r));

      // Submit via native form event (React intercepts this)
      const form = document.querySelector("form");
      if (!form) return { ok: false, reason: "no form to submit", method };
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      );

      return { ok: true, method };
    };
  });

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
 * FAILED log reports how the input was set (see {@link describeDispatch}) so a
 * redeploy that broke the dispatch is told apart from one that just changed the
 * codes.
 */
async function submitStep(
  page: Page,
  step: number,
  code: string,
  nextPattern: RegExp
): Promise<boolean> {
  // Wait for the input to appear; a short fixed wait if the selector times out.
  try {
    await page.waitForSelector(
      'input[placeholder*="code"], input[placeholder*="Code"]',
      { timeout: 2000, state: "attached" }
    );
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

/** How `__dispatchAndSubmit` set the input value, for the failure diagnostic. */
type SetMethod = "fiber" | "fallback" | "none";

/**
 * Structured result of one `__dispatchAndSubmit` call, mirroring the helper
 * injected via `addInitScript`. `ok` means the form was submitted; `method`
 * records whether the value reached React via the fiber dispatch, the
 * valueTracker fallback, or neither.
 */
type DispatchResult =
  | { ok: true; method: SetMethod }
  | { ok: false; reason: string; method: SetMethod };

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

/**
 * One-line summary of a dispatch result for the FAILED log. The point is to
 * separate "the code was set but the site rejected it" (a format/code change)
 * from "we never managed to set the input" (the fiber walk or fallback needs
 * updating) — the key question when a step gets stuck on a redeployed challenge.
 */
function describeDispatch(result: DispatchResult | undefined): string {
  if (!result) return "dispatch threw (navigation?)";
  if (!result.ok) return result.reason;
  switch (result.method) {
    case "fiber":
      return "code set via React fiber dispatch";
    case "fallback":
      return "code set via valueTracker fallback";
    default:
      return "code could NOT be set (no fiber state, no fallback)";
  }
}

/** Best-effort message for logging an unknown thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Clip an error message so a stray stack/long line can't flood the log. */
function truncate(text: string, max = 80): string {
  return text.slice(0, max);
}

main().catch((err) => {
  console.error("Fatal:", err);
  // exitCode (not process.exit) so piped stderr flushes fully; the browser is
  // already closed by main's finally, so the event loop drains promptly.
  process.exitCode = 1;
});
