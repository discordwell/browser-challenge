import { test } from "node:test";
import assert from "node:assert/strict";

import {
  stepPattern,
  FINISH_PATTERN,
  nextRoutePattern,
  isNavigationError,
} from "../src/navigation.ts";

const url = (path: string) => `http://127.0.0.1:5173${path}`;

test("stepPattern matches its own step's URL", () => {
  for (const step of [1, 2, 9, 19, 30]) {
    assert.ok(
      stepPattern(step).test(url(`/step${step}`)),
      `stepPattern(${step}) should match /step${step}`,
    );
  }
});

test("stepPattern is anchored: /step2 does not match /step20…/step29", () => {
  // The whole point of anchoring — an unanchored /step2/ matched all of these.
  const two = stepPattern(2);
  assert.equal(two.test(url("/step20")), false);
  assert.equal(two.test(url("/step21")), false);
  assert.equal(two.test(url("/step29")), false);
  // …and step1's pattern must not match step10..step19 either.
  const one = stepPattern(1);
  assert.equal(one.test(url("/step10")), false);
  assert.equal(one.test(url("/step19")), false);
});

test("stepPattern tolerates a trailing slash, query, or hash", () => {
  const two = stepPattern(2);
  assert.ok(two.test(url("/step2/")));
  assert.ok(two.test(url("/step2?from=start")));
  assert.ok(two.test(url("/step2#top")));
});

test("stepPattern requires the leading slash (no host/query false matches)", () => {
  // A bare "step2" substring with no slash in front must not match.
  assert.equal(stepPattern(2).test("https://step2.example.com/"), false);
});

test("FINISH_PATTERN matches the finish route but not step routes", () => {
  assert.ok(FINISH_PATTERN.test(url("/finish")));
  assert.ok(FINISH_PATTERN.test(url("/finish/")));
  assert.equal(FINISH_PATTERN.test(url("/step30")), false);
});

test("nextRoutePattern returns the next step until the last, then finish", () => {
  const stepCount = 30;
  // Step N expects /step(N+1).
  assert.ok(nextRoutePattern(1, stepCount).test(url("/step2")));
  assert.ok(nextRoutePattern(29, stepCount).test(url("/step30")));
  // The final step expects /finish, not /step31.
  assert.equal(nextRoutePattern(30, stepCount), FINISH_PATTERN);
  assert.ok(nextRoutePattern(30, stepCount).test(url("/finish")));
});

test("nextRoutePattern for an early step rejects a later step's URL", () => {
  // Regression guard for the unanchored-regex bug: waiting for step2 must not
  // be satisfied by landing on step20.
  assert.equal(nextRoutePattern(1, 30).test(url("/step20")), false);
});

test("isNavigationError recognises Playwright's 'page navigated' errors", () => {
  const messages = [
    "Execution context was destroyed, most likely because of a navigation",
    "frame got detached",
    "Target frame detached",
    "Target page, context or browser has been closed: frame detached",
  ];
  for (const message of messages) {
    assert.ok(
      isNavigationError(new Error(message)),
      `should classify as navigation error: ${message}`,
    );
  }
});

test("isNavigationError is case-insensitive (real messages vary in casing)", () => {
  // The old inline `.includes(...)` check was case-sensitive; the regex isn't.
  assert.ok(isNavigationError(new Error("EXECUTION CONTEXT was destroyed")));
  assert.ok(isNavigationError(new Error("the frame was DETACHED")));
});

test("isNavigationError rejects a waitForURL timeout (the page did NOT navigate)", () => {
  // Playwright's timeout message contains the word "navigation" ("waiting for
  // navigation to … until load"), but a timeout means the step is stuck — a
  // real failure that must be logged, not silently treated as a success. The
  // classifier keys on context-destroyed/detached, not the bare word, so this
  // is correctly NOT a navigation error.
  const timeout = new Error(
    'Timeout 3000ms exceeded.\nwaiting for navigation to "/step5" until "load"',
  );
  assert.equal(isNavigationError(timeout), false);
});

test("isNavigationError returns false for unrelated errors", () => {
  assert.equal(isNavigationError(new Error("No session data found")), false);
  assert.equal(isNavigationError(new Error("connect ECONNREFUSED")), false);
});

test("isNavigationError handles non-Error values without throwing", () => {
  assert.ok(isNavigationError("context or browser has been detached"));
  assert.equal(isNavigationError(undefined), false);
  assert.equal(isNavigationError(null), false);
  assert.equal(isNavigationError({ message: "detached" }), false); // not an Error, no string
});
