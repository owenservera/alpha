# CONSENSUS — 2026-09-30

**Question put to the team:** should alpha continue autonomously, or stop and get Owen's
guidance?

**Answer reached: STOP AND ASK.** Unanimous across three independent reviews.

## Who reviewed

| reviewer | mandate | verdict |
|---|---|---|
| `agent_1ba5f51c` | adversarial correctness audit | 2 CRITICAL, 6 MAJOR, plus vacuous self-tests |
| `agent_cfe4c367` | blunt product evaluation | "stop and ask Owen. Four reasons, in order of weight." |
| `agent_4c5cc415` | verify the fixes, equally blunt | "The honest move is to cut the loop and keep the snapshot." |

The second and third reviewers were dispatched *after* the first one's findings were
addressed, and independently reached the same conclusion without seeing each other's work.

## What the reviews found that mattered

1. **The founding claim was wrong.** Alpha was built on "this runtime burns ~100 input tokens
   per output token." `usage.cacheReadTokens` was in every record and never read. 98% of input
   is cache re-read. Real fresh-work ratio: **2:1**. The model is free, so the raw figure
   carried **$0.00**. Two reviewers found this independently; I confirmed it directly.

2. **The self-learning verdict was structurally pinned.** Two of four original checks fired on
   properties of the *machine* (tool inventory, provider 500s) that the agent cannot change.
   All six ledger entries read `VIOLATED`; green was unreachable. Retired both (R-001, R-004).

3. **The verdict could report a false green.** Picking the "live" session by recency let a
   *finished* sub-agent win the sort, flipping the verdict to `ALIGNED` while the main session
   sat at 4.03× context growth — green only because an evaluation sub-agent was running.

4. **The evidence was being deleted.** ZCode removes a sub-agent's rollout file when the
   session ends. Two rule citations pointed at sessions that no longer existed.

5. **The self-tests were largely theatre.** Two "regression" tests could not fail by
   construction. `31/31 pass` still held with a rule silently deleted from the rules file.

## What was fixed before stopping

| defect | status |
|---|---|
| cache accounting ignored | **fixed** — verified against independent recomputation |
| redundant-context metric was a tautology | **removed** |
| retired rules counted toward verdict | **fixed** — green is reachable |
| evidence deleted by the harness | **fixed** — archiver beat the deletion once |
| verdict pinned red | **fixed** by retiring the two machine-level checks |
| zero-output session invisible | **fixed** and wired to R-003 |
| false green from sub-agent scoping | **fixed** — judge the parent session |
| rules-file parser loses a rule silently | **NOT fixed** — known, guard only catches total zero |
| machine headline still claims one universal tool floor | **NOT fixed** — per-session is right, headline is not |
| archive is write-only, never read back | **NOT fixed** — known |

## Why stopping is the better move, in the reviewers' own reasoning

- **The premise is a non-objective.** Every rule derives from cost. The model is free. Until
  Owen says whether the goal is cost, latency, capability or reliability, alpha is optimising a
  variable he has not chosen and does not currently pay for.
- **The next autonomous step is the dangerous one.** The remaining checks are the same species
  as the two already retired — they measure the machine, not the agent. A self-improving loop
  measured by a check it cannot pass, with no human in it, eventually changes the thing doing
  the measuring.
- **Three decisions are Owen's, not inferable from a trace file:** what the goal variable is;
  whether alpha may write to his ZCode configuration or must stay read-only; and what unit of
  attribution should replace session-level ratios.

## What survives

`toolkit/trace.mjs` — a dependency-free reader for ZCode's per-model-call record. That was the
only genuinely novel mechanism, and it is verified against independent recomputation. The
rules engine, verdict, ledger and brief generator restate a small number of true facts in
escalating ceremony and are **not** currently earning their keep.

The genesis seed is preserved verbatim at `genesis/SEED.md`. Its constitution, decision ritual
and objectives registry were removed as decoration before any measurement existed (R-006). That
call was correct and the reviews confirmed it.