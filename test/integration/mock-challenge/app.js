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
// A step that renders an *uncontrolled* input (no `value`/`onChange`; its value
// is read from the DOM on submit) in a component that holds NO string useState.
// The solver's fiber walk therefore finds no string-state dispatcher in the
// input's own component and must fall back to the valueTracker path (set
// `inp.value` via the native setter + dispatch input/change) to fill it. This
// is the ONLY scenario that exercises that fallback: every other step's input
// is a controlled component whose code state the fiber dispatch sets directly.
// It also pins the walk's scoping — because the input's own component owns no
// string state, a walk that ascended "until it finds string state" would sail
// past it into the router (App's path useState) and dispatch the code as a
// route, unmounting the form and bricking the run. A correctly scoped walk
// stops at the input's own component, finds nothing, and falls back. 0 = none.
const UNCONTROLLED_STEP = Number(KNOBS.get("uncontrolled")) || 0;
// A step whose owning component is wrapped in React.forwardRef, so the input's
// nearest component fiber has an *object* type ({$$typeof: react.forward_ref})
// rather than a function — and that fiber is where the code state lives. A
// solver that recognises the input's component only by `typeof type ===
// "function"` walks straight past the forwardRef fiber into the router (App's
// path useState), dispatches the extracted code as a route, unmounts the form,
// and bricks the run. The solver must treat a forwardRef fiber as a component
// boundary too. (React.memo of a plain function needs no special handling: React
// resolves a SimpleMemoComponent's `type` back to the inner function, so the
// `typeof === "function"` check already stops there. forwardRef is the case it
// doesn't catch.) 0 = none.
const FORWARDREF_STEP = Number(KNOBS.get("forwardref")) || 0;
// A step that renders a DECOY <form> *ahead of* the real code form, standing in
// for the real challenge's distractor widgets (newsletter/search forms, etc.).
// The decoy holds no code input and its onSubmit does nothing, so submitting it
// never navigates. Because it is rendered first, document.querySelector("form")
// returns the decoy — so a solver that submits "the first form on the page"
// submits the decoy and the step never advances. The solver must instead submit
// the form its code input actually belongs to (`inp.form`). 0 = no distractor.
const DISTRACTOR_STEP = Number(KNOBS.get("distractor")) || 0;

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
    // A decoy form rendered AHEAD of the real one on the distractor step, so
    // document.querySelector("form") (the first form) returns this one. It has no
    // code input and its onSubmit does nothing, so submitting it never advances —
    // the solver must submit the form its code input belongs to instead. Its
    // "Search" input also has no "code" in its placeholder, so the code selector
    // still picks the real input. `false` on every other step renders nothing.
    step === DISTRACTOR_STEP &&
      e(
        "form",
        { onSubmit: (ev) => ev.preventDefault() },
        e("input", { placeholder: "Search the site" }),
        e("button", { type: "submit" }, "Search"),
      ),
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

// StepPage wrapped in React.forwardRef. Calling StepPage(props) inline (a plain
// function call, not React.createElement) runs StepPage's hooks during *this*
// forwardRef component's render, so the forwardRef fiber — the input's nearest
// component ancestor — is what holds the `code` string state. That makes the
// input's owning fiber have an object `type` ({$$typeof: react.forward_ref})
// instead of a function, which the solver's component walk must still recognise.
// The `ref` is unused (the input is controlled); it exists only so React creates
// a genuine ForwardRef fiber. See FORWARDREF_STEP. Routed to only when that knob
// selects this step.
const ForwardRefStep = React.forwardRef(function ForwardRefStepInner(props, ref) {
  void ref;
  return StepPage(props);
});

// A step whose input is *uncontrolled*: no `value`/`onChange`, so React never
// overwrites what the DOM holds, and onSubmit reads the value straight off the
// input via a ref. Crucially this component holds its only state in a `useRef`
// (an object) and declares NO `useState` at all, so it can never own a
// string-typed state — the solver's fiber walk finds no candidate here and must
// use the valueTracker fallback to fill the input. (We deliberately don't render
// an "Invalid code" message via state the way StepPage does: the solver only
// reads the URL, never the error UI, and keeping the component state-free makes
// the "no string useState" property structural rather than contingent on
// validation passing.) See UNCONTROLLED_STEP. Routed to only when that knob
// selects this step; every other step uses the controlled StepPage above.
function UncontrolledStep({ step, navigate }) {
  const inputRef = useRef(null);

  const onSubmit = (ev) => {
    ev.preventDefault();
    // The broken step rejects every code (swallow without navigating); see
    // BROKEN_STEP. Used by the fallback-diagnostic test to drive a genuine
    // FAILED whose dispatch method is "fallback".
    if (step === BROKEN_STEP) return;
    const code = inputRef.current ? inputRef.current.value : "";
    if (validateCode(step, code)) {
      navigate(step === STEP_COUNT ? "/finish" : "/step" + (step + 1));
    }
  };

  return e(
    "main",
    null,
    e("h1", null, "Step " + step + " of " + STEP_COUNT),
    e(
      "form",
      { onSubmit },
      e("input", { ref: inputRef, placeholder: "Enter code" }),
      e("button", { type: "submit" }, "Submit Code"),
    ),
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
      // Keyed by step so each step mounts a fresh page (fresh input state), as
      // the real app's router remounts its route component. The uncontrolled and
      // forwardRef steps use their own page variants; every other step uses the
      // controlled StepPage. (Both knobs default to 0, which no real step equals,
      // so the default path is StepPage.)
      const Page =
        step === UNCONTROLLED_STEP
          ? UncontrolledStep
          : step === FORWARDREF_STEP
            ? ForwardRefStep
            : StepPage;
      return e(Page, { key: step, step, navigate });
    }
  }
  if (path === "/finish") return e(FinishPage);
  return e(NotFound);
}

ReactDOM.createRoot(document.getElementById("root")).render(e(App));
