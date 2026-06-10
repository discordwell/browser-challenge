import { test } from "node:test";
import assert from "node:assert/strict";

import {
  XOR_KEY,
  SENTINEL_CODE,
  STEP_COUNT,
  xorCipher,
  decryptSession,
  encryptSession,
  codeForStep,
  withStep30Sentinel,
  prepareSession,
  type SessionData,
} from "../src/session.ts";

/**
 * Ground-truth vector captured from the challenge's *original* inline algorithm
 * (the loops that lived in solve.ts's page.evaluate). If the refactored cipher
 * ever diverges from what the live app expects, this exact-bytes check fails.
 *   JSON.stringify({ a: 1 }) === '{"a":1}'  ->  XOR(WO_2024_CHALLENGE) -> Base64
 */
const KNOWN_PLAINTEXT: SessionData = { a: 1 } as unknown as SessionData;
const KNOWN_BLOB = "LG0+EAoDSQ==";

test("xorCipher is symmetric (applying twice restores the input)", () => {
  const samples = ["", "A", "hello world", '{"codes":["X1","Y2"]}', "ünïcödé-ish"];
  for (const s of samples) {
    assert.equal(xorCipher(xorCipher(s)), s, `round trip failed for ${JSON.stringify(s)}`);
  }
});

test("xorCipher changes the bytes (it actually ciphers)", () => {
  // First char 'A' (0x41) XOR 'W' (0x57) = 0x16 — definitely not a no-op.
  const out = xorCipher("A");
  assert.notEqual(out, "A");
  assert.equal(out.charCodeAt(0), 0x41 ^ XOR_KEY.charCodeAt(0));
});

test("encryptSession matches the original algorithm's known output", () => {
  assert.equal(encryptSession(KNOWN_PLAINTEXT), KNOWN_BLOB);
});

test("decryptSession reverses the known blob", () => {
  assert.deepEqual(decryptSession(KNOWN_BLOB), KNOWN_PLAINTEXT);
});

test("decrypt/encrypt round-trips a realistic session", () => {
  const data: SessionData = {
    sessionId: "test-session-123",
    codes: Array.from({ length: 30 }, (_, i) => `CODE${i + 1}`),
    completed: [1, 2, 3],
  };
  assert.deepEqual(decryptSession(encryptSession(data)), data);
});

test("encryptSession handles non-Latin-1 characters (btoa would otherwise throw)", () => {
  const data: SessionData = {
    sessionId: "arrow → emoji 😀 Ā",
    codes: ["ünïcödé-ÿ", "→CODE←"],
  };
  // Must not throw, and must round-trip exactly (escapes parse back to the
  // same characters). Latin-1 like ÿ/ü stays literal, so ASCII/Latin-1-only
  // sessions still encode byte-identically to the app's own algorithm — the
  // KNOWN_BLOB test above pins that.
  assert.deepEqual(decryptSession(encryptSession(data)), data);
});

test("codeForStep encodes the off-by-one: step N submits codes[N]", () => {
  // codes[0] belongs to step 1 but is never submitted (the app wants the *next*
  // code); step 1 submits codes[1], step 29 submits codes[29], etc.
  const codes = ["c0", "c1", "c2", "c3"];
  assert.equal(codeForStep(codes, 1), "c1");
  assert.equal(codeForStep(codes, 2), "c2");
  assert.equal(codeForStep(codes, 3), "c3");
});

test("withStep30Sentinel appends the sentinel and supplies step 30's code", () => {
  const data: SessionData = { codes: Array.from({ length: 30 }, (_, i) => `c${i}`) };
  const prepared = withStep30Sentinel(data);

  assert.equal(prepared.codes.length, 31);
  assert.equal(prepared.codes[30], SENTINEL_CODE);
  // Step 30 now has a value to submit, which equals the sentinel.
  assert.equal(codeForStep(prepared.codes, 30), SENTINEL_CODE);
});

test("withStep30Sentinel does not mutate the input and preserves other fields", () => {
  const data: SessionData = { sessionId: "s", codes: ["a", "b"], completed: [1] };
  const prepared = withStep30Sentinel(data);

  assert.equal(data.codes.length, 2, "original codes array must be untouched");
  assert.equal(prepared.sessionId, "s");
  assert.deepEqual(prepared.completed, [1]);
  assert.notEqual(prepared.codes, data.codes, "should be a fresh array, not aliased");
});

test("codeForStep throws a clear error when the step has no code", () => {
  const codes = ["c0", "c1"];
  assert.throws(() => codeForStep(codes, 2), RangeError);
  assert.throws(() => codeForStep(codes, 30), /No code available for step 30/);
});

test("prepareSession decrypts, validates, and appends the sentinel", () => {
  const data: SessionData = {
    sessionId: "live-ish",
    codes: Array.from({ length: STEP_COUNT }, (_, i) => `CODE${i}`),
    completed: [],
  };
  const prepared = prepareSession(encryptSession(data));

  assert.equal(prepared.codes.length, STEP_COUNT + 1);
  assert.equal(prepared.codes[STEP_COUNT], SENTINEL_CODE);
  assert.equal(prepared.sessionId, "live-ish");
  // Every step 1..STEP_COUNT now has a submittable code.
  for (let step = 1; step <= STEP_COUNT; step++) {
    assert.equal(typeof codeForStep(prepared.codes, step), "string");
  }
});

test("prepareSession rejects a session with the wrong number of codes", () => {
  const short: SessionData = { codes: ["only", "two"] };
  assert.throws(
    () => prepareSession(encryptSession(short)),
    new RegExp(`Expected ${STEP_COUNT} string codes in wo_session, got 2 codes`),
  );
});

test("prepareSession rejects a session where codes is not an array", () => {
  const bogus = { codes: "nope" } as unknown as SessionData;
  assert.throws(
    () => prepareSession(encryptSession(bogus)),
    /codes of type string/,
  );
});

test("prepareSession rejects non-object sessions with the clear error, not a TypeError", () => {
  const blobOfNull = encryptSession(null as unknown as SessionData);
  assert.throws(() => prepareSession(blobOfNull), /challenge format changed\?/);
});

test("prepareSession rejects codes containing non-strings", () => {
  const numeric = {
    codes: Array.from({ length: STEP_COUNT }, (_, i) => i),
  } as unknown as SessionData;
  assert.throws(
    () => prepareSession(encryptSession(numeric)),
    /non-string code entries/,
  );
});

test("prepareSession wraps decode failures in a contextual error", () => {
  // Not valid Base64 at all → atob throws inside decryptSession.
  assert.throws(() => prepareSession("!!!"), /Could not decode wo_session/);
  // Valid Base64 of garbage → JSON.parse throws after XOR.
  assert.throws(
    () => prepareSession(btoa("garbage")),
    /Could not decode wo_session/,
  );
});

test("the prepared session still round-trips through the cipher", () => {
  const data: SessionData = {
    sessionId: "abc",
    codes: Array.from({ length: 30 }, (_, i) => `K${i}`),
    completed: [],
  };
  const prepared = withStep30Sentinel(data);
  assert.deepEqual(decryptSession(encryptSession(prepared)), prepared);
});
