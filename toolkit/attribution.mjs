// attribution.mjs — per-turn cost and yield.
//
// Closes R-008. Session-level ratios are true and useless: "this session cost 207,609 fresh
// input tokens" tells you nothing you can act on. Per-turn attribution says which decision
// cost what.
//
// A correction worth recording. The first draft of this used marginal cost as
// `input[i] - input[i-1]`. Measured against the live trace, that formula is wrong: it yields
// NEGATIVE deltas (observed: -35,555) whenever the cache absorbs more of one call than the
// last, which is the common case on a 98%-hit workload. Cache eviction makes input lumpy and
// the delta meaningless.
//
// The honest measure is per-turn SUMMED fresh input — every call's own (input - cacheRead) —
// which is monotonic, non-negative, and is exactly the work the machine actually did.
//
// Run: node toolkit/attribution.mjs

import { readCalls, summarise } from "./trace.mjs";

/** Pseudo-turns the harness runs for titles; they carry no usage and are not agent work. */
const isAgentTurn = (c) => c.source === "main_turn" || c.source === "subagent";

/**
 * Harness-internal calls are real model calls that belong to no agent conversation.
 * Observed on this machine: `web_fetch_processing` and `web_search_tool` sources, plus a
 * `model-io-no-session.jsonl` file whose records carry `sessionId: null` and which ZCode
 * deletes within minutes. They are billed work and they fail like any other provider call.
 *
 * Defined as the INVERSE of agent work rather than by a list of names: ZCode adds new
 * internal sources over time, and hardcoding one meant this bucket silently read 0 and the
 * totals stopped reconciling.
 */
const isHarnessInternal = (c) => !isAgentTurn(c);

/** Group calls into turns and price each one. */
export function attributeTurns(calls = readCalls(), sessionId = null) {
  const relevant = calls.filter((c) => isAgentTurn(c) && (!sessionId || c.sessionId === sessionId));
  if (!relevant.length) return { sessionId, turns: [], totals: null };

  const byTurn = new Map();
  for (const c of relevant) {
    const key = c.turnId ?? `call:${c.startedAt}`;
    if (!byTurn.has(key)) byTurn.set(key, []);
    byTurn.get(key).push(c);
  }

  const turns = [];
  let prevTurnOutput = 0;

  for (const [turnId, group] of byTurn) {
    const ordered = group.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    // Summed fresh input: what this turn actually cost to compute. Never negative, never a delta.
    const freshInput = ordered.reduce((a, c) => a + (c.billedInput ?? 0), 0);
    const rawInput = ordered.reduce((a, c) => a + (c.inputTokens ?? 0), 0);
    const cacheRead = ordered.reduce((a, c) => a + (c.cacheReadTokens ?? 0), 0);
    const output = ordered.reduce((a, c) => a + (c.outputTokens ?? 0), 0);
    const reasoning = ordered.reduce((a, c) => a + (c.reasoningTokens ?? 0), 0);
    const tools = ordered.flatMap((c) => c.toolCalls);
    const errors = ordered.filter((c) => c.error);
    const durationMs = ordered.reduce((a, c) => a + (c.durationMs ?? 0), 0);

    turns.push({
      turnId,
      sessionId: ordered[0].sessionId,
      source: ordered[0].source,
      calls: ordered.length,
      freshInput,
      rawInput,
      cacheRead,
      cacheShare: rawInput ? Math.round((cacheRead / rawInput) * 100) : 0,
      output,
      reasoning,
      tools,
      distinctTools: [...new Set(tools)],
      errors: errors.length,
      errorKinds: [...new Set(errors.map((e) => e.name))],
      durationMs,
      startedAt: ordered[0].startedAt,
      endedAt: ordered[ordered.length - 1].startedAt,
    });
  }

  turns.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));

  // Cold start: the first turn of a session pays for the system prompt and tool schemas in
  // full, with nothing cached. Flagged so it is not mistaken for a wasteful decision.
  const first = turns[0];
  if (first) first.coldStart = true;
  for (const t of turns) {
    if (t === first) continue;
    t.freshPerOutput = t.output ? Number((t.freshInput / t.output).toFixed(1)) : null;
    // A turn that spent fresh tokens and emitted nothing is the cheapest possible waste signal.
    t.silent = t.freshInput > 0 && t.output === 0;
  }

  return {
    sessionId: relevant[0].sessionId,
    turns,
    totals: {
      turns: turns.length,
      freshInput: turns.reduce((a, t) => a + t.freshInput, 0),
      output: turns.reduce((a, t) => a + t.output, 0),
      silentTurns: turns.filter((t) => t.silent).length,
      silentFreshInput: turns.filter((t) => t.silent).reduce((a, t) => a + t.freshInput, 0),
    },
  };
}

