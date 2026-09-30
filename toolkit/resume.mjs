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

import { readCalls, summarise } from "./trace.mjs";

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
 * Decide whether a session actually finished its work.
 *
 * `completed` requires positive evidence: the final call reached `stop` and did not error.
 * Everything else is `interrupted`. This is deliberately asymmetric — proving completion is
 * easy, and assuming it is how work silently disappears.
 */
export function sessionOutcome(session) {
  const calls = [...(session.calls ?? [])].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  if (!calls.length) return { state: "empty", reason: "no calls recorded" };

  const last = calls[calls.length - 1];
  const lastFinish = last.finishReason ?? null;
  const err = classifyError(last.error);
  const allErrors = calls.map((c) => classifyError(c.error));
  const transport = allErrors.filter((e) => e.kind === "transport");
  const preempted = allErrors.filter((e) => e.kind === "preempt");

  let state, reason;
  if (err.kind === "user-stop") {
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
  } else if (lastFinish === "tool-calls" || (lastFinish && lastFinish !== "stop")) {
    // Mid-work with no error: the turn ended with work outstanding and never came back.
    // Any finishReason other than a natural `stop` is treated as unfinished — completion
    // must be proven, never assumed.
    state = "interrupted";
    reason = `ended mid-work (finish=${lastFinish}) with no natural stop`;
  } else {
    state = "unknown";
    reason = `could not classify (finish=${lastFinish ?? "none"}, error=${err.kind})`;
  }

  return {
    state,
    reason,
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
export function resumePlan(calls = readCalls()) {
  const sessions = summarise(calls);
  const outcomes = sessions.map(sessionOutcome);
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
      completed: done.length,
      interrupted: outcomes.filter((o) => o.state === "interrupted").length,
      haltedByUser: outcomes.filter((o) => o.state === "halted-by-user").length,
      unknown: outcomes.filter((o) => o.state === "unknown").length,
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
  L.push(`sessions ${s.sessions}  completed ${s.completed}  interrupted ${s.interrupted}  halted-by-user ${s.haltedByUser}  unknown ${s.unknown}`);
  L.push(`transport failures observed: ${s.transportFailures}`);
  L.push("");
  for (const o of plan.outcomes) {
    const tag = o.state === "completed" ? "DONE    " : o.state === "interrupted" ? "RESUME  " : o.state === "halted-by-user" ? "BY-YOU  " : "UNKNOWN ";
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