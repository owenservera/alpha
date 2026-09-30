# FORWARD DESIGN — what alpha is for, and what it should stop doing

Written 2026-09-30 while the system is young enough to still be redirected cheaply. This is
the ideation record: what is worth building next, what is worth killing, and why.

---

## The honest state of things

Alpha currently does three things: it reads ZCode's execution trace, it reports token
economics, and it enforces a handful of behavioural rules. A three-reviewer adversarial audit
concluded that **most of what it measures is a property of the runtime, not of the agent** —
the cache hit rate, the free model, the tool-schema floor. The agent can change none of them.

That is not a reason to stop. It is a reason to point the instrument at something the agent
*can* change.

---

## The one structural fact everything follows from

ZCode writes a complete record of every model call: every prompt, every tool call with its full
arguments, every output, every token, every error, every timestamp. On this machine that is
already ~180 calls and growing every session.

**Nobody is using it.** Not the harness, not the plugin ecosystem, not the agent itself. It is a
complete behavioural dataset being written continuously and read by nobody.

Every serious idea below is a different way of reading that dataset. That is why this project
has a defensible reason to exist at all — not the rules engine, but the reader.

---

## Ideas worth building

### 1 · Per-turn attribution — the highest-value gap

**The problem.** Every finding alpha produces is a session aggregate. "This session cost
207,609 fresh input tokens" is true and useless. *"The `Bash` call that dumped a 266 KB file
into context cost 40k tokens and produced nothing"* is actionable.

**The design.** Each model call has a `turnId`; consecutive calls share a turn. A turn's cost
is the **sum of each call's own fresh input** — `input − cacheRead` — across its calls.

```js
const fresh = (c) => (c.inputTokens ?? 0) - (c.cacheReadTokens ?? 0);   // never negative
const turnCost = (calls) => calls.reduce((a, c) => a + fresh(c), 0);
```

**A correction, applied before this shipped.** The first draft used *marginal* cost:
`input[i] − input[i−1]`. Measured against the live trace, that formula is wrong — it yields
**negative deltas** (observed: −35,555) whenever the cache absorbs more of one call than the
last, which is the common case on a 98%-hit workload. Cache eviction makes input lumpy and the
delta meaningless. Summing fresh input is monotonic, non-negative, and is exactly the work the
machine did. `toolkit/selftest.mjs` now asserts no turn can go negative.

### 1a · What per-turn attribution immediately found — the cache collapse

Session ratios said 2:1. Per-turn attribution said otherwise, and found this:

> **5 of 197 calls — 2.5% — account for 61% of every fresh token computed on this machine.**

| calls | cache hit | avg fresh tokens/call |
|---|---|---|
| 183 (93%) | 95–100% | **803** |
| 9 (5%) | 75–95% | 4,354 |
| **5 (2.5%)** | **0–25%** | **58,420** |

The worst single turn cost **175,144 fresh tokens** at a 0.07% cache hit rate, on a single Bash
call. When the cache collapses, the entire context is recomputed from scratch.

This is invisible at session level by construction: one 180:1 turn inside a session that
averages 2:1. It is also **not** a bad decision — it is provider-side cache eviction on a large
context, and an agent that "learned" to avoid those calls would be learning noise.

The actionable consequence is narrower and real: **the tail, not the average, is where compute
goes.** Any cost model that reasons about means will be wrong about this workload by two orders
of magnitude.

```js
if (cacheRead / inputTokens < 0.25) flagCollapse();   // don't average this call
```

#### 1a-i · The obvious follow-up hypothesis, tested and **rejected**

The first instinct was that collapse is caused by large contexts — so "keep context small"
would be the rule. Measured against every scored call on this machine:

| context band | calls | collapses | rate |
|---|---|---|---|
| 0–40,000 | 22 | 2 | 9% |
| 40,000–80,000 | 39 | 0 | **0%** |
| 80,000–120,000 | 43 | 0 | **0%** |
| 120,000+ | 99 | 1 | 1% |

Collapses occurred at contexts of 19,483 / 28,876 / 34,888 / 36,601 / 175,272. **There is no
correlation with size.** The rule "keep context small to avoid cache collapse" would have been
fabricated — it would have looked like a measured insight and been worth nothing.

At n=5 collapses the honest statement is: *collapse is real, large, and currently
unpredictable from anything the agent controls.* Recorded in `rules.md` as a measurement
caveat, **not** as a rule. A rule that cannot change a decision is decoration (R-006).

**Why it is falsifiable.** A turn with a marginal cost above a threshold and zero downstream
effect is measurable today. So is a turn whose output was never referenced by any later call —
which is the precise definition of work that was paid for and discarded.

**Risk.** Attribution is a modelling choice, and the wrong choice produces confident nonsense.
Needs Owen's input on the unit of attribution. This is why it is listed as an open question
rather than just built.

### 2 · Behavioural regression detection — closes the loop alpha leaves open

**The problem.** Alpha checks whether rules are *violated*. It never checks whether *fixing
them helped*. Rules accumulate; nothing ever retires one for being useless.

**The design.** Compare the metric a rule governs, before and after the rule was introduced.
If `contextGrowth` crossed 3× five times before R-002 existed and zero times after, the rule
works. If it fired as often after, the rule is decoration and should be retired — using the
same standard that retired R-001 and R-004.

**Why it matters.** It is the only mechanism that makes "self-learning" mean something. Without
it, alpha accumulates rules forever, which is the failure mode of every governance system ever
built.

### 3 · Failure-pattern mining across sessions

**The problem.** Failures are recorded per-call and then forgotten. The same mistake recurs
across sessions with no memory of the last time.

**The design.** Cluster errors and abandoned work by signature across the whole archive.
"Reads of large files are followed by a cancellation 40% of the time" is a pattern the agent
could learn to avoid *before* it happens.

**Why it is cheap.** The archive is already structured. This is aggregation, not new plumbing.

### 4 · Tool affordance learning

**The problem.** 30 of 37 declared tools were never invoked — 80% of the per-call context floor
is for tools that never get used. Alpha reports this but cannot act on it.

**The design.** Learn, per task shape, which tools actually get used. Then the *rule* can
change: not "unused tools are a tax" (which the agent cannot fix) but "when doing X, reaching
for Y wastes 6k tokens of context per turn" — which it can.

This is the difference between measuring the room and measuring the behaviour.

---

## Ideas worth killing

- **A constitutional document.** Written and deleted once already. It changed no decision.
- **A stop-condition engine that can halt on judgement.** A gate the agent can weaken is not a
  gate. If a stop gate is ever built, stop conditions must live in JSON with a schema check that
  fails closed — *not* in a markdown file this parser demonstrably drops rules from.
- **A growth ledger as a success metric.** Entries in `learnings.jsonl` went up while the
  verdict stayed pinned. Activity is not progress.
- **~~Anything that optimises token cost.~~ RETRACTED 2026-09-30.** I had this filed under
  'worth killing' on the reasoning that the model was free. That was me generalising one rate
  card into a principle. Owen corrected it: token spend is to be optimised at every chance we
  get. Keeping token optimisation is correct; the error was in what I was measuring, not in
  the value of measuring it.

---

## The open questions that are Owen's

These are not rhetorical. Each one changes what should be built, and none can be inferred from
a trace file:

1. **What is the primary goal variable?** Token spend is optimised at every opportunity
   regardless, so that is settled. Still undeclared: whether *cost* is the primary target or a
   co-equal one alongside latency, capability, reliability and context length — the last of
   which is plausible and entirely unmeasured. What alpha optimises *first*, when they conflict,
   is the open part.
2. **May alpha write to ZCode's configuration, or stay read-only?** Currently read-only. A
   self-modifying loop measured by a check it cannot pass, with no human in it, will eventually
   change whatever is doing the measuring. The anti-loophole answer is an external witness
   outside the agent's reach — which cannot be built from inside the agent.
3. **What should a unit of attribution be?** Turn, tool call, objective, or task?

---

## The honest counter-argument

Everything above rests on one premise: that a complete record of agent behaviour is worth
analysing. That may be false. If the cache absorbs 98% of context, the current rate card is
nothing here changes Owen's decisions tomorrow, then alpha is an elaborate mirror pointed at
its own furniture, and the right move is to keep `trace.mjs` and delete the rest.

The reviewer who said this was not being hostile. They were the most useful voice in the room.
The way to find out is to build idea #1 or #2 and see whether it changes anything. If neither
does, the mirror is the answer, and that is a legitimate result rather than a failure.