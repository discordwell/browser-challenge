import { test } from "node:test";
import assert from "node:assert/strict";

import {
  describeDispatch,
  errorMessage,
  truncate,
  type DispatchResult,
} from "../src/diagnostics.ts";

test("describeDispatch: no result means the dispatch threw (likely navigation)", () => {
  assert.equal(describeDispatch(undefined), "dispatch threw (navigation?)");
});

test("describeDispatch: a non-ok result surfaces its reason verbatim", () => {
  const noInput: DispatchResult = {
    ok: false,
    reason: "no code input found",
    method: "none",
  };
  const noForm: DispatchResult = {
    ok: false,
    reason: "no form to submit",
    method: "fiber",
  };
  assert.equal(describeDispatch(noInput), "no code input found");
  assert.equal(describeDispatch(noForm), "no form to submit");
});

test("describeDispatch: method 'none' reports the input could not be set", () => {
  // No fiber state and no usable value setter — nothing was even attempted.
  const result: DispatchResult = { ok: true, method: "none", applied: false };
  assert.match(describeDispatch(result), /could NOT be set/);
});

test("describeDispatch: a value that was set and stuck reports the method", () => {
  const fiber: DispatchResult = { ok: true, method: "fiber", applied: true };
  const fallback: DispatchResult = { ok: true, method: "fallback", applied: true };
  assert.equal(describeDispatch(fiber), "code set via React fiber dispatch");
  assert.equal(describeDispatch(fallback), "code set via valueTracker fallback");
});

test("describeDispatch: dispatched-but-not-applied points at the plumbing, not the code", () => {
  // The whole point of `applied`: a fiber dispatch into the WRONG useState
  // "succeeds" as a method but leaves the input empty, so the diagnostic must
  // not claim "code set via React fiber dispatch" (which would send a debugger
  // hunting for a code/format change). It must instead flag the input/selector.
  const stranded: DispatchResult = { ok: true, method: "fiber", applied: false };
  const message = describeDispatch(stranded);
  assert.match(message, /never took the code/);
  assert.match(message, /hook reordering|selector/);
  assert.doesNotMatch(message, /code set via/);
});

test("describeDispatch: applied is checked before the method message for the fallback too", () => {
  const stranded: DispatchResult = { ok: true, method: "fallback", applied: false };
  assert.match(describeDispatch(stranded), /never took the code/);
});

test("errorMessage: an Error yields its message; anything else is stringified", () => {
  assert.equal(errorMessage(new Error("boom")), "boom");
  assert.equal(errorMessage("plain string"), "plain string");
  assert.equal(errorMessage(42), "42");
  assert.equal(errorMessage(null), "null");
  assert.equal(errorMessage({ toString: () => "obj" }), "obj");
});

test("truncate: short text is unchanged; long text is clipped to max", () => {
  assert.equal(truncate("short"), "short");
  assert.equal(truncate("x".repeat(100)).length, 80);
  assert.equal(truncate("hello world", 5), "hello");
  // Exactly at the limit is left whole (slice is end-exclusive).
  assert.equal(truncate("12345", 5), "12345");
});
