// resume.mjs — tell the difference between "the agent finished" and "the network died",
// and produce a plan for picking the work back up.
//
// The failure this exists to fix, observed 2026-09-30: Owen's network dropped mid-session,
// he reconnected, and the work did not resume. ZCode had no way to express this, because a
// call that dies on a transport error is shaped exactly like a call that finished normally.
// Both end with a tool call outstanding.
//
// The signal that separates them is finishReason. Measured across 173 calls on this machine:
// 166 ended `tool-calls` (mid-work), 6 ended `stop` (the model finished its turn), 1 `other`.
// A turn whose last call is `tool-calls` was interrupted, not completed.
//
// Rule this file enforces, and which the stop gate must also enforce:
//   A transport failure is never a reason to stop. It is a reason to retry.

import { readCalls, summarise, ROLLOUT_DIR } from "./trace.mjs";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Classify an error into something actionable. The distinction that matters is
 * retryable-transport vs deliberate — only the latter may ever influence a stop decision.
 */
export function classifyError(error) {
  if (!error) return { kind: "none", retryable: false, deliberate: false, message: "" };
  const name = String(error.name ?? "");
  const message = String(error.message ?? "").toLowerCase();

  if (
    name === "TerminalStreamChunkError" ||
    name === "AI_APICallError" ||
    // Observed live 2026-09-30: "Provider returned a server error ... Upstream error:
    // getaddrinfo ENOTFOUND opencode.ai", status 502, retryable=true. DNS and 5xx arrive
    // under several different error names depending on which layer fails first, so match the
    // message too — a transport failure misread as unknown is a dropped retry.
    /server error|network|econn|eaddrnotavail|enotfound|getaddrinfo|socket|timeout|dns|fetch failed|eai_again|upstream error|\b50[0234]\b/.test(message)
  ) {
    return { kind: "transport", retryable: true, deliberate: false, name, message: error.message };
  }
  if (name === "AiSdkModelAdapterError" || /cancelled|canceled|aborted/.test(message)) {
    return { kind: "cancel", retryable: true, deliberate: false, name, message: error.message };
  }
  if (/preempts active turn|sendqueuednow/.test(message)) {
    // A newer turn displaced this one. The work is not lost, it is queued — resume must
    // re-read state before acting, because the displacing turn may already have done it.
    return { kind: "preempt", retryable: true, deliberate: false, name, message: error.message };
  }
  if (/session stopped|stopped by user|aborted by user/.test(message)) {
    return { kind: "user-stop", retryable: false, deliberate: true, name, message: error.message };
  }
  return { kind: "unknown", retryable: true, deliberate: false, name, message: error.message };
}

/**
 * A session whose rollout file is still being appended to is ALIVE, not interrupted.
 *
 * Found by the watchdog tick itself on 2026-09-30: the session executing the tick — which was
 * demonstrably mid-work — was classified `interrupted` and offered for resume. Without this,
 * a session that is running right now is indistinguishable from one that died, and the
 * watchdog spends every tick trying to resume work that is already running.
 *
 * Liveness is measurable and cheap: the rollout file's mtime.
 */
export const ALIVE_WINDOW_MS = 5 * 60 * 1000;

/**
 * Decide whether a session actually finished its work.
 *
 * `completed` requires positive evidence: the final call reached `stop` and did not error.
 * Everything else is `interrupted`. This is deliberately asymmetric — proving completion is
 * easy, and assuming it is how work silently disappears.
 */
export function sessionOutcome(session, opts = {}) {
  const calls = [...(session.calls ?? [])].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  if (!calls.length) return { state: "empty", reason: "no calls recorded" };

  const last = calls[calls.length - 1];
  const lastFinish = last.finishReason ?? null;
  const err = classifyError(last.error);
  const allErrors = calls.map((c) => classifyError(c.error));
  const transport = allErrors.filter((e) => e.kind === "transport");
  const preempted = allErrors.filter((e) => e.kind === "preempt");

  // Liveness first: it overrides everything below. A file still being written means the
  // agent is in the middle of this very turn.
  const now = opts.now ?? Date.now();
  const mtime = opts.mtime ?? null;
  const ageMs = mtime ? now - mtime : null;
  const alive = ageMs !== null && ageMs < ALIVE_WINDOW_MS;

  // Nothing to resume if nothing was ever done. Observed 2026-09-30: a sub-agent was
  // dispatched and preempted on its very first call - 0 tool calls, 0 input tokens, 0 output.
  // That is not interrupted work, it is an empty shell, and offering it for resume is a
  // phantom for the watchdog to chase. This kind of noise erodes trust in the signal.
  // Guarded: a session that legitimately finished, or was deliberately stopped, is NOT an
  // empty shell even if it emitted nothing. Only sessions with no completion evidence qualify.
  const noCompletionEvidence = err.kind !== "user-stop" && lastFinish !== "stop";
  const producedNothing = noCompletionEvidence
    && calls.every((c) => (c.outputTokens ?? 0) === 0)
    && calls.every((c) => (c.toolCalls ?? []).length === 0);

  let state, reason;
  if (producedNothing && !alive) {
    state = "never-started";
    reason = `${calls.length} call(s), zero tool calls and zero output tokens - nothing to resume`;
  } else if (alive) {
    state = "active";
    reason = `rollout file written ${Math.round(ageMs / 1000)}s ago — this session is running right now`;
  } else if (err.kind === "user-stop") {
    state = "halted-by-user";
    reason = "the last call was stopped deliberately — do not resume without Owen";
  } else if (lastFinish === "stop" && !last.error) {
    state = "completed";
    reason = "final call reached a natural stop";
  } else if (err.kind === "transport") {
    state = "interrupted";
    reason = `final call died on a transport error (${err.name}) — network, not intent`;
  } else if (err.kind === "preempt" || preempted.length) {
    state = "interrupted";
    reason = "a newer turn preempted this one; re-read state before acting";
  } else if (err.kind === "cancel") {
    state = "interrupted";
    reason = "final call was cancelled — retryable";
  } else if (lastFinish === "tool-calls" || (lastFinish && lastFinish !== "stop")
             || (last.toolCalls ?? []).length > 0) {
    // An outstanding tool call with no natural stop is unfinished work, whether or not
    // the provider bothered to report a finishReason. Some records carry none.
    // Mid-work with no error: the turn ended with work outstanding and never came back.
    // Any finishReason other than a natural `stop` is treated as unfinished — completion
    // must be proven, never assumed.
    state = "interrupted";
    reason = `ended mid-work (finish=${lastFinish ?? "unreported"}) with no natural stop`;
  } else {
    state = "unknown";
    reason = `could not classify (finish=${lastFinish ?? "none"}, error=${err.kind})`;
  }

  return {
    state,
    reason,
    alive,
    ageMs,
    sessionId: session.sessionId,
    kind: session.kind,
    lastFinish,
    lastError: err.kind === "none" ? null : err,
    transportFailures: transport.length,
    retries: session.retries ?? 0,
    calls: session.callCount,
    // The tool call that was in flight when the turn died. Retry candidates start here.
    inFlight: last.toolCalls ?? [],
    lastActivityAt: last.startedAt ?? null,
  };
}

