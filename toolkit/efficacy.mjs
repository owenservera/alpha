// efficacy.mjs — did the rule actually change anything?
//
// Alpha's missing half. It checks whether rules are violated; it never checks whether
// *complying* helped, or whether the rule is capable of being complied with at all.
//
// A rule that has never once held in any run since it was written is doing one of two things:
// it is decoration, or it is unenforceable. Those need opposite responses — delete it, or
// lower its bar — and the agent cannot tell them apart from the verdict alone.
//
// This reads the witnessed ledger and computes, per rule: runs since introduction, times held,
// times breached, and the metric the rule governs. It reports. It does not judge.
//
// Run: node toolkit/efficacy.mjs

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRules } from "./learn.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER = join(ROOT, "memory", "learnings.jsonl");

export function readLedger(path = LEDGER) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/**
 * Per-rule efficacy.
 *
 * `heldSinceBorn` is the number that matters: a rule that has never held since it was
 * introduced is either not working or not satisfiable, and the difference decides whether
 * it should be retired or loosened. Both are team decisions; neither is automatic.
 */
export function efficacy(rules = loadRules(), ledger = readLedger()) {
  const live = rules.filter((r) => r.check && r.check !== "none" && !r.retired && !r.caveat);
  const out = [];

  for (const r of live) {
    const born = r.learned ? new Date(r.learned) : null;
    // Entries recorded before the rule existed cannot count for or against it.
    const runs = born
      ? ledger.filter((e) => e.at && new Date(e.at) >= born && (e.verdicts ?? []).some((v) => v.id === r.id))
      : ledger.filter((e) => (e.verdicts ?? []).some((v) => v.id === r.id));

    const held = runs.filter((e) => (e.verdicts ?? []).find((v) => v.id === r.id)?.status === "holding").length;
    const breached = runs.filter((e) => (e.verdicts ?? []).find((v) => v.id === r.id)?.status === "violated").length;
    const evaluated = held + breached;

    // Consecutive breaches since the last hold — the honest "is this rule doing anything"
    // signal. Lifetime hold rate is noisy; a long unbroken breach streak is not.
    let streak = 0;
    for (let i = runs.length - 1; i >= 0; i--) {
      const st = (runs[i].verdicts ?? []).find((v) => v.id === r.id)?.status;
      if (st === "holding") break;
      if (st === "violated") streak++;
    }

    out.push({
      id: r.id,
      check: r.check,
      learned: r.learned,
      runsSinceBorn: runs.length,
      held,
      breached,
      holdRate: evaluated ? Math.round((held / evaluated) * 100) : null,
      breachStreak: streak,
      // Never held since it was written. Not a verdict — a question for the next cycle.
      neverHeld: evaluated > 0 && held === 0,
      neverBreached: evaluated > 0 && breached === 0,
      unevaluated: evaluated === 0,
      // Only meaningful once there is enough history to distinguish noise from a trend.
      enoughEvidence: runs.length >= 5,
      lastDetail: runs.length ? (runs[runs.length - 1].verdicts ?? []).find((v) => v.id === r.id)?.detail : null,
    });
  }

  return out;
}

export function render(rows) {
  const L = [];
  L.push("ALPHA — RULE EFFICACY");
  L.push("=".repeat(72));
  L.push("Did the rule change anything? Runs counted only since the rule was written.");
  L.push("");
  L.push(`  ${"rule".padEnd(7)}${"check".padEnd(16)}${"runs".padStart(6)}${"held".padStart(6)}${"brchd".padStart(7)}${"hold%".padStart(8)}  status`);
  for (const r of rows) {
    const status = r.unevaluated ? "no evidence yet"
      : r.neverHeld ? "NEVER HELD — decoration or unenforceable"
      : r.neverBreached ? "never breached — satisfied or inert"
      : r.enoughEvidence ? `${r.holdRate}% hold, streak ${r.breachStreak}`
      : "too few runs to judge";
    L.push(`  ${r.id.padEnd(7)}${r.check.padEnd(16)}${String(r.runsSinceBorn).padStart(6)}${String(r.held).padStart(6)}${String(r.breached).padStart(7)}${String(r.holdRate ?? "-").padStart(7)}%  ${status}`);
  }
  const suspects = rows.filter((r) => r.breachStreak >= 3);
  L.push("");
  if (suspects.length) {
    L.push("SUSPECT RULES — never satisfied since introduction:");
    for (const r of suspects) {
      L.push(`  ${r.id}: ${r.breachStreak} consecutive breaches (${r.holdRate}% lifetime hold). Either the`);
      L.push(`        rule does not work or it cannot be satisfied as written. Retiring it and`);
      L.push(`        lowering its threshold are opposite fixes; only more runs tell them apart.`);
    }
  } else {
    L.push("No rule has 3+ consecutive breaches.")
  }
  return L.join("\n");
}

if (process.argv[1]?.endsWith("efficacy.mjs")) {
  const rows = efficacy();
  console.log(process.argv.includes("--json") ? JSON.stringify(rows, null, 2) : render(rows));
}