/* global React, ReactDOM */

/**
 * Mock of the Browser Navigation Challenge, replicating only the contract that
 * src/solve.ts depends on (the original deployment is gone — see README):
 *
 *  - all step codes written to sessionStorage["wo_session"] at START,
 *    obfuscated as JSON → repeating-key XOR ("WO_2024_CHALLENGE") → Base64;
 *  - a React 18 SPA with pushState routing (/ → /step1 … /step30 → /finish)
 *    and a controlled code input (so `input.value = ...` is ignored and the
 *    solver's fiber-dispatch path is what actually has to work);
 *  - the app's off-by-one: validating step N compares against the code of
 *    step N+1, so step 30 looks up a 31st code that was never generated;
 *  - steps 19+ ignoring synthetic input events, so only the solver's React
 *    fiber state dispatch (not the valueTracker fallback) can pass them.
 *
 * The puzzles, modals, and distractor elements of the real challenge are
 * deliberately absent: the solver never interacts with them.
 *
 * This file is plain browser JS (React.createElement, no JSX) so it can be
 * served as-is, with React loaded from UMD builds — no bundler involved.
 */

// Session encoding, mirroring the challenge's own algorithm. Implemented
// independently here (not imported from src/session.ts) so the integration
// test checks the solver's crypto against a second implementation rather
// than against itself.
const XOR_KEY = "WO_2024_CHALLENGE";
const STEP_COUNT = 30;

// Test-only knobs, read once from the *initial* page URL's query string. The
// solver navigates via pushState after START, so the query is gone by step 1 —
// we capture it here at module load. All knobs default to the original
// behavior, so the happy-path integration test (which passes no query) is
// unaffected; the other tests opt in to a specific failure mode.
const KNOBS = new URLSearchParams(window.location.search);
// How many codes to generate. Default STEP_COUNT (30). Generating a different
// number (e.g. ?codes=29) simulates the challenge format changing: the solver's
// prepareSession must reject it up front with one clear error rather than
// letting the step loop submit `undefined` thirty times.
const GEN_CODE_COUNT = Number(KNOBS.get("codes")) || STEP_COUNT;
// A step that swallows its FIRST submit and accepts the second, simulating a
// transient flake so the solver's retry path (submitStep) is exercised. 0 = no
// flaky step (the default).
const FLAKY_STEP = Number(KNOBS.get("flaky")) || 0;
// A step that rejects EVERY code, simulating a step the solver genuinely cannot
// pass (e.g. the challenge format changed so the extracted code no longer
// validates). Exercises the solver's failure path: the FAILED log, the "Steps
// that never confirmed" summary, and a non-zero exit. 0 = no broken step.
const BROKEN_STEP = Number(KNOBS.get("broken")) || 0;
// A step that declares an extra string useState *ahead of* the code state,
// simulating a redeploy that reorders hooks (e.g. adds a name/hint field). The
// code input is no longer the first string-typed useState, so a solver that
// blindly dispatches into the first one would set the wrong state and leave the
// input empty. Exercises the solver's resilience: it must try each string-state
// candidate until the input's value actually takes the code. 0 = no decoy.
const DECOY_STEP = Number(KNOBS.get("decoy")) || 0;
// A step whose input value never equals its `code` state (a trailing space is
// appended once a code is set), so the solver's "did the input take the code?"
// check always *misses* on the input's own component — even though `code`
// (which onSubmit reads) is set correctly. This forces the solver to keep
// looking past its first candidate, exercising HOW FAR it walks: a correctly
// scoped solver stays inside the input's component and still submits the right
// code from state, while one that ascended into ancestors would dispatch the
// code into the router's path useState and unmount the form. 0 = no mismatch.
const MISMATCH_STEP = Number(KNOBS.get("mismatch")) || 0;

function xor(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    out += String.fromCharCode(
      text.charCodeAt(i) ^ XOR_KEY.charCodeAt(i % XOR_KEY.length),
    );
  }
  return out;
}

const encodeSession = (data) => btoa(xor(JSON.stringify(data)));
const decodeSession = (raw) => JSON.parse(xor(atob(raw)));

// 1-indexed Map of codes, built once when the challenge starts. Like the real
// app, it lives in memory across SPA navigations and is NOT rebuilt from
// sessionStorage between steps — that is why the solver's Map.prototype.get
// patch can rely on seeing a 30-entry map when step 30 looks up key 31.
let codesMap = null;

function startChallenge() {
  const codes = Array.from(
    { length: GEN_CODE_COUNT },
    (_, i) => "WO-" + (i + 1) + "-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
  );
  sessionStorage.setItem(
    "wo_session",
    encodeSession({
      sessionId: "mock-" + Math.random().toString(36).slice(2, 10),
      codes,
      completed: [],
    }),
  );
  codesMap = new Map(codes.map((code, i) => [i + 1, code]));
}