/** Everything the system must pick back up, worst first. */
/** mtime of each session's rollout file, used as the liveness signal. */
function rolloutMtimes(dir) {
  const out = {};
  try {
    for (const f of readdirSync(dir)) {
      if (!f.startsWith("model-io-") || !f.endsWith(".jsonl")) continue;
      const sid = f.slice("model-io-".length, -".jsonl".length);
      out[sid] = statSync(join(dir, f)).mtimeMs;
    }
  } catch {
    return {}; // an unreadable dir must not silently mark everything dead
  }
  return out;
}

export function resumePlan(calls = readCalls(), opts = {}) {
  const mtimes = rolloutMtimes(opts.rolloutDir ?? ROLLOUT_DIR);
  const sessions = summarise(calls);
  const outcomes = sessions.map((s) => sessionOutcome(s, { mtime: mtimes[s.sessionId] ?? null, now: opts.now }));
  const resume = outcomes.filter((o) => o.state === "interrupted" || o.state === "unknown");
  const done = outcomes.filter((o) => o.state === "completed");

  // Deduplicate: a parent that resumed after a preemption leaves a stale interrupted child.
  const bySession = new Map(resume.map((o) => [o.sessionId, o]));
  const actionable = [...bySession.values()].sort((a, b) => {
    const rank = (o) => (o.kind === "main" ? 0 : o.lastError?.kind === "transport" ? 1 : 2);
    return rank(a) - rank(b) || String(b.lastActivityAt).localeCompare(String(a.lastActivityAt));
  });

  return {
    summary: {
      sessions: sessions.length,
      active: outcomes.filter((o) => o.state === "active").length,
      completed: done.length,
      interrupted: outcomes.filter((o) => o.state === "interrupted").length,
      haltedByUser: outcomes.filter((o) => o.state === "halted-by-user").length,
      unknown: outcomes.filter((o) => o.state === "unknown").length,
      neverStarted: outcomes.filter((o) => o.state === "never-started").length,
      transportFailures: outcomes.reduce((a, o) => a + o.transportFailures, 0),
    },
    outcomes,
    resume: actionable,
    // A stop is warranted only by deliberate action. Transport trouble is never a stop.
    stopSignal: outcomes.some((o) => o.state === "halted-by-user"),
  };
}

export function render(plan) {
  const L = [];
  const s = plan.summary;
  L.push("ALPHA — INTERRUPTION / RESUME REPORT");
  L.push("=".repeat(72));
  L.push(`sessions ${s.sessions}  completed ${s.completed}  interrupted ${s.interrupted}  never-started ${s.neverStarted}  halted-by-user ${s.haltedByUser}  unknown ${s.unknown}`);
  L.push(`transport failures observed: ${s.transportFailures}`);
  L.push("");
  for (const o of plan.outcomes) {
    const tag = o.state === "active" ? "ALIVE   " : o.state === "completed" ? "DONE    " : o.state === "interrupted" ? "RESUME  " : o.state === "halted-by-user" ? "BY-YOU  " : o.state === "never-started" ? "EMPTY   " : "UNKNOWN ";
    L.push(`  [${tag}] ${o.kind.padEnd(9)} ${o.sessionId.slice(0, 34)}`);
    L.push(`            ${o.reason}`);
    if (o.inFlight.length) L.push(`            in flight: ${o.inFlight.join(", ")}`);
  }
  L.push("");
  if (plan.stopSignal) {
    L.push("STOP SIGNAL: a deliberate stop was recorded. Handoff and wait for Owen.");
  } else if (plan.resume.length) {
    L.push(`RESUME REQUIRED: ${plan.resume.length} session(s) ended mid-work. A transport failure is never a stop — it is a retry.`);
  } else {
    L.push("Nothing to resume: every session reached a natural stop.");
  }
  return L.join("\n");
}

if (process.argv[1]?.endsWith("resume.mjs")) {
  const plan = resumePlan();
  console.log(process.argv.includes("--json") ? JSON.stringify(plan, null, 2) : render(plan));
  // Exit 0 always: an interrupted session is work to do, not a reason to halt.
  process.exit(0);
}