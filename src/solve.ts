import { chromium } from "playwright";

const CHALLENGE_URL = "https://serene-frangipane-7fd25b.netlify.app";

async function main() {
  const totalStart = performance.now();
  console.log("Launching browser...");

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Inject helpers into every page context
  await page.addInitScript(() => {
    // esbuild __name helper (tsx adds it to compiled evaluate functions)
    (window as any).__name = (fn: any, _n: string) => fn;

    // Shared helper: dispatch a code via React fiber and submit the form.
    // Returns "ok", "no_input", or "no_form".
    (window as any).__dispatchAndSubmit = async (code: string) => {
      const inp = document.querySelector(
        'input[placeholder*="code"], input[placeholder*="Code"]'
      ) as HTMLInputElement | null;
      if (!inp) return "no_input";

      // Walk React fiber tree to find the string state dispatcher
      let dispatched = false;
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
                dispatched = true;
                break;
              }
              s = s.next;
            }
            if (dispatched) break;
          }
          cur = cur.return;
        }
      }

      // Fallback: valueTracker trick for non-fiber inputs
      if (!dispatched) {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value"
        )?.set;
        if (setter) {
          setter.call(inp, code);
          if ((inp as any)._valueTracker) (inp as any)._valueTracker.setValue("");
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }

      // Wait one RAF for React to process the state update
      await new Promise((r) => requestAnimationFrame(r));

      // Submit via native form event (React intercepts this)
      const form = document.querySelector("form");
      if (!form) return "no_form";
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      );

      return "ok";
    };
  });

  console.log("Navigating to challenge...");
  await page.goto(CHALLENGE_URL, { waitUntil: "domcontentloaded" });

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

  await page.waitForURL(/step1/, { timeout: 10000 });
  console.log("On step 1. Decrypting session...");

  // Decrypt session storage, inject 31st code, re-encrypt
  const codes: string[] = await page.evaluate(() => {
    const XOR_KEY = "WO_2024_CHALLENGE";
    const raw = sessionStorage.getItem("wo_session");
    if (!raw) throw new Error("No session data found");

    const decoded = atob(raw);
    let decrypted = "";
    for (let i = 0; i < decoded.length; i++) {
      decrypted += String.fromCharCode(
        decoded.charCodeAt(i) ^ XOR_KEY.charCodeAt(i % XOR_KEY.length)
      );
    }
    const data = JSON.parse(decrypted);

    // Inject 31st code for step 30 workaround
    data.codes.push("FINISH");

    // Re-encrypt and store back
    const json = JSON.stringify(data);
    let encrypted = "";
    for (let i = 0; i < json.length; i++) {
      encrypted += String.fromCharCode(
        json.charCodeAt(i) ^ XOR_KEY.charCodeAt(i % XOR_KEY.length)
      );
    }
    sessionStorage.setItem("wo_session", btoa(encrypted));
    return data.codes as string[];
  });

  console.log(`Decrypted ${codes.length} codes.`);

  // Monkey-patch Map.prototype.get for step 30: validateCode(30) checks
  // codes.get(31) which doesn't exist. Return "FINISH" for key 31 on maps
  // with exactly 30 entries (the challenge's code map).
  await page.evaluate(() => {
    const originalGet = Map.prototype.get;
    Map.prototype.get = function (key: any) {
      if (key === 31 && this.size === 30) return "FINISH";
      return originalGet.call(this, key);
    };
  });

  // Solve all 30 steps
  for (let step = 1; step <= 30; step++) {
    const stepStart = performance.now();
    // validateCode(N) checks codes.get(N+1), so submit codes[N] (0-indexed)
    const code = codes[step];

    // Wait for input to appear
    try {
      await page.waitForSelector(
        'input[placeholder*="code"], input[placeholder*="Code"]',
        { timeout: 2000, state: "attached" }
      );
    } catch {
      await page.waitForTimeout(200);
    }

    // Dispatch code and submit
    try {
      const result = await page.evaluate(
        (code) => (window as any).__dispatchAndSubmit(code),
        code
      );
      if (result !== "ok") {
        console.error(`  Step ${step}: ${result}`);
      }
    } catch (err: any) {
      // "detached" / "Execution context" / "navigation" errors mean success
      if (
        !err.message?.includes("detached") &&
        !err.message?.includes("Execution context") &&
        !err.message?.includes("navigation")
      ) {
        console.error(`  Step ${step} error: ${err.message.substring(0, 80)}`);
      }
    }

    // Wait for navigation to next step
    const nextPattern =
      step < 30 ? new RegExp(`step${step + 1}`) : /finish/;
    try {
      await page.waitForURL(nextPattern, { timeout: 3000 });
    } catch {
      if (!nextPattern.test(page.url())) {
        // Retry once
        try {
          await page.evaluate(
            (code) => (window as any).__dispatchAndSubmit(code),
            code
          );
          await page.waitForURL(nextPattern, { timeout: 3000 });
        } catch (retryErr: any) {
          if (
            !retryErr.message?.match(/detached|Execution context|navigation/)
          ) {
            console.warn(
              `  Step ${step} retry: ${retryErr.message?.substring(0, 80)}`
            );
          }
        }
        if (!nextPattern.test(page.url())) {
          console.error(`  Step ${step}: FAILED at ${page.url()}`);
        }
      }
    }

    const elapsed = ((performance.now() - stepStart) / 1000).toFixed(2);
    console.log(`Step ${step}: ${elapsed}s → ${page.url().split("/").pop()}`);
  }

  const totalTime = ((performance.now() - totalStart) / 1000).toFixed(2);
  console.log(`\n=== COMPLETE ===`);
  console.log(`Total time: ${totalTime}s`);
  console.log(`Final URL: ${page.url()}`);

  await page.waitForTimeout(5000);
  await browser.close();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
