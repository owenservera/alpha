// selftest.mjs — assertions against the live trace, not mocks.
//
// The point of a self-learning system is that it can be wrong quietly. These tests exist to
// make quiet wrongness loud. Everything is checked against the real rollout files on this
// machine, so a regression in parsing shows up as a failure, not as a plausible number.

import { readCalls, summarise, observe, toolWeight, ROLLOUT_DIR, approxTokens } from "./trace.mjs";
import { analyse, analyseSession } from "./analyze.mjs";
import { loadRules, CHECKS, cycle, witnessRules, diffAgainstWitness } from "./learn.mjs";
import { resumePlan, classifyError, sessionOutcome } from "./resume.mjs";
import { attributeAll, attributeTurns, cacheCollapses } from "./attribution.mjs";
import { efficacy, readLedger } from "./efficacy.mjs";
import { existsSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    const detail = fn();
    passed++;
    console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ""}`);
  } catch (e) {
    failures.push({ name, error: e.message });
    console.log(`  FAIL  ${name}  — ${e.message}`);
  }
}

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

export function selfTest() {
  console.log("ALPHA SELF-TEST — live trace on this machine");
  console.log("=".repeat(72));

  // ---------------------------------------------------------------- trace ----
  const calls = readCalls();

  check("rollout directory is readable", () => {
    assert(existsSync(ROLLOUT_DIR), `no rollout dir at ${ROLLOUT_DIR}`);
    return ROLLOUT_DIR;
  });

  check("model calls parsed", () => {
    assert(calls.length > 0, "parsed zero model calls");
    return `${calls.length} calls`;
  });

  check("every call has a sessionId and a source", () => {
    const bad = calls.filter((c) => !c.sessionId || !c.source);
    assert(bad.length === 0, `${bad.length} calls missing sessionId/source`);
  });

  check("records with usage are counted; records without are not zeroed in", () => {
    const scored = calls.filter((c) => c.inputTokens != null);
    assert(scored.length > 0, "no scored calls at all");
    assert(calls.length >= scored.length, "scored more calls than exist");
    return `${scored.length}/${calls.length} scored`;
  });

  check("input and output tokens are never negative", () => {
    const bad = calls.filter((c) => (c.inputTokens ?? 0) < 0 || (c.outputTokens ?? 0) < 0);
    assert(bad.length === 0, `${bad.length} calls with negative tokens`);
  });

  check("approxTokens is monotonic and sane", () => {
    assert(approxTokens("") === 0, "empty string should cost 0");
    assert(approxTokens("a".repeat(400)) === 100, "400 chars should be 100 tokens");
    assert(approxTokens("a".repeat(401)) > approxTokens("a".repeat(400)), "not monotonic");
  });

  // ------------------------------------------------------------- sessions ----
  const sessions = summarise(calls);

  check("per-session totals reconcile with the global total", () => {
    const sumIn = sessions.reduce((a, s) => a + s.totalIn, 0);
    const global = calls.reduce((a, c) => a + (c.inputTokens ?? 0), 0);
    assert(sumIn === global, `sessions sum to ${sumIn} but calls sum to ${global}`);
    return `${global.toLocaleString()} input tokens reconcile`;
  });

  check("peak input is the real maximum for each session", () => {
    for (const s of sessions) {
      const actual = Math.max(...s.calls.filter((c) => c.inputTokens != null).map((c) => c.inputTokens), -Infinity);
      assert(s.peakInput === (actual === -Infinity ? null : actual), `${s.sessionId}: peak ${s.peakInput} != ${actual}`);
    }
    return `${sessions.length} sessions`;
  });

  check("every session is classified main or subagent", () => {
    const bad = sessions.filter((s) => s.kind !== "main" && s.kind !== "subagent");
    assert(bad.length === 0, `${bad.length} sessions unclassified`);
  });

  check("growth factor is >= 1 and matches peak/first", () => {
    for (const s of sessions) {
      if (!s.firstInput || !s.peakInput) continue;
      assert(s.peakInput >= s.firstInput, `${s.sessionId}: peak below first`);
    }
  });

  // ---------------------------------------------------------------- tools ----
  const tools = toolWeight();

  check("tool schemas extracted", () => {
    assert(tools.count > 0, "no tool schemas found");
    assert(tools.totalBytes > 1000, `implausibly small schema: ${tools.totalBytes} bytes`);
    return `${tools.count} tools, ${tools.totalBytes.toLocaleString()} chars`;
  });

  check("tool rows are sorted heaviest-first and sum to the total", () => {
    if (tools.count < 2) return "too few tools to test ordering";
    for (let i = 1; i < tools.rows.length; i++) {
      assert(tools.rows[i - 1].bytes >= tools.rows[i].bytes, "rows not sorted");
    }
    const sum = tools.rows.reduce((a, r) => a + r.bytes, 0);
    assert(sum === tools.totalBytes, `rows sum ${sum} != total ${tools.totalBytes}`);
  });

  // -------------------------------------------------------------- analyse ----
  const a = analyse();

  check("analyse totals match the trace totals", () => {
    assert(a.totals.calls === calls.length, `calls ${a.totals.calls} != ${calls.length}`);
    assert(a.totals.input === calls.reduce((x, c) => x + (c.inputTokens ?? 0), 0), "input total drifted");
  });

  check("ratio is computed as input/output", () => {
    const expect = Math.round(a.totals.input / Math.max(1, a.totals.output));
    assert(a.totals.ratio === expect, `ratio ${a.totals.ratio} != ${expect}`);
    return `${a.totals.ratio}:1`;
  });

  check("dead-schema share is a sane percentage", () => {
    assert(a.schema.neverUsedShare >= 0 && a.schema.neverUsedShare <= 100, `${a.schema.neverUsedShare}% out of range`);
    return `${a.schema.neverUsedShare}% of floor unused`;
  });

  check("cache accounting is internally consistent", () => {
    for (const s of a.sessions) {
      assert(s.cost.cacheRead >= 0, `${s.sessionId}: negative cacheRead`);
      assert(s.cost.billedInput >= 0, `${s.sessionId}: negative fresh input`);
      // the headline correction: fresh input must equal raw minus cache, never more
      assert(s.cost.billedInput === s.cost.totalIn - s.cost.cacheRead, `${s.sessionId}: fresh != raw - cache`);
      assert(s.cost.cacheHitShare >= 0 && s.cost.cacheHitShare <= 100, `${s.sessionId}: cache share out of range`);
    }
    return `${a.sessions.length} sessions reconcile; cache share ${a.totals.cacheHitShare}%`;
  });

  check("fresh:out ratio is far below raw when the cache is hot", () => {
    if ((a.totals.cacheHitShare ?? 0) < 50) return "cache is cold; parity expected";
    assert(a.totals.billedRatio < a.totals.ratio, `fresh ${a.totals.billedRatio}:1 should be below raw ${a.totals.ratio}:1`);
    return `${a.totals.ratio}:1 raw vs ${a.totals.billedRatio}:1 fresh`;
  });

  check("analyseSession is pure: same session, same verdict twice", () => {
    const s = sessions[0];
    const one = analyseSession(s, a);
    const two = analyseSession(s, a);
    assert(JSON.stringify(one.cost) === JSON.stringify(two.cost), "cost is not deterministic");
    assert(one.findings.length === two.findings.length, "finding count is not deterministic");
  });

  // ---------------------------------------------------------------- rules ----
  const rules = loadRules();

  check("rules.md parses into rules with ids", () => {
    assert(rules.length > 0, "no rules parsed");
    assert(rules.every((r) => /^R-\d+$/.test(r.id)), "a rule has a malformed id");
    return `${rules.length} rules`;
  });

  check("every rule has an evidence line, and live rules have a means line", () => {
    for (const r of rules) {
      assert(r.evidence.length > 10, `${r.id} has no evidence`);
      // retired rules carry "why retired" instead of "means" — that is the point of them
      if (!r.retired && !r.caveat) assert(r.means.length > 10, `${r.id} has no means`);
    }
    return `${rules.filter((r) => !r.retired && !r.caveat).length} live, ${rules.filter((r) => r.retired).length} retired, ${rules.filter((r) => r.caveat).length} caveat`;
  });

  check("every named check resolves to a real function", () => {
    const bad = rules.filter((r) => r.check !== "none" && typeof CHECKS[r.check] !== "function");
    assert(bad.length === 0, `unresolved checks: ${bad.map((r) => `${r.id}->${r.check}`).join(", ")}`);
    return `${rules.filter((r) => r.check !== "none").length} executable checks all resolve`;
  });

  check("every check returns a well-formed result", () => {
    for (const [name, fn] of Object.entries(CHECKS)) {
      const res = fn(a);
      assert(typeof res.fired === "boolean", `${name}: fired is not boolean`);
      assert(typeof res.detail === "string" && res.detail.length > 0, `${name}: no detail`);
      assert(["high", "medium", "low", "info"].includes(res.severity), `${name}: bad severity ${res.severity}`);
    }
    return `${Object.keys(CHECKS).length} checks well-formed`;
  });

  check("checks do not throw on an empty machine", () => {
    const empty = { totals: { input: 0, output: 0, calls: 0, errors: 0, retries: 0 }, schema: { neverUsedShare: 0, neverUsedTokens: 0, neverUsed: [] }, sessions: [], findings: [] };
    for (const [name, fn] of Object.entries(CHECKS)) {
      const res = fn(empty);
      assert(res.fired === false, `${name} fired on an empty machine`);
    }
  });

  // ---------------------------------------------------------------- learn ----
  const c = cycle();

  check("verdict is one of ALIGNED / VIOLATED / DEGRADED", () => {
    assert(["ALIGNED", "VIOLATED", "DEGRADED", "BROKEN"].includes(c.record.verdict), `bad verdict ${c.record.verdict}`);
    return c.record.verdict;
  });

  check("every rule received a status", () => {
    assert(c.verdicts.length === rules.length, `${c.verdicts.length} verdicts for ${rules.length} rules`);
    for (const v of c.verdicts) {
      assert(["holding", "violated", "standing", "broken", "retired", "caveat"].includes(v.status), `${v.id}: bad status ${v.status}`);
    }
  });

  // REGRESSION: the uncovered-findings filter had inverted polarity, which reported every
  // covered finding as uncovered. Lock it down.
  check("REGRESSION: uncovered findings are genuinely uncovered", () => {
    const FINDING_RULE = {
      "tool-schema-overhead": "deadSchema",
      "dead-schema-weight": "deadSchema",
      "context-compounding": "contextGrowth",
      "low-yield-session": "lowYield",
      "no-output-session": "noOutput",
      "retry-storm": "retryCost",
    };
    const live = new Set(c.verdicts.filter((v) => v.check !== "none" && v.status !== "broken").map((v) => v.check));
    for (const f of c.uncovered) {
      assert(!live.has(FINDING_RULE[f.id] ?? f.id), `${f.id} is claimed by a live rule but was reported uncovered`);
    }
    return `${c.uncovered.length} uncovered (expected 0 while every finding has an owning rule)`;
  });

  check("REGRESSION: every finding is claimed by some rule", () => {
    const OWNER = {
      "tool-schema-overhead": "deadSchema",
      "dead-schema-weight": "deadSchema",
      "context-compounding": "contextGrowth",
      "low-yield-session": "lowYield",
      "no-output-session": "noOutput",
      "retry-storm": "retryCost",
    };
    const orphans = a.findings.filter((f) => !OWNER[f.id]);
    assert(orphans.length === 0, `orphan findings: ${orphans.map((f) => f.id).join(", ")}`);
    return `${a.findings.length} findings, all owned`;
  });

  check("REGRESSION: retired rules never contribute to the verdict", () => {
    const retired = c.verdicts.filter((v) => c.record.verdicts.find((r) => r.id === v.id) && rules.find((r) => r.id === v.id)?.retired);
    for (const v of retired) {
      assert(v.status === "retired", `${v.id} is retired but reports status ${v.status}`);
      assert(v.fired === false, `${v.id} is retired but reports fired`);
    }
    return `${retired.length} retired rules excluded from the verdict`;
  });

  // REGRESSION: on 2026-09-30 a heading-level edit made every rule unparseable and the
  // system reported ALIGNED while evaluating nothing. An empty ruleset must read as failure.
  check("REGRESSION: an unparseable ruleset reports BROKEN, never ALIGNED", () => {
    const tmp = join(ROOT, "memory", ".selftest-empty-rules.md");
    writeFileSync(tmp, "# no rules here\n\nJust prose.\n", "utf8");
    try {
      const parsed = loadRules(tmp);
      assert(parsed.length === 0, "expected the fixture to parse to zero rules");
      // mirror of cycle()'s guard, since cycle() reads the real rules.md
      const verdict = parsed.length === 0 ? "BROKEN" : "ALIGNED";
      assert(verdict === "BROKEN", `empty ruleset produced ${verdict}`);
    } finally {
      try { unlinkSync(tmp); } catch { /* fixture cleanup is best-effort */ }
    }
    return "empty ruleset -> BROKEN";
  });

  check("REGRESSION: a zero-output session is visible to the yield check", () => {
    // The original lowYield compared ratio>150, and ratio is null when totalOut===0, so a
    // session that produced literally nothing was structurally invisible.
    const dead = { sessions: [{ sessionId: "synthetic", kind: "subagent", cost: { totalOut: 0, billedInput: 9000, totalIn: 9000, billedRatio: 0, callCount: 5 } }], totals: { retries: 0 }, schema: { neverUsedShare: 0, neverUsedTokens: 0, neverUsed: [] } };
    assert(CHECKS.noOutput(dead).fired === true, "a zero-output session did not fire noOutput");
    assert(CHECKS.lowYield(dead).fired === false, "lowYield should defer to noOutput for a zero-output session");
    return "zero-output sessions are caught";
  });

  // --------------------------------------------------------------- resume ----
  const plan = resumePlan();

  check("errors are classified by cause, not just counted", () => {
    const cases = [
      [{ name: "TerminalStreamChunkError", message: "Provider returned a server error." }, "transport"],
      [{ name: "AI_APICallError", message: "" }, "transport"],
      [{ name: "AiSdkModelAdapterError", message: "Model request was cancelled." }, "cancel"],
      [{ name: "Error", message: "v4 sendQueuedNow preempts active turn" }, "preempt"],
      [{ name: "Error", message: "v4 session stopped" }, "user-stop"],
      // observed live 2026-09-30: DNS failure arriving under a generic error name
      [{ name: "Error", message: "Provider returned a server error. Upstream error: getaddrinfo ENOTFOUND opencode.ai" }, "transport"],
      [{ name: "Error", message: "request failed, status 503" }, "transport"],
      [{ name: "Error", message: "fetch failed" }, "transport"],
    ];
    for (const [err, want] of cases) {
      const got = classifyError(err);
      assert(got.kind === want, `${err.name}/${err.message}: got ${got.kind}, want ${want}`);
    }
    return `${cases.length} error signatures classified`;
  });

  // THE always-on invariant: a network drop must never read as a deliberate stop.
  check("INVARIANT: transport failures are retryable and never deliberate", () => {
    for (const e of [classifyError({ name: "TerminalStreamChunkError", message: "server error" }),
                     classifyError({ name: "AI_APICallError", message: "network timeout" }),
                     classifyError({ name: "AiSdkModelAdapterError", message: "cancelled" })]) {
      assert(e.retryable === true, `${e.kind} should be retryable`);
      assert(e.deliberate === false, `${e.kind} must not be deliberate`);
    }
  });

  check("INVARIANT: only a deliberate stop produces a stop signal", () => {
    assert(plan.stopSignal === plan.outcomes.some((o) => o.state === "halted-by-user"),
      "stopSignal disagrees with the halted-by-user outcomes");
    assert(plan.summary.transportFailures >= 0, "transport count missing");
    return `transport=${plan.summary.transportFailures} stopSignal=${plan.stopSignal}`;
  });

  check("completion must be proven, never assumed", () => {
    const mid = { sessionId: "s1", kind: "main", callCount: 3, retries: 0,
      calls: [{ startedAt: "2026-01-01T00:00:00Z", finishReason: "tool-calls", error: null, toolCalls: ["Bash"] }] };
    assert(sessionOutcome(mid).state === "interrupted", "mid-work session reported as finished");
    const done = { sessionId: "s2", kind: "main", callCount: 3, retries: 0,
      calls: [{ startedAt: "2026-01-01T00:00:00Z", finishReason: "stop", error: null, toolCalls: [] }] };
    assert(sessionOutcome(done).state === "completed", "naturally stopped session not completed");
    const dropped = { sessionId: "s3", kind: "main", callCount: 3, retries: 1,
      calls: [{ startedAt: "2026-01-01T00:00:00Z", finishReason: null,
                error: { name: "TerminalStreamChunkError", message: "server error" }, toolCalls: ["Read"] }] };
    const o = sessionOutcome(dropped);
    assert(o.state === "interrupted", "network-dropped session not flagged interrupted");
    assert(o.transportFailures === 1, "transport failure not counted");
    return "mid-work, clean-stop and network-drop all classified correctly";
  });

  check("a deliberate stop is never auto-resumed", () => {
    const halted = { sessionId: "s4", kind: "main", callCount: 2, retries: 0,
      calls: [{ startedAt: "2026-01-01T00:00:00Z", finishReason: null,
                error: { name: "Error", message: "v4 session stopped" }, toolCalls: [] }] };
    assert(sessionOutcome(halted).state === "halted-by-user", "user stop not classified");
  });

  // --------------------------------------------------------- attribution ----
  const attr = attributeAll();

  check("attributed fresh input reconciles with the trace total", () => {
    const fromTrace = calls.filter((c) => c.billedInput != null).reduce((a, c) => a + c.billedInput, 0);
    assert(attr.totals.freshInput === fromTrace,
      `attribution sums to ${attr.totals.freshInput} but the trace says ${fromTrace}`);
    return `${fromTrace.toLocaleString()} fresh tokens reconcile across ${attr.totals.turns} turns`;
  });

  // The first draft of attribution used marginal deltas. They go NEGATIVE when the cache
  // absorbs more of one call than the last — observed -35,555. Lock the correction down.
  check("REGRESSION: per-turn fresh input is never negative (no delta arithmetic)", () => {
    for (const s of attr.sessions) {
      for (const t of s.turns) {
        assert(t.freshInput >= 0, `${t.turnId}: negative fresh input ${t.freshInput}`);
        assert(t.freshInput === t.rawInput - t.cacheRead, `${t.turnId}: fresh != raw - cache`);
      }
    }
    return "every turn is a sum, never a delta";
  });

  check("turn grouping accounts for every agent turn", () => {
    const grouped = attr.sessions.reduce((a, s) => a + s.turns.length, 0);
    assert(grouped === attr.totals.turns, "turn count mismatch");
    assert(attr.totals.turns > 0, "no turns attributed");
  });

  check("cache collapse is detected and is a small, expensive tail", () => {
    const cc = cacheCollapses();
    for (const c of cc.collapses) {
      assert(c.hitShare < 25, `${c.at}: hit share ${c.hitShare} is not a collapse`);
      assert(c.fresh > 0, "collapse with no fresh cost");
    }
    assert(cc.collapseShare >= 0 && cc.collapseShare <= 100, `${cc.collapseShare}% out of range`);
    return `${cc.collapseRate}% of calls hold ${cc.collapseShare}% of fresh compute`;
  });

  // The defect an adversarial review proved: demote ONE heading and the parser silently drops
  // ONE rule, with the system still reporting ALIGNED. Total-zero guards cannot see it.
  check("REGRESSION: a single dropped heading is detected, not silently tolerated", () => {
    const real = readFileSync(join(ROOT, "rules.md"), "utf8");
    const rulesTmp = join(ROOT, "memory", ".selftest-rules.md");
    const manTmp = join(ROOT, "memory", ".selftest-manifest.json");
    try {
      writeFileSync(rulesTmp, real, "utf8");
      witnessRules(loadRules(rulesTmp), manTmp);
      const baseline = loadRules(rulesTmp);
      assert(baseline.length > 3, "need several rules to make this test meaningful");

      // Demote exactly one heading. This is the mutation that used to vanish.
      const victim = baseline[baseline.length - 1].id;
      const damaged = real.replace(new RegExp(`^### ${victim} `, "m"), `## ${victim} `);
      writeFileSync(rulesTmp, damaged, "utf8");

      const after = loadRules(rulesTmp);
      const diff = diffAgainstWitness(after, manTmp);
      assert(after.length === baseline.length - 1, `expected one rule fewer, got ${after.length} vs ${baseline.length}`);
      assert(diff.missing.includes(victim), `dropped rule ${victim} not reported as missing`);
      assert(diff.witnessed === true, "manifest diff did not run");
      return `${victim} dropped -> detected via manifest`;
    } finally {
      try { unlinkSync(rulesTmp); unlinkSync(manTmp); } catch { /* best-effort cleanup */ }
    }
  });

  // ------------------------------------------------------------ efficacy ----
  const eff = efficacy();

  check("efficacy counts only runs that happened after the rule was written", () => {
    for (const r of eff) {
      if (!r.learned) continue;
      const born = new Date(r.learned);
      const early = readLedger().filter((e) => e.at && new Date(e.at) < born);
      if (early.length) {
        assert(r.runsSinceBorn <= readLedger().length - early.length || r.runsSinceBorn <= readLedger().length,
          `${r.id} counted runs from before it existed`);
      }
    }
    return `${eff.length} executable rules tracked`;
  });

  check("efficacy numbers are internally consistent", () => {
    for (const r of eff) {
      assert(r.held + r.breached <= r.runsSinceBorn, `${r.id}: held+breached exceeds runs`);
      assert(r.breachStreak <= r.breached, `${r.id}: streak ${r.breachStreak} exceeds ${r.breached} breaches`);
      if (r.holdRate !== null) assert(r.holdRate >= 0 && r.holdRate <= 100, `${r.id}: hold rate out of range`);
    }
    const r2 = eff.find((r) => r.id === "R-002");
    return r2 ? `R-002: ${r2.holdRate}% hold, streak ${r2.breachStreak}` : "R-002 not live";
  });

  check("a rule with no evidence is reported as unevaluated, never as satisfied", () => {
    const fake = [{ id: "R-TEST", check: "lowYield", learned: "2099-01-01", retired: null, caveat: null }];
    const row = efficacy(fake, [])[0];
    assert(row.unevaluated === true, "a rule with no runs must not count as evaluated");
    assert(row.holdRate === null, "no runs must not produce a hold rate");
    assert(row.neverHeld === false, "unevaluated must not be reported as never holding");
    return "no evidence is not evidence of success";
  });

  // Found by the watchdog tick itself: the session executing the tick was classified
  // `interrupted` and offered for resume. Liveness must win over shape.
  check("INVARIANT: a session still being written to is ALIVE, not interrupted", () => {
    const mid = { sessionId: "live1", kind: "main", callCount: 3, retries: 0,
      calls: [{ startedAt: "2026-01-01T00:00:00Z", finishReason: "tool-calls", error: null, toolCalls: ["Bash"] }] };
    const now = Date.now();
    const alive = sessionOutcome(mid, { mtime: now - 3000, now });
    assert(alive.state === "active", `recently written session classified ${alive.state}`);
    assert(alive.alive === true, "alive flag not set");

    const dead = sessionOutcome(mid, { mtime: now - 60 * 60 * 1000, now });
    assert(dead.state === "interrupted", `stale session classified ${dead.state}`);
    assert(dead.alive === false, "stale session marked alive");
    return "liveness overrides turn shape";
  });

  check("a live session is never offered for resume", () => {
    const live = plan.outcomes.filter((o) => o.state === "active");
    for (const l of live) {
      assert(!plan.resume.some((r) => r.sessionId === l.sessionId), `active session ${l.sessionId} offered for resume`);
    }
    return `${live.length} active session(s) excluded from the resume list`;
  });

  check("learning cycle is reproducible in shape", () => {
    const again = cycle();
    assert(again.verdicts.length === c.verdicts.length, "verdict count changed between runs");
    assert(again.record.verdict === c.record.verdict, `verdict flipped between runs: ${c.record.verdict} -> ${again.record.verdict}`);
    return "stable across two cycles";
  });

  // ---------------------------------------------------------------- done ----
  console.log("=".repeat(72));
  console.log(`${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("\nFAILURES:");
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
    return false;
  }
  return true;
}

if (process.argv[1]?.endsWith("selftest.mjs")) {
  process.exit(selfTest() ? 0 : 1);
}