import { test } from "node:test";
import assert from "node:assert/strict";

import {
  XOR_KEY,
  SENTINEL_CODE,
  xorCipher,
  decryptSession,
  encryptSession,
  codeForStep,
  withStep30Sentinel,
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

test("the prepared session still round-trips through the cipher", () => {
  const data: SessionData = {
    sessionId: "abc",
    codes: Array.from({ length: 30 }, (_, i) => `K${i}`),
    completed: [],
  };
  const prepared = withStep30Sentinel(data);
  assert.deepEqual(decryptSession(encryptSession(prepared)), prepared);
});
