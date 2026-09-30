// learn.mjs — the self-learning loop.
//
// Reads the live execution trace, evaluates every rule in rules.md against it, reports which
// rules the agent is currently breaking, flags rules that have stopped firing, and proposes
// new rules for findings that no existing rule covers. Every cycle is appended to
// memory/learnings.jsonl.
//
// This is the part that makes alpha self-learning rather than self-describing: the rules are
// thresholds, the evidence is measured, and the output is a verdict the agent has to live with.
//
// Run:  node toolkit/learn.mjs            the verdict
//       node toolkit/learn.mjs --json     machine-readable
//       node toolkit/learn.mjs --quiet    append the cycle, print nothing

import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyse } from "./analyze.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RULES = join(ROOT, "rules.md");
const LEDGER = join(ROOT, "memory", "learnings.jsonl");

// ---------------------------------------------------------------- rules ----

/** Parse rules.md into structured rules. Format is deliberately boring so it survives editing. */
export function loadRules(path = RULES) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const rules = [];
  const blocks = text.split(/^### /m).slice(1);
  for (const b of blocks) {
    const id = (b.match(/^(R-\d+)/) || [])[1];
    if (!id) continue;
    const title = (b.match(/^(R-\d+)\s*·\s*(.+)$/m) || [])[2]?.trim() ?? "";
    const check = (b.match(/\*\*check:\*\*\s*`?([^`\n]+)`?/) || [])[1]?.trim() ?? "none";
    const learned = (b.match(/\*\*learned:\*\*\s*([\d-]+)/) || [])[1] ?? null;
    // A retired rule is kept in the file as a record of why it was removed. It must never
    // contribute to the verdict, or the verdict stays pinned red and means nothing.
    const retired = (b.match(/\*\*retired:\*\*\s*([\d-]+)/) || [])[1] ?? null;
    // A caveat is a measured fact the agent CANNOT act on. Distinct from a rule (which must
    // change behaviour) and from a retired rule (which was once one). Filed so the number is
    // not rediscovered and misattributed; deliberately carries no `means`.
    const caveat = (b.match(/\*\*caveat|\*\*why this is not a rule/m) || [])[0] ?? null;
    const evidence = (b.match(/\*\*evidence:\*\*\s*([\s\S]*?)\n-/) || [])[1]?.trim() ?? "";
    const means = (b.match(/\*\*means:\*\*\s*([\s\S]*?)(?:\n\n|$)/) || [])[1]?.trim() ?? "";
    rules.push({ id, title, check, learned, retired, caveat, evidence, means });
  }
  return rules;
}

// --------------------------------------------------------------- checks ----

/**
 * Each check inspects the measured machine state and returns
 * { fired, severity, detail } — fired means the rule is being violated right now.
 */
export const CHECKS = {
  /**
   * FALSIFIABLE: fires when fresh (uncached) input per output token is genuinely poor.
   * An earlier version compared raw input:output, which is dominated by cache re-reads and
   * fired on healthy sessions. Measuring fresh input is the difference between a signal and noise.
   */
  lowYield(a) {
    const bad = a.sessions.filter((s) => (s.cost?.billedRatio ?? 0) > 12 && (s.cost?.totalOut ?? 0) > 0);
    return {
      fired: bad.length > 0,
      severity: bad.some((s) => s.cost.billedRatio > 25) ? "high" : "medium",
      detail: bad.length
        ? bad.map((s) => `${s.kind} ${s.sessionId.slice(0, 18)} spent ${s.cost.billedRatio}:1 fresh input per output token`).join("; ")
        : `no session exceeded 12:1 fresh input per output token (worst ${Math.max(0, ...a.sessions.map((s) => s.cost?.billedRatio ?? 0))}:1)`,
      sessions: bad.map((s) => s.sessionId),
    };
  },

  /** FALSIFIABLE and safety-critical: a session that produced nothing at all. */
  noOutput(a) {
    const dead = a.sessions.filter((s) => (s.cost?.totalOut ?? -1) === 0 && (s.cost?.callCount ?? 0) > 0);
    return {
      fired: dead.length > 0,
      severity: "high",
      detail: dead.length
        ? dead.map((s) => `${s.kind} ${s.sessionId.slice(0, 20)} made ${s.cost.callCount} calls and emitted zero output tokens`).join("; ")
        : "every session emitted output",
      sessions: dead.map((s) => s.sessionId),
    };
  },

  contextGrowth(a) {
    const grown = a.sessions.filter((s) => (s.cost?.growth ?? 1) > 3);
    return {
      fired: grown.length > 0,
      severity: grown.some((s) => (s.cost?.growth ?? 0) > 5) ? "high" : "medium",
      detail: grown.length
        ? grown.map((s) => `${s.kind} ${s.sessionId.slice(0, 18)} grew ${s.cost.growth}x (${s.cost.firstInput.toLocaleString()}->${s.cost.peakInput.toLocaleString()})`).join("; ")
        : `no session exceeded 3x context growth (worst ${Math.max(0, ...a.sessions.map((s) => s.cost?.growth ?? 0))}x)`,
      sessions: grown.map((s) => s.sessionId),
    };
  },

  /**
   * RETIRED from live rules on 2026-09-30 — kept so old citations still resolve.
   * This fired on properties of the machine (tool inventory, provider 500s) that the agent
   * cannot change, so the verdict could never go green. A check that cannot pass is noise.
   */
  deadSchema(a) {
    const s = a.schema;
    return {
      fired: s.neverUsedShare > 50,
      severity: "info",
      detail: `${s.neverUsed.length} unused tools = ${s.neverUsedTokens.toLocaleString()} tokens/call (${s.neverUsedShare}% of floor). Retired: not agent-controllable.`,
    };
  },

  /** RETIRED for the same reason as deadSchema — a provider blip is not an agent failure. */
  retryCost(a) {
    return {
      fired: a.totals.retries > 0,
      severity: "low",
      detail: `${a.totals.retries} retries observed. Retired: provider errors are not agent-controllable.`,
    };
  },

  unscopedSubagent(a) {
    const bad = a.sessions.filter((s) => s.kind === "subagent" && (s.cost?.billedInput ?? 0) > 100000);
    return {
      fired: bad.length > 0,
      severity: "high",
      detail: bad.length
        ? bad.map((s) => `${s.sessionId.slice(0, 24)} burned ${s.cost.billedInput.toLocaleString()} fresh tokens`).join("; ")
        : "no sub-agent exceeded 100k fresh tokens",
      sessions: bad.map((s) => s.sessionId),
    };
  },
};

// --------------------------------------------------------------- cycle ----

/**
 * Checks answer "is the agent behaving right now?", so they must be scoped to a session.
 * Scoping to the whole history guarantees a permanently red verdict, which is the same as
 * no verdict at all. Default scope is the live session; 'all' opts into lifetime reporting.
 */
export function scopeMachine(machine, scope) {
  if (scope === "all") return machine;
  // Pick by recency AND by kind. Verified 2026-09-30: picking purely by lastStartedAt let a
  // FINISHED sub-agent win, which flipped the verdict from VIOLATED to ALIGNED purely because
  // an evaluation sub-agent was running, while the main session sat at 4x context growth.
  // A false green on a live signal is worse than no signal, so the rule is: judge the parent.
  const mains = machine.sessions.filter((s) => s.kind === "main");
  const pool = mains.length ? mains : machine.sessions;
  const live = [...pool].sort((a, b) => String(b.lastStartedAt).localeCompare(String(a.lastStartedAt)))[0];
  if (!live) return machine;
  const scoped = {
    ...machine,
    sessions: [live],
    totals: {
      // Every field here must describe the scoped session. Leaving machine-wide fields beside
      // session-wide ones produced a self-contradictory object (12M cacheRead next to a 400k input).
      calls: live.cost.callCount,
      scored: live.cost.callCount,
      input: live.cost.totalIn,
      billedInput: live.cost.billedInput,
      cacheRead: live.cost.cacheRead,
      cacheHitShare: live.cost.cacheHitShare,
      output: live.cost.totalOut,
      reasoning: live.cost.reasoning,
      ratio: live.cost.rawRatio,
      billedRatio: live.cost.billedRatio,
      errors: live.cost.retries ?? 0,
      retries: live.cost.retries ?? 0,
      models: [...(machine.sessions.find((s) => s.sessionId === live.sessionId)?.models ?? [])],
    },
    // schema weight is a property of the runtime, not of one session, so it stays global
  };
  return scoped;
}

export function cycle(opts = {}) {
  const scope = opts.scope ?? "latest";
  const machine = analyse();
  const scoped = scopeMachine(machine, scope);
  const rules = loadRules();
  const verdicts = rules.map((r) => {
    if (r.retired) {
      return { ...r, status: "retired", fired: false, detail: `retired ${r.retired}; excluded from the verdict` };
    }
    if (r.caveat) {
      return { ...r, status: "caveat", fired: false, detail: "measured, but the agent cannot act on it; excluded from the verdict" };
    }
    if (r.check === "none") {
      return { ...r, status: "standing", fired: false, detail: "discipline, not a threshold" };
    }
    const fn = CHECKS[r.check];
    if (!fn) {
      return { ...r, status: "broken", fired: false, detail: `no check named '${r.check}' — rule cannot be evaluated` };
    }
    const res = fn(scoped);
    return { ...r, status: res.fired ? "violated" : "holding", severity: res.severity ?? "info", fired: res.fired, detail: res.detail, sessions: res.sessions ?? [] };
  });

  // Findings that no live rule covers are the raw material for the next rule.
  // NOTE: filter() keeps what returns true, so each entry is "is this UNCOVERED".
  const FINDING_RULE = {
    "tool-schema-overhead": "deadSchema",
    "dead-schema-weight": "deadSchema",
    "context-compounding": "contextGrowth",
    "low-yield-session": "lowYield",
    "no-output-session": "noOutput",
    "retry-storm": "retryCost",
  };
  const live = new Set(verdicts.filter((v) => v.check !== "none" && v.status !== "broken").map((v) => v.check));
  const uncovered = machine.findings.filter((f) => {
    const owning = FINDING_RULE[f.id] ?? f.id;
    return !live.has(owning);
  });

  const violated = verdicts.filter((v) => v.status === "violated");
  const broken = verdicts.filter((v) => v.status === "broken");

  // A rules file that parses to nothing must never read as a pass. This exact failure
  // happened on 2026-09-30: a heading-level edit made every rule unparseable, and the
  // system cheerfully reported ALIGNED while evaluating nothing.
  const rulesMissing = rules.length === 0;

  const record = {
    at: new Date().toISOString(),
    scope,
    subject: scope === "all" ? "lifetime" : (scoped.sessions[0]?.sessionId ?? "none"),
    rulesParsed: rules.length,
    rulesMissing,
    measured: machine.totals,
    verdicts: verdicts.map((v) => ({ id: v.id, check: v.check, status: v.status, severity: v.severity, detail: v.detail })),
    uncoveredFindings: uncovered.map((f) => ({ id: f.id, claim: f.claim })),
    verdict: rulesMissing ? "BROKEN" : violated.length ? "VIOLATED" : broken.length ? "DEGRADED" : "ALIGNED",
  };

  return { machine, scoped, scope, verdicts, violated, broken, uncovered, rulesMissing, record };
}

export function render(c) {
  const L = [];
  const s = c.scoped?.sessions?.[0];
  L.push("ALPHA — SELF-LEARNING VERDICT");
  L.push("=".repeat(72));
  L.push(`scope         ${c.scope} — ${s ? `${s.kind} ${s.sessionId.slice(0, 26)}` : "no session"}`);
  L.push(`measured      ${s ? `${s.cost.callCount} calls | ${s.cost.totalIn.toLocaleString()} in / ${s.cost.totalOut.toLocaleString()} out (${s.cost.ratio}:1)` : "nothing to measure"}`);
  L.push(`lifetime      ${c.machine.totals.calls} calls | ${c.machine.totals.input.toLocaleString()} in / ${c.machine.totals.output.toLocaleString()} out (${c.machine.totals.ratio}:1)`);
  L.push(`RULES         ${c.rulesMissing ? "NONE PARSED — rules.md unreadable" : `${c.verdicts.length} defined | ${c.verdicts.filter(v=>v.status==="holding").length} holding | ${c.violated.length} violated | ${c.broken.length} unevaluable`}`);
  L.push("");
  for (const v of c.verdicts) {
    const tag = v.status === "holding" ? "OK    " : v.status === "standing" ? "STATED" : v.status === "retired" ? "RETIRE" : v.status === "caveat" ? "CAVEAT" : v.status === "violated" ? "BREACH" : "BROKEN";
    L.push(`  [${tag}] ${v.id} ${v.title}`);
    L.push(`          ${v.detail}`);
  }
  if (c.uncovered.length) {
    L.push("");
    L.push("UNCOVERED FINDINGS — no rule claims these yet:");
    for (const f of c.uncovered) L.push(`  - ${f.id}: ${f.claim}`);
  }
  L.push("");
  L.push(`VERDICT: ${c.record.verdict}`);
  if (c.rulesMissing) {
    L.push("  rules.md parsed to zero rules. This is a FAILURE, not a pass. Check heading levels ('### R-00N').");
  } else if (c.violated.length) {
    L.push("  The agent is not currently living up to its own learned rules.");
  } else {
    L.push("  Every checkable rule currently holds.");
  }
  return L.join("\n");
}

if (process.argv[1]?.endsWith("learn.mjs")) {
  const c = cycle();
  mkdirSync(dirname(LEDGER), { recursive: true });
  appendFileSync(LEDGER, JSON.stringify(c.record) + "\n");
  if (!process.argv.includes("--quiet")) console.log(render(c));
  if (process.argv.includes("--json")) console.log(JSON.stringify(c.record, null, 2));
}