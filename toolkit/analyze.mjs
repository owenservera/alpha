// analyze.mjs — turns raw trace facts into findings that can become rules.
//
// Every finding carries the measurement that produced it. A finding without evidence
// is not allowed to become a rule. That constraint is the whole point of this file.
//
// Run:  node toolkit/analyze.mjs            human-readable report
//       node toolkit/analyze.mjs --json     machine-readable, for learn.mjs

import { observe, approxTokens } from "./trace.mjs";

const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

/**
 * Analyse one session. Returns findings with evidence attached.
 */
export function analyseSession(s) {
  const F = s.toolsDeclared ? Math.round(s.toolsBytes / 4) : 0; // tool schema floor, re-sent every call
  const floorShare = s.firstInput ? pct(F, s.firstInput) : 0;

  // NOTE: an earlier version computed redundantContext = totalIn - peakInput and reported it
  // as a headline. That number is ~ (N-1)/N for ANY non-decreasing sequence, so it approaches
  // 100% in any session and carries no information. It was removed as a tautology. The real
  // redundancy signal is cacheReadTokens: how much of the input was re-read rather than fresh.
  const cacheShare = s.cacheHitShare ?? null;
  const growth = s.firstInput && s.peakInput ? s.peakInput / s.firstInput : null;

  const findings = [];

  if (F > 0 && s.callCount > 1) {
    findings.push({
      id: "tool-schema-overhead",
      severity: "info",
      session: s.sessionId,
      claim: `${s.toolsDeclared} tool schemas cost ~${F.toLocaleString()} tokens and are re-sent on all ${s.callCount} calls (~${(F * s.callCount).toLocaleString()} tokens of context, most of it cache-served).`,
      evidence: { toolsDeclared: s.toolsDeclared, toolSchemaTokens: F, calls: s.callCount, cacheHitShare: cacheShare },
      actionable: "This is context, not billable work, when the cache is hitting. Weight it as latency and attention cost, not as money.",
    });
  }

  if (growth && growth > 1.5) {
    findings.push({
      id: "context-compounding",
      severity: growth > 3 ? "warn" : "info",
      session: s.sessionId,
      claim: `Context grew ${growth.toFixed(1)}x within one session (${s.firstInput.toLocaleString()} -> ${(s.peakInput ?? 0).toLocaleString()} tokens).`,
      evidence: { firstInput: s.firstInput, peakInput: s.peakInput, growthFactor: Number(growth.toFixed(2)), billedInput: s.totalBilledIn, cacheHitShare: cacheShare },
      actionable: "Long sessions get more expensive in context and attention. On a cached model this is cheap; on an uncached one it is not.",
    });
  }

  // A session that emitted no output at all is the worst outcome. Guard totalOut === 0,
  // which previously produced ratio: null and made such a session invisible to this check.
  if (s.totalOut === 0 && s.callCount > 0) {
    findings.push({
      id: "no-output-session",
      severity: "high",
      session: s.sessionId,
      claim: `${s.kind} session made ${s.callCount} calls and emitted ZERO output tokens.`,
      evidence: { totalOut: 0, totalIn: s.totalIn, billedInput: s.totalBilledIn, calls: s.callCount },
      actionable: "Work was paid for and nothing was delivered. Establish what the smallest useful output is before starting.",
    });
  }

  if ((s.totalBilledIn ?? 0) > 0 && s.totalOut > 0 && s.totalBilledIn / s.totalOut > 12) {
    findings.push({
      id: "low-yield-session",
      severity: "warn",
      session: s.sessionId,
      claim: `${s.kind} session spent ${s.totalBilledIn.toLocaleString()} fresh input tokens to emit ${s.totalOut.toLocaleString()} output tokens (${Math.round(s.totalBilledIn / s.totalOut)}:1 on uncached input; ${s.rawRatio}:1 raw).`,
      evidence: { billedInput: s.totalBilledIn, totalOut: s.totalOut, billedRatio: s.billedRatio, rawRatio: s.rawRatio, cacheHitShare: cacheShare, calls: s.callCount },
      actionable: "Measured on uncached input, this is real work per unit of output. Scope smaller.",
    });
  }

  if (s.retries > 0) {
    findings.push({
      id: "retry-storm",
      severity: "info",
      session: s.sessionId,
      claim: `${s.retries} retried model calls. Errors: ${[...new Set(s.errorNames)].join(", ") || "n/a"}.`,
      evidence: { retries: s.retries, errors: s.errors, names: [...new Set(s.errorNames)] },
      actionable: "Retries re-send context. Cheap when cached, expensive when not.",
    });
  }

  return {
    sessionId: s.sessionId,
    kind: s.kind,
    lastStartedAt: s.lastStartedAt,
    cost: {
      totalIn: s.totalIn,
      billedInput: s.totalBilledIn,
      cacheRead: s.totalCacheRead,
      cacheHitShare: cacheShare,
      totalOut: s.totalOut,
      reasoning: s.totalReasoning,
      billedRatio: s.billedRatio,
      rawRatio: s.rawRatio,
      // ratio kept as an alias so older consumers do not silently read the raw number as billed
      ratio: s.billedRatio,
      toolSchemaFloor: F,
      floorShareOfFirstCall: floorShare,
      firstInput: s.firstInput,
      peakInput: s.peakInput,
      growth: growth ? Number(growth.toFixed(2)) : null,
      retries: s.retries,
      callCount: s.callCount,
    },
    findings,
  };
}

