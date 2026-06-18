/**
 * Pure diagnostic/reporting logic for the solver, kept out of the browser glue
 * in solve.ts so it can be unit-tested without launching Chromium (and without
 * importing solve.ts, which runs `main()` on import).
 *
 * The one thing that actually matters when the challenge is redeployed and a
 * step won't pass is *why*: was the code set but rejected (a format/code
 * change), or did we never get it into the input at all (the fiber walk or the
 * selector needs updating)? `solve.ts`'s in-browser `__dispatchAndSubmit`
 * returns a {@link DispatchResult} recording how it tried; the functions here
 * turn that into a one-line answer for the FAILED log.
 *
 * See ARCHITECTURE.md for how this fits into the overall solver.
 */

/** How `__dispatchAndSubmit` tried to set the input value. */
export type SetMethod = "fiber" | "fallback" | "none";

/**
 * Structured result of one `__dispatchAndSubmit` call, mirroring the helper
 * injected via `addInitScript` in solve.ts.
 *
 * - `ok` — the form was submitted (vs. no input/form was found at all).
 * - `method` — whether the value reached React via the fiber dispatch, the
 *   valueTracker fallback, or neither.
 * - `applied` — whether the input's value *actually became the code* after the
 *   attempt. This is the honest signal: a fiber dispatch into the wrong
 *   `useState` (e.g. a redeploy added a string state ahead of the code state)
 *   "succeeds" as a method but leaves the input untouched, so `applied` is
 *   false. Distinguishing the two is the whole point of the FAILED diagnostic.
 */
export type DispatchResult =
  | { ok: true; method: SetMethod; applied: boolean }
  | { ok: false; reason: string; method: SetMethod; applied?: boolean };

/**
 * One-line summary of a dispatch result for the FAILED log. The point is to
 * separate three causes a stuck step can have on a redeployed challenge:
 *
 *  - the input was never found / couldn't be set at all (`method: "none"`);
 *  - the code was dispatched but the input never took it — the fiber walk hit
 *    the wrong `useState`, or the selector no longer matches (`applied: false`);
 *  - the code was set into the input fine, so the site itself rejected it — a
 *    code/format change rather than a solver-plumbing change (`applied: true`).
 *
 * Only the last means "update the codes"; the first two mean "update the
 * dispatch plumbing", and conflating them is exactly the time sink this avoids.
 */
export function describeDispatch(result: DispatchResult | undefined): string {
  if (!result) return "dispatch threw (navigation?)";
  if (!result.ok) return result.reason;
  if (result.method === "none") {
    return "code could NOT be set (no fiber state, no fallback)";
  }
  if (!result.applied) {
    return (
      `dispatched via ${result.method} but the input never took the code ` +
      "— wrong useState (hook reordering?) or the code selector changed"
    );
  }
  return result.method === "fiber"
    ? "code set via React fiber dispatch"
    : "code set via valueTracker fallback";
}

/** Best-effort message for logging an unknown thrown value. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Clip an error message so a stray stack/long line can't flood the log. */
export function truncate(text: string, max = 80): string {
  return text.slice(0, max);
}
