// trace.mjs — reads ZCode's own execution record and turns it into facts.
//
// ZCode persists every model call to ~/.zcode/cli/rollout/model-io-<sessionId>.jsonl.
// One JSON object per model call. That file is the only objective record of what this
// agent actually did and what it actually cost. Everything in alpha is derived from it.
//
// No dependencies. Node >= 18.

import { readdirSync, readFileSync, existsSync, statSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

export const ROLLOUT_DIR =
  process.env.ALPHA_ROLLOUT_DIR ||
  join(process.env.USERPROFILE || process.env.HOME || "", ".zcode", "cli", "rollout");

/**
 * ZCode DELETES the rollout file when a sub-agent session ends. Anything cited as evidence
 * evaporates unless we keep our own copy. Measured 2026-09-30: a sub-agent file worth
 * 1,567,880 tokens was gone within two minutes of the session ending, taking two rule
 * citations with it. Snapshot it before that happens.
 */
export function archiveRollouts(archiveDir, liveDir = ROLLOUT_DIR) {
  if (!existsSync(liveDir)) return { archived: 0, kept: 0 };
  mkdirSync(archiveDir, { recursive: true });
  let archived = 0, kept = 0;
  for (const file of readdirSync(liveDir)) {
    if (!file.startsWith("model-io-") || !file.endsWith(".jsonl")) continue;
    const live = join(liveDir, file);
    const dest = join(archiveDir, file);
    let liveSize = 0, destSize = 0;
    try {
      liveSize = statSync(live).size;
      destSize = existsSync(dest) ? statSync(dest).size : 0;
    } catch {
      continue;
    }
    if (destSize >= liveSize && destSize > 0) { kept++; continue; } // already have it, or it shrank
    try {
      copyFileSync(live, dest);
      archived++;
    } catch {
      /* a file being written right now will be picked up next run */
    }
  }
  return { archived, kept };
}

/** Rough but stable char->token estimate. Used only where the provider reports no usage. */
export const approxTokens = (s) => Math.ceil((s || "").length / 4);

/** Read every rollout file on the machine into one flat list of model-call records. */
export function readCalls(rolloutDir = ROLLOUT_DIR) {
  if (!existsSync(rolloutDir)) return [];
  const files = readdirSync(rolloutDir).filter((f) => f.startsWith("model-io-") && f.endsWith(".jsonl"));
  const calls = [];
  for (const file of files) {
    const path = join(rolloutDir, file);
    let raw;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue; // a session still being written can vanish mid-read; not an error worth stopping for
    }
    const sid = file.slice("model-io-".length, -".jsonl".length);
    let startLine = 0;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        startLine++; // truncated tail from a live session; skip it
        continue;
      }
      if (d.type !== "model_io") continue;
      const body = d.request?.body ?? {};
      const usage = d.response?.usage ?? {};
      const inputTokens = usage.inputTokens ?? usage.promptTokens ?? null;
      const outputTokens = usage.outputTokens ?? usage.completionTokens ?? null;
      // Measured 2026-09-30: 97.1% of input tokens are cache re-reads. Reporting raw input
      // as if it were billed work produces a ~70:1 panic number for what is really ~2:1 of
      // fresh computation. Both numbers are kept; only the uncached one is real work.
      const cacheReadTokens = usage.cacheReadTokens ?? null;
      const cacheCreationTokens = usage.cacheCreationInputTokens ?? usage.cacheCreationTokens ?? null;
      const reasoningTokens = usage.reasoningTokens ?? null;
      calls.push({
        file,
        line: startLine++,
        sessionId: d.sessionId ?? sid,
        source: d.querySource ?? "unknown",
        startedAt: d.startedAt ?? null,
        durationMs: d.durationMs ?? 0,
        attempt: d.attempt ?? 1,
        model: d.model ? `${d.model.providerId}/${d.model.modelId}` : "unknown",
        turnId: d.turnId ?? null,
        error: d.error ? { name: d.error.name, message: d.error.message } : null,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        reasoningTokens,
        billedInput: inputTokens != null ? Math.max(0, inputTokens - (cacheReadTokens ?? 0)) : null,
        toolCalls: (d.response?.toolCalls ?? []).map((t) => t.toolName ?? t.name ?? "?"),
        toolsDeclared: Array.isArray(body.tools) ? body.tools.length : 0,
        toolsBytes: Array.isArray(body.tools) ? JSON.stringify(body.tools).length : 0,
        messages: Array.isArray(body.messages) ? body.messages.length : 0,
      });
    }
  }
  calls.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  return calls;
}

