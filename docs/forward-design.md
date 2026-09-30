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

**The design.** Each model call has a `turnId`. Consecutive calls share a turn. A turn's
marginal cost is `inputTokens[i] − inputTokens[i−1]` — the context it *added*. Attribute that
delta to the tool call that caused it, and the trace becomes a ledger of decisions with prices.

```js
// marginal cost of the i-th call, i.e. what the previous turn's output cost to re-send
const marginal = (calls, i) => (calls[i].inputTokens ?? 0) - (calls[i - 1]?.inputTokens ?? 0);
```

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
- **Anything that optimises token cost.** The model is free. Cost is not the objective; it was
  the only variable I could measure, which is not the same thing.

---

## The open questions that are Owen's

These are not rhetorical. Each one changes what should be built, and none can be inferred from
a trace file:

1. **What is the goal variable?** Cost is free. Latency, capability, reliability and context
   length are all plausible and all unmeasured. Alpha currently optimises nothing because it
   cannot choose.
2. **May alpha write to ZCode's configuration, or stay read-only?** Currently read-only. A
   self-modifying loop measured by a check it cannot pass, with no human in it, will eventually
   change whatever is doing the measuring. The anti-loophole answer is an external witness
   outside the agent's reach — which cannot be built from inside the agent.
3. **What should a unit of attribution be?** Turn, tool call, objective, or task?

---

## The honest counter-argument

Everything above rests on one premise: that a complete record of agent behaviour is worth
analysing. That may be false. If the model is free, the cache absorbs 98% of context, and
nothing here changes Owen's decisions tomorrow, then alpha is an elaborate mirror pointed at
its own furniture, and the right move is to keep `trace.mjs` and delete the rest.

The reviewer who said this was not being hostile. They were the most useful voice in the room.
The way to find out is to build idea #1 or #2 and see whether it changes anything. If neither
does, the mirror is the answer, and that is a legitimate result rather than a failure.