/** Every session, attributed, plus the cross-session view that session totals hide. */
export function attributeAll(calls = readCalls()) {
  const sessions = summarise(calls);
  const harnessInternal = calls.filter(isHarnessInternal);
  const perSession = sessions.map((s) => attributeTurns(calls, s.sessionId)).filter((r) => r.turns.length);
  const allTurns = perSession.flatMap((r) => r.turns);
  return {
    sessions: perSession,
    hottest: [...allTurns].sort((a, b) => b.freshInput - a.freshInput).slice(0, 12),
    silent: allTurns.filter((t) => t.silent).sort((a, b) => b.freshInput - a.freshInput),
    harnessInternal: {
      calls: harnessInternal.length,
      freshInput: harnessInternal.reduce((a, c) => a + (c.billedInput ?? 0), 0),
      output: harnessInternal.reduce((a, c) => a + (c.outputTokens ?? 0), 0),
      sources: [...new Set(harnessInternal.map((c) => c.source))],
    },
    totals: {
      turns: allTurns.length,
      freshInput: allTurns.reduce((a, t) => a + t.freshInput, 0),
      output: allTurns.reduce((a, t) => a + t.output, 0),
      silentTurns: allTurns.filter((t) => t.silent).length,
      silentFreshInput: allTurns.filter((t) => t.silent).reduce((a, t) => a + t.freshInput, 0),
    },
  };
}

/**
 * Cache collapse. Measured 2026-09-30 across 197 calls:
 *   183 calls (93%) hit 95-100% cache, averaging 803 fresh tokens each
 *     5 calls ( 2.5%) hit  0-25% cache, averaging 58,420 fresh tokens each
 * Those 5 calls are 61% of every fresh token computed on this machine.
 *
 * The distribution is violently lumpy, which is precisely why session-level ratios hide it:
 * a session averaging 2:1 can contain a single turn at 180:1. This is the finding
 * per-turn attribution was built to surface.
 */
export function cacheCollapses(calls = readCalls()) {
  const scored = calls.filter((c) => c.inputTokens > 0);
  const collapses = scored
    .filter((c) => (c.cacheReadTokens ?? 0) / c.inputTokens < 0.25)
    .map((c) => ({
      sessionId: c.sessionId,
      turnId: c.turnId,
      at: c.startedAt,
      inputTokens: c.inputTokens,
      cacheReadTokens: c.cacheReadTokens ?? 0,
      fresh: c.billedInput ?? 0,
      hitShare: Number((((c.cacheReadTokens ?? 0) / c.inputTokens) * 100).toFixed(1)),
      tools: c.toolCalls,
      // A collapse is usually a cache expiry or eviction, not a bad decision. Say so, or the
      // agent will learn to avoid work that was never the cause.
      cause: c.inputTokens > 100000 ? "cache eviction on a large context" : "cache expiry or eviction",
    }))
    .sort((a, b) => b.fresh - a.fresh);

  const totalFresh = scored.reduce((a, c) => a + (c.billedInput ?? 0), 0);
  const collapseFresh = collapses.reduce((a, c) => a + c.fresh, 0);

  return {
    calls: scored.length,
    collapses,
    totalFresh,
    collapseFresh,
    // The share of all compute attributable to a small tail of calls.
    collapseShare: totalFresh ? Math.round((collapseFresh / totalFresh) * 100) : 0,
    collapseRate: scored.length ? Math.round((collapses.length / scored.length) * 100) : 0,
  };
}

export function render(a) {
  const L = [];
  const t = a.totals;
  const cc = a.cache;
  L.push("ALPHA — PER-TURN ATTRIBUTION");
  L.push("=".repeat(72));
  L.push(`${t.turns} turns | ${t.freshInput.toLocaleString()} fresh input | ${t.output.toLocaleString()} output`);
  L.push(`silent turns (spent fresh tokens, emitted nothing): ${t.silentTurns} costing ${t.silentFreshInput.toLocaleString()}`);
  L.push(`harness-internal (no agent session): ${a.harnessInternal.calls} calls, ${a.harnessInternal.freshInput.toLocaleString()} fresh [${a.harnessInternal.sources.join(",")}]`);
  L.push("");
  L.push("CACHE COLLAPSE — the distribution is violently lumpy");
  L.push(`  ${cc.collapseRate}% of calls (${cc.collapses.length}/${cc.calls}) hold ${cc.collapseShare}% of all fresh compute`);
  for (const c of cc.collapses.slice(0, 5)) {
    L.push(`  ${String(c.fresh).padStart(8)} fresh  hit ${String(c.hitShare).padStart(5)}%  ${String(c.at).slice(11, 19)}  ${c.tools.join(",") || "no tools"}`);
    L.push(`            ${c.cause}`);
  }
  L.push("");
  L.push("HOTTEST TURNS BY FRESH INPUT");
  L.push(`  ${"fresh".padStart(8)} ${"out".padStart(7)} ${"calls".padStart(6)} ${"cache".padStart(6)}  ${"turn".padEnd(10)} tools`);
  for (const r of a.hottest) {
    const mark = r.coldStart ? " (cold start)" : r.silent ? " SILENT" : "";
    L.push(`  ${String(r.freshInput).padStart(8)} ${String(r.output).padStart(7)} ${String(r.calls).padStart(6)} ${(r.cacheShare + "%").padStart(6)}  ${r.turnId.slice(0, 9).padEnd(10)} ${r.distinctTools.slice(0, 3).join(",")}${mark}`);
  }
  if (a.silent.length) {
    L.push("");
    L.push("SILENT TURNS — paid for, delivered nothing");
    for (const r of a.silent.slice(0, 8)) {
      L.push(`  ${String(r.freshInput).padStart(8)} fresh, ${r.calls} calls, tools: ${r.distinctTools.join(",") || "none"}`);
    }
  }
  return L.join("\n");
}

if (process.argv[1]?.endsWith("attribution.mjs")) {
  const a = { ...attributeAll(), cache: cacheCollapses() };
  console.log(process.argv.includes("--json") ? JSON.stringify(a, null, 2) : render(a));
}