/** Fold calls into per-session summaries. */
export function summarise(calls) {
  const bySession = new Map();
  for (const c of calls) {
    if (!bySession.has(c.sessionId)) {
      bySession.set(c.sessionId, {
        sessionId: c.sessionId,
        sources: new Set(),
        models: new Set(),
        calls: [],
        toolsUsed: new Map(),
        errors: [],
        retries: 0,
        durationMs: 0,
        toolsDeclared: c.toolsDeclared,
        toolsBytes: c.toolsBytes,
      });
    }
    const s = bySession.get(c.sessionId);
    s.sources.add(c.source);
    s.models.add(c.model);
    s.calls.push(c);
    s.durationMs += c.durationMs;
    if (c.toolsDeclared) s.toolsDeclared = c.toolsDeclared;
    if (c.toolsBytes) s.toolsBytes = c.toolsBytes;
    if (c.attempt > 1) s.retries += c.attempt - 1;
    if (c.error) s.errors.push(c);
    for (const t of c.toolCalls) s.toolsUsed.set(t, (s.toolsUsed.get(t) ?? 0) + 1);
  }

  return [...bySession.values()].map((s) => {
    const scored = s.calls.filter((c) => c.inputTokens != null);
    const first = scored[0] ?? null;
    const last = scored[scored.length - 1] ?? null;
    const totalIn = scored.reduce((a, c) => a + c.inputTokens, 0);
    const totalOut = s.calls.reduce((a, c) => a + (c.outputTokens ?? 0), 0);
    const totalCacheRead = scored.reduce((a, c) => a + (c.cacheReadTokens ?? 0), 0);
    const totalBilledIn = scored.reduce((a, c) => a + (c.billedInput ?? 0), 0);
    const totalReasoning = s.calls.reduce((a, c) => a + (c.reasoningTokens ?? 0), 0);
    const kind = [...s.sources].includes("subagent") ? "subagent" : "main";
    const lastStartedAt = s.calls.reduce((m, c) => (c.startedAt && c.startedAt > m ? c.startedAt : m), "");
    return {
      sessionId: s.sessionId,
      kind,
      sources: [...s.sources],
      models: [...s.models],
      callCount: s.calls.length,
      scoredCount: scored.length,
      firstInput: first?.inputTokens ?? null,
      lastInput: last?.inputTokens ?? null,
      peakInput: scored.length ? Math.max(...scored.map((c) => c.inputTokens)) : null,
      lastStartedAt,
      totalIn,
      totalOut,
      totalCacheRead,
      totalBilledIn,
      totalReasoning,
      cacheHitShare: totalIn ? Math.round((totalCacheRead / totalIn) * 100) : null,
      billedRatio: totalOut ? Math.round(totalBilledIn / totalOut) : null,
      rawRatio: totalOut ? Math.round(totalIn / totalOut) : null,
      ratio: totalOut ? Math.round(totalIn / totalOut) : null, // kept for back-compat, prefer billedRatio
      durationMs: s.durationMs,
      errors: s.errors.length,
      errorNames: s.errors.map((e) => e.error.name),
      retries: s.retries,
      toolsDeclared: s.toolsDeclared,
      toolsBytes: s.toolsBytes,
      toolsUsed: [...s.toolsUsed.entries()].sort((a, b) => b[1] - a[1]),
      calls: s.calls,
    };
  }).sort((a, b) => b.totalIn - a.totalIn);
}