// On a full page load mid-run (a resume), rebuild the Map from sessionStorage.
// Returns false when there is no session, i.e. the challenge was never started.
function ensureCodes() {
  if (codesMap) return true;
  const raw = sessionStorage.getItem("wo_session");
  if (!raw) return false;
  codesMap = new Map(decodeSession(raw).codes.map((code, i) => [i + 1, code]));
  return true;
}

// The challenge's validation bug, reproduced exactly: step N is checked
// against the code generated for step N+1. For step 30, `get(31)` returns
// undefined — unless the solver has patched Map.prototype.get.
function validateCode(stepNum, code) {
  return codesMap.get(stepNum + 1) === code;
}

const e = React.createElement;
const { useState, useEffect, useCallback, useRef } = React;

function usePath() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((to) => {
    window.history.pushState({}, "", to);
    setPath(to);
  }, []);
  return [path, navigate];
}

function StartPage({ navigate }) {
  return e(
    "main",
    null,
    e("h1", null, "Browser Navigation Challenge (mock)"),
    e(
      "button",
      {
        onClick: () => {
          startChallenge();
          navigate("/step1");
        },
      },
      "START",
    ),
  );
}

function StepPage({ step, navigate }) {
  // A decoy string useState placed *ahead of* the code state on the decoy step,
  // to simulate a redeploy reordering hooks. It is `null` (not a string) on
  // every other step, so it is not a fiber-walk candidate there and the code
  // input stays the first string-typed useState — existing scenarios are
  // untouched. On the decoy step it is "" (a string), so the solver finds it
  // first and must notice the input didn't take the code before moving on to
  // the real code state. Declared unconditionally to keep hook order stable.
  const [decoy] = useState(step === DECOY_STEP ? "" : null);
  void decoy;
  // The code state is the first *string-typed* useState (the decoy above is null
  // except on the decoy step). The solver walks this component's hook list from
  // the input's fiber and dispatches into each string-typed useState until the
  // input value takes the code. (`error` starts null and the submit ref holds
  // an object, so neither is mistaken for the string code state.)
  const [code, setCode] = useState("");
  const [error, setError] = useState(null);
  const submits = useRef(0);

  // On the original site, synthetic input events stopped working from step 19
  // on — the valueTracker fallback failed there and only a direct fiber state
  // dispatch could set the code. Reproduce that: strict steps ignore onChange,
  // so a fiber-walk regression in solve.ts fails this run instead of being
  // silently papered over by the fallback.
  const strict = step >= 19;

  const onSubmit = (ev) => {
    ev.preventDefault();
    // The flaky step swallows its first submit so only the solver's retry gets
    // through — exercises submitStep's retry path. The first submit returns
    // before validateCode, so `error` never becomes a string and the fiber
    // walk on retry still finds `code` as the lone string state.
    if (step === FLAKY_STEP && (submits.current += 1) === 1) return;
    // The broken step rejects every code, so the solver exhausts its retry and
    // reports the step as FAILED. `code` is still hook #1, so the fiber walk on
    // each attempt finds it before the now-string `error` state.
    if (step === BROKEN_STEP) {
      setError("Invalid code");
      return;
    }
    if (validateCode(step, code)) {
      navigate(step === STEP_COUNT ? "/finish" : "/step" + (step + 1));
    } else {
      setError("Invalid code");
    }
  };

  return e(
    "main",
    null,
    e("h1", null, "Step " + step + " of " + STEP_COUNT),
    e(
      "form",
      { onSubmit },
      e("input", {
        placeholder: "Enter code",
        // On the mismatch step the displayed value never equals `code` (a
        // trailing space is appended once a code is set), so the solver's
        // value-took-the-code check always misses — see MISMATCH_STEP. `code`
        // itself (read by onSubmit) is still the real submitted value.
        value: step === MISMATCH_STEP && code ? code + " " : code,
        onChange: strict ? () => {} : (ev) => setCode(ev.target.value),
      }),
      e("button", { type: "submit" }, "Submit Code"),
    ),
    error && e("p", { role: "alert" }, error),
  );
}

function FinishPage() {
  return e("main", null, e("h1", null, "Challenge Complete!"));
}

function NotFound() {
  return e("main", null, e("h1", null, "Page not found"));
}

function App() {
  const [path, navigate] = usePath();
  if (path === "/") return e(StartPage, { navigate });
  const stepMatch = path.match(/^\/step(\d+)$/);
  if (stepMatch) {
    const step = Number(stepMatch[1]);
    if (step >= 1 && step <= STEP_COUNT && ensureCodes()) {
      // Keyed by step so each step mounts a fresh StepPage (fresh input
      // state), as the real app's router remounts its route component.
      return e(StepPage, { key: step, step, navigate });
    }
  }
  if (path === "/finish") return e(FinishPage);
  return e(NotFound);
}

ReactDOM.createRoot(document.getElementById("root")).render(e(App));
