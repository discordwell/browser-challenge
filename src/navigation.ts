/**
 * Pure routing/error logic for the solver, kept out of the browser glue in
 * solve.ts so it can be unit-tested without launching Chromium.
 *
 * Two things live here: building the URL patterns the solver waits on between
 * steps, and classifying the Playwright errors that actually mean "the page
 * navigated" (a success for this solver, not a failure). Both are easy to get
 * subtly wrong, so they get fast deterministic tests like the cipher does.
 *
 * See ARCHITECTURE.md for how this fits into the overall solver.
 */

/**
 * Anchored regex matching the route for a single step, e.g. `/step2` but not
 * `/step20`. The anchor (end of string, or one of `/ ? #`) is what keeps a
 * substring like `step2` from spuriously matching `/step20`…`/step29`; an
 * unanchored `/step2/` would. The leading slash keeps it from matching inside
 * a host or query value too.
 */
export function stepPattern(step: number): RegExp {
  return new RegExp(`/step${step}(?:$|[/?#])`);
}

/** Terminal route — reaching it is the ground truth that the run succeeded. */
export const FINISH_PATTERN = /\/finish(?:$|[/?#])/;

/**
 * The route to expect after submitting `step` of `stepCount`: the next step's
 * page, or the finish page after the last step.
 */
export function nextRoutePattern(step: number, stepCount: number): RegExp {
  return step < stepCount ? stepPattern(step + 1) : FINISH_PATTERN;
}

/**
 * Playwright errors that mean the page navigated out from under an in-flight
 * `page.evaluate` — for this solver that is a success (React Router moved to
 * the next step), not a real error. Matched case-insensitively because the
 * casing varies across messages ("Execution context was destroyed, most likely
 * because of a navigation", "frame got detached").
 *
 * Deliberately keyed on the context-destroyed / detached signals, NOT the bare
 * word "navigation": a `waitForURL` *timeout* message also contains
 * "navigation" ("waiting for navigation to … until load") but means the page
 * did NOT advance — a real failure we want logged, not silently swallowed.
 */
const NAVIGATION_ERROR = /detached|execution context/i;

/** True when `error` is one of the "page navigated" errors (see {@link NAVIGATION_ERROR}). */
export function isNavigationError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return NAVIGATION_ERROR.test(message);
}