/** Machine-level findings: dead schema weight, fleet totals, and what this predicts for the next session. */
export function analyse(machine = observe()) {
  const perSession = machine.sessions.map((s) => analyseSession(s));

  // Tools that are declared (and carried in context on every call) but never once invoked.
  const used = new Set(machine.sessions.flatMap((s) => s.toolsUsed.map(([n]) => n)));
  const declared = machine.tools.rows;
  const neverUsed = declared.filter((r) => !used.has(r.name));
  const deadWeight = neverUsed.reduce((a, r) => a + r.tokens, 0);
  const floorTokens = Math.round(machine.tools.totalBytes / 4);
  const deadShare = pct(deadWeight, floorTokens);

  const t = machine.totals;
  const heaviest = [...machine.sessions].sort((a, b) => (b.peakInput ?? 0) - (a.peakInput ?? 0))[0];

  const machine_ = {
    totals: t,
    schema: {
      heaviest: declared.slice(0, 10),
      neverUsed: neverUsed.map((r) => ({ name: r.name, tokens: r.tokens })),
      neverUsedTokens: deadWeight,
      neverUsedShare: deadShare,
      floorTokens,
    },
    projection: heaviest
      ? {
          basis: heaviest.sessionId,
          note: `Peak context reached ${(heaviest.peakInput ?? 0).toLocaleString()} tokens. Because the cache absorbs re-reads, ${t.cacheHitShare}% of input tokens are served from cache; only ${t.billedInput.toLocaleString()} tokens of fresh input were actually computed across ${t.calls} calls.`,
        }
      : null,
    sessions: perSession,
  };

  const allFindings = perSession.flatMap((p) => p.findings);
  if (deadWeight > 0) {
    allFindings.push({
      id: "dead-schema-weight",
      severity: "info",
      session: "machine",
      claim: `${neverUsed.length} of ${declared.length} declared tools were never invoked, yet cost ~${deadWeight.toLocaleString()} tokens on every call (${deadShare}% of the schema floor).`,
      evidence: { neverUsed: neverUsed.map((r) => r.name), tokens: deadWeight, share: deadShare },
      actionable: "The fixed price of the session is set by tools you may never touch. Do not read tool count as a measure of capability.",
    });
  }

  return { ...machine_, findings: allFindings };
}

// ---------------------------------------------------------------- report ----

export function render(a) {
  const L = [];
  const t = a.totals;
  L.push("ALPHA — MEASURED STATE OF THIS AGENT RUNTIME");
  L.push("=".repeat(72));
  L.push(`models        ${t.models.join(", ")}`);
  L.push(`model calls   ${t.calls}  (${t.scored} with usage)   errors ${t.errors}   retries ${t.retries}`);
  L.push(`input raw     ${t.input.toLocaleString()}`);
  L.push(`  cache read  ${t.cacheRead.toLocaleString()}  = ${t.cacheHitShare}% of input`);
  L.push(`  FRESH       ${t.billedInput.toLocaleString()}  <- the only input actually computed`);
  L.push(`output        ${t.output.toLocaleString()}  (${t.reasoning.toLocaleString()} reasoning)`);
  L.push(`ratio         ${t.ratio}:1 raw     ${t.billedRatio}:1 on fresh input`);
  L.push(`fixed floor   ${a.schema.floorTokens.toLocaleString()} tokens of tool schema carried on every call`);
  L.push("");
  L.push(`dead schema   ${a.schema.neverUsed.length} tools never invoked = ${a.schema.neverUsedTokens.toLocaleString()} tokens/call (${a.schema.neverUsedShare}% of floor)`);
  L.push(`               ${a.schema.neverUsed.slice(0, 10).map((r) => r.name).join(", ")}`);
  L.push("");
  L.push("SESSIONS");
  for (const s of a.sessions) {
    L.push(
      `  ${s.kind.padEnd(9)} fresh ${String(s.cost.billedInput).padStart(8)}  out ${String(s.cost.totalOut).padStart(7)}  ` +
      `${String(s.cost.billedRatio).padStart(3)}:1 fresh  (raw ${String(s.cost.rawRatio).padStart(4)}:1, cache ${s.cost.cacheHitShare}%)  calls ${s.cost.callCount}`,
    );
  }
  L.push("");
  L.push("HEAVIEST TOOLS (context carried on every call)");
  for (const r of a.schema.heaviest.slice(0, 8)) L.push(`  ${String(r.tokens).padStart(6)} tok  ${r.name}`);
  L.push("");
  L.push("FINDINGS");
  for (const f of a.findings) {
    L.push(`  [${f.severity.toUpperCase()}] ${f.id}`);
    L.push(`      ${f.claim}`);
    L.push(`      -> ${f.actionable}`);
  }
  if (a.projection) {
    L.push("");
    L.push("NOTE");
    L.push(`  ${a.projection.note}`);
  }
  return L.join("\n");
}

if (process.argv[1]?.endsWith("analyze.mjs")) {
  const a = analyse();
  console.log(process.argv.includes("--json") ? JSON.stringify(a, null, 2) : render(a));
}