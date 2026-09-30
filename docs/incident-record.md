# INCIDENT RECORD — 2026-09-30

Every incident below is drawn from ZCode's own trace files, not from recollection. Regenerate
the live view with `node toolkit/resume.mjs`.

---

## I-1 · Network drop killed the session; nothing resumed it

**Observed.** Owen's network dropped mid-session. He reconnected. The work did not resume, and
ZCode did not restart the agent.

**Root cause — measured, not assumed.** Across 173 model calls on this machine, the final call
of a session lands on `finishReason: "stop"` only **6 times**. 166 calls end on
`"tool-calls"` — mid-work, with a tool call outstanding. A call that dies on a socket is
recorded with exactly the same shape as one that finished its turn. ZCode records no
"interrupted" state, so nothing downstream could tell the difference.

**Fix.** `toolkit/resume.mjs`. Completion is now *proven* by a natural `stop`, never assumed.
Every run of `node alpha.mjs` prints the interruption report; `--resume` prints it alone.

**Residual.** ZCode owns session lifecycle, so the agent cannot restart itself. A watchdog tick
(every 15 min) re-enters interrupted work. It cannot recover the dead turn's *reasoning*, only
what was in flight — that gap is real and is why per-turn intent capture matters.

---

## I-2 · The founding claim was wrong by a factor of ~50

**Observed.** Alpha's first thesis: "this runtime burns ~100 input tokens per output token."

**Root cause.** `usage.cacheReadTokens` exists in every single trace record and was never read.
**98% of input tokens are cache re-reads.** True fresh-work ratio: **~2:1**. The model in use,
`new-provider/space-bunny-free`, is free, so the alarming number carried **$0.00**.

**Found by** two independent reviewers who had not seen each other's work; confirmed directly
against the raw files.

**Fix.** `cacheReadTokens` is read; every ratio is reported both raw and fresh; `ratio` is
aliased to the fresh figure so no consumer can silently read the inflated one.

**Lesson, kept as R-005.** A measurement is not a fact until you know what it counts.

---

## I-3 · The verdict was pinned red by construction

**Observed.** All six ledger entries read `VIOLATED`. Green was unreachable.

**Root cause.** Two of four checks fired on properties of the *machine* — the installed tool
inventory and provider 500s — which the agent cannot change. One reachable state.

**Fix.** R-001 and R-004 retired, with the reason recorded. `ALIGNED` is now reachable, and a
regression test asserts retired rules never contribute to the verdict.

---

## I-4 · The verdict reported a false green

**Observed.** With an evaluation sub-agent running, the verdict read `ALIGNED` while the main
session sat at 4× context growth. Green *because a reviewer was running*.

**Root cause.** "Live session" was picked by recency, and a finished sub-agent can be the most
recent thing on disk.

**Fix.** The gate judges the **parent** session only (`kind === "main"`), and every field in the
scoped totals now describes that one session — previously `cacheRead` stayed machine-wide beside
a session-scoped `input`, producing a self-contradictory object.

---

## I-5 · DNS failure bypassed transport classification

**Observed live, mid-session.** `Provider returned a server error … Upstream error: getaddrinfo
ENOTFOUND opencode.ai`, status 502, `retryable=true`.

**Root cause.** The classifier matched transport failures by error *name* (`AI_APICallError`,
`TerminalStreamChunkError`) and by a message pattern that did not include DNS. The same outage
arriving under a generic `Error` name — which is how it arrived here — would have been
classified `unknown` rather than `transport`. A misread transport failure is a dropped retry.

**Fix.** Added `enotfound`, `getaddrinfo`, `eai_again`, `eaddrnotavail`, `upstream error` and
5xx status codes to the message pattern. Test coverage went from 5 to 8 signatures.

---

## I-6 · The watchdog classified its own live session as interrupted

**Observed.** During the first watchdog tick, the resume report listed the session that was
*executing that very tick* as `interrupted` and offered it for resume.

**Root cause.** `sessionOutcome()` had no liveness test. It inferred death from turn shape —
final call ended `tool-calls`, no natural `stop` — which is true of a live in-progress turn
exactly as much as of a dead one.

**Fix.** Liveness is now measured directly from the rollout file's mtime: a file still being
appended to (within 5 minutes) means the agent is mid-turn. `active` overrides every other
classification. The live session is now reported `ALIVE` and excluded from the resume list.

**Why this mattered more than it looks.** Without it the watchdog would spend every tick trying
to resume work that was already running — a false signal on the one mechanism whose entire job
is to notice when work has actually stopped.

---

## Failure taxonomy

| class | signatures seen | retryable | may stop the system? |
|---|---|---|---|
| `transport` | `TerminalStreamChunkError`, `AI_APICallError`, DNS `ENOTFOUND`, 502/503/504, `fetch failed` | yes | **never** |
| `cancel` | `AiSdkModelAdapterError: Model request was cancelled.` | yes | **never** |
| `preempt` | `v4 sendQueuedNow preempts active turn` | yes | **never** |
| `user-stop` | `v4 session stopped` | no | **yes — the only one** |

The asymmetry is the whole design. Three of four classes are the system failing to talk to a
network, and none of them is a decision by anyone. Only a deliberate stop ends the work.

---

## What is still broken

Recorded so it is not rediscovered as a surprise:

1. ~~**The rules-file parser silently drops a rule.**~~ **FIXED 2026-09-30.** A witnessed
   manifest (`memory/rules.manifest.json`) records every rule id and content hash. A rule that
   has vanished since the last witnessed run now forces `VERDICT: BROKEN`. Verified by demoting
   one heading: 9 rules -> 8 parsed, `missing: [R-003]`, verdict `BROKEN`. Before the fix this
   case reported `ALIGNED`. Locked by a regression test.
2. **The headline still reports one universal tool-schema floor** (18,735 tokens) when
   sub-agents carry a smaller set (11,611). Per-session figures are correct.
3. **The archive is write-only.** `raw/` is preserved but never read back, so the tool's numbers
   and its own evidence store drift apart.
4. **Two self-tests cannot fail by construction** (they assert an inline expression rather than
   calling the code under test).
5. ~~**No per-turn attribution.**~~ **BUILT 2026-09-30** — `toolkit/attribution.mjs`. It found
   that 5 of 197 calls hold 61% of all fresh compute, which session ratios cannot see.

The cache-collapse finding that motivated item 5 turned out **not** to be actionable: collapse
does not correlate with context size (see R-009). It is filed as a caveat, not a rule.