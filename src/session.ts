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

/** Number of steps in the challenge, and the number of codes it generates. */
export const STEP_COUNT = 30;

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

/**
 * Inverse of {@link decryptSession}: JSON → XOR → Base64.
 *
 * Characters above U+00FF are written as `\uXXXX` escapes: JSON.parse reads
 * them identically, but left literal they would survive the all-ASCII XOR key
 * with high bits set and make `btoa` throw. Latin-1 stays literal so output is
 * byte-identical to the app's own encoding for the data it actually stores.
 */
export function encryptSession(data: SessionData, key: string = XOR_KEY): string {
  const json = JSON.stringify(data).replace(
    /[Ā-￿]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
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
  const code = codes[step];
  if (code === undefined) {
    throw new RangeError(
      `No code available for step ${step} (have ${codes.length} codes)`,
    );
  }
  return code;
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

/**
 * Single entry point used by the solver: decrypt the raw `wo_session` blob,
 * verify it has the shape the rest of the run depends on (exactly
 * {@link STEP_COUNT} codes — the step loop and the `Map.prototype.get` patch
 * both assume it), and append the step-30 sentinel.
 *
 * Failing here turns a challenge-format change into one clear error instead of
 * thirty confusing per-step failures from submitting `undefined`.
 */
export function prepareSession(raw: string, key: string = XOR_KEY): SessionData {
  let data: unknown;
  try {
    data = decryptSession(raw, key);
  } catch (cause) {
    throw new Error(
      `Could not decode wo_session (wrong XOR key or encoding change?): ${cause}`,
    );
  }

  const codes =
    data !== null && typeof data === "object"
      ? (data as SessionData).codes
      : undefined;
  if (
    !Array.isArray(codes) ||
    codes.length !== STEP_COUNT ||
    !codes.every((c) => typeof c === "string")
  ) {
    const got = !Array.isArray(codes)
      ? `codes of type ${codes === null ? "null" : typeof codes}`
      : codes.length !== STEP_COUNT
        ? `${codes.length} codes`
        : "non-string code entries";
    throw new Error(
      `Expected ${STEP_COUNT} string codes in wo_session, got ${got} — challenge format changed?`,
    );
  }
  return withStep30Sentinel(data as SessionData);
}
