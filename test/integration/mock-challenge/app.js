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
    { length: STEP_COUNT },
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
const { useState, useEffect, useCallback } = React;

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
  // The code state must be the first hook: the solver walks this component's
  // hook list from the input's fiber and dispatches into the first
  // string-typed useState it finds.
  const [code, setCode] = useState("");
  const [error, setError] = useState(null);

  // On the original site, synthetic input events stopped working from step 19
  // on — the valueTracker fallback failed there and only a direct fiber state
  // dispatch could set the code. Reproduce that: strict steps ignore onChange,
  // so a fiber-walk regression in solve.ts fails this run instead of being
  // silently papered over by the fallback.
  const strict = step >= 19;

  const onSubmit = (ev) => {
    ev.preventDefault();
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
        value: code,
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