/** Per-tool schema weight, to see what the fixed overhead is actually made of. */
export function toolWeight(rolloutDir = ROLLOUT_DIR) {
  const calls = readCalls(rolloutDir).filter((c) => c.toolsDeclared > 0);
  if (!calls.length) return { count: 0, rows: [], totalBytes: 0 };
  const path = join(rolloutDir, calls[0].file);
  let tools = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type === "model_io" && Array.isArray(d.request?.body?.tools)) {
      tools = d.request.body.tools;
      break;
    }
  }
  const rows = tools.map((t) => {
    const fn = t.function ?? t;
    return {
      name: fn.name ?? "?",
      bytes: JSON.stringify(fn).length,
      tokens: approxTokens(JSON.stringify(fn)),
    };
  }).sort((a, b) => b.bytes - a.bytes);
  return { count: rows.length, rows, totalBytes: rows.reduce((a, r) => a + r.bytes, 0) };
}

/** Whole-machine view: one call to get everything the analysers need. */
export function observe(rolloutDir = ROLLOUT_DIR) {
  const calls = readCalls(rolloutDir);
  const scored = calls.filter((c) => c.inputTokens != null);
  const totalIn = scored.reduce((a, c) => a + c.inputTokens, 0);
  const totalCacheRead = scored.reduce((a, c) => a + (c.cacheReadTokens ?? 0), 0);
  const totalBilledIn = scored.reduce((a, c) => a + (c.billedInput ?? 0), 0);
  const totalOut = calls.reduce((a, c) => a + (c.outputTokens ?? 0), 0);
  return {
    dir: rolloutDir,
    sessions: summarise(calls),
    tools: toolWeight(rolloutDir),
    totals: {
      calls: calls.length,
      scored: scored.length,
      errors: calls.filter((c) => c.error).length,
      retries: calls.reduce((a, c) => a + Math.max(0, c.attempt - 1), 0),
      input: totalIn,
      cacheRead: totalCacheRead,
      billedInput: totalBilledIn,
      output: totalOut,
      reasoning: calls.reduce((a, c) => a + (c.reasoningTokens ?? 0), 0),
      cacheHitShare: totalIn ? Math.round((totalCacheRead / totalIn) * 100) : 0,
      ratio: totalOut ? Math.round(totalIn / totalOut) : null,
      billedRatio: totalOut ? Math.round(totalBilledIn / totalOut) : null,
      avgInputPerCall: scored.length ? Math.round(totalIn / scored.length) : 0,
      avgBilledPerCall: scored.length ? Math.round(totalBilledIn / scored.length) : 0,
      avgOutputPerCall: calls.length ? Math.round(totalOut / calls.length) : 0,
      models: [...new Set(calls.map((c) => c.model))],
    },
  };
}

if (isMain) {
  const o = observe();
  const t = o.totals;
  console.log(`rollout dir : ${o.dir}`);
  console.log(`model calls : ${t.calls}  (${t.scored} with usage)  errors ${t.errors}  retries ${t.retries}`);
  console.log(`models      : ${t.models.join(", ")}`);
  console.log(`input       : ${t.input.toLocaleString()} raw, of which ${t.cacheRead.toLocaleString()} cache re-read (${t.cacheHitShare}%)`);
  console.log(`             -> ${t.billedInput.toLocaleString()} genuinely new input tokens`);
  console.log(`output      : ${t.output.toLocaleString()} (${t.reasoning.toLocaleString()} reasoning)`);
  console.log(`ratio       : ${t.ratio}:1 raw  BUT  ${t.billedRatio}:1 on uncached input`);
  console.log(`tool schemas: ${o.tools.count} tools = ${o.tools.totalBytes.toLocaleString()} chars (~${Math.round(o.tools.totalBytes / 4).toLocaleString()} tokens per call)\n`);
  for (const s of o.sessions) {
    console.log(
      `${s.kind.padEnd(9)} ${s.sessionId.slice(0, 28).padEnd(29)} calls ${String(s.callCount).padStart(3)}  ` +
      `in ${String(s.firstInput).padStart(7)}->${String(s.peakInput).padStart(7)}  billed ${String(s.totalBilledIn).padStart(7)}  ` +
      `out ${String(s.totalOut).padStart(7)}  raw ${String(s.rawRatio).padStart(4)}:1 billed ${String(s.billedRatio).padStart(3)}:1  cache ${s.cacheHitShare}%`,
    );
  }
}