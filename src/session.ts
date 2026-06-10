/**
 * Pure session-storage logic for the browser challenge.
 *
 * The challenge stashes all 30 step codes in `sessionStorage["wo_session"]`,
 * obfuscated with a repeating-key XOR cipher and Base64. None of this needs a
 * browser, so it lives here as plain, testable functions. `solve.ts` only uses
 * the browser to read and write the raw blob; the crypto and the index math run
 * in Node where they can be unit-tested.
 *
 * See ARCHITECTURE.md for how this fits into the overall solver.
 */

/** Key used by the challenge for the repeating-key XOR cipher. */
export const XOR_KEY = "WO_2024_CHALLENGE";

/**
 * Value submitted for step 30. The app's off-by-one validation looks up a 31st
 * code that the challenge never generates; appending this sentinel gives us
 * something to submit, and the `Map.prototype.get` patch in solve.ts makes the
 * lookup return the same value so validation passes. See {@link withStep30Sentinel}.
 */
export const SENTINEL_CODE = "FINISH";

/** Decrypted shape of `sessionStorage["wo_session"]`. Extra fields are preserved. */
export interface SessionData {
  sessionId?: string;
  /** Step codes, 0-indexed: `codes[0]` is the code generated for step 1, etc. */
  codes: string[];
  completed?: number[];
  [key: string]: unknown;
}

/**
 * Apply the repeating-key XOR cipher to a Latin-1 (binary) string.
 *
 * The cipher is symmetric: `xorCipher(xorCipher(s)) === s`. It operates on
 * character codes, so callers must hand it a binary string (e.g. the output of
 * `atob`), not arbitrary Unicode.
 */
export function xorCipher(text: string, key: string = XOR_KEY): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    out += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return out;
}

/** Decode the `wo_session` blob: Base64 → XOR → JSON. */
export function decryptSession(raw: string, key: string = XOR_KEY): SessionData {
  const decoded = atob(raw);
  const json = xorCipher(decoded, key);
  return JSON.parse(json) as SessionData;
}

/** Inverse of {@link decryptSession}: JSON → XOR → Base64. */
export function encryptSession(data: SessionData, key: string = XOR_KEY): string {
  const json = JSON.stringify(data);
  const xored = xorCipher(json, key);
  return btoa(xored);
}

/**
 * The value to submit for a given step (1-indexed).
 *
 * The app's `validateCode(step)` compares the submitted value against
 * `codes.get(step + 1)` in its 1-indexed Map (an off-by-one bug). The Map's key
 * K holds the array element `codes[K - 1]`, so `codes.get(step + 1)` is
 * `codes[step]` (0-indexed). Hence the correct submission for `step` is
 * `codes[step]` — the code "belonging" to the *next* step.
 */
export function codeForStep(codes: readonly string[], step: number): string {
  return codes[step];
}

/**
 * Return a copy of `data` with {@link SENTINEL_CODE} appended to `codes`.
 *
 * Step 30 makes `validateCode(30)` look up `codes.get(31)`, which the challenge
 * never generates (only 30 codes exist). The appended sentinel becomes
 * `codes[30]`, the value {@link codeForStep} returns for step 30, and the
 * `Map.prototype.get` patch in solve.ts makes the live lookup return it too.
 */
export function withStep30Sentinel(
  data: SessionData,
  sentinel: string = SENTINEL_CODE,
): SessionData {
  return { ...data, codes: [...data.codes, sentinel] };
}
