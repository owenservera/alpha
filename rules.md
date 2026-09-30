# ALPHA — LEARNED OPERATING RULES

Each rule below was extracted from a measurement on this machine. Each carries a `check:`
line naming a function in `toolkit/learn.mjs`, which is evaluated against the live execution
trace on every run. **Two rules are retired.** They are kept because the record of why they
were retired is the point.

Verify with `node toolkit/selftest.mjs`. Regenerate evidence with `node alpha.mjs`.

---

### R-001 · RETIRED — the toolbox is priced before you act

- **retired:** 2026-09-30, after adversarial review
- **evidence:** 30 of 37 tool schemas never invoked, carrying 14,908 tokens/call (80% of floor)
- **why retired:** the check fired on a property of the machine — the installed tool
  inventory — which the agent cannot change. It had exactly one reachable state: red. A check
  that cannot pass is not accountability, it is decoration. The *observation* survives as a
  note in `brief.md`; the *rule* did not.
- **check:** `deadSchema` (retained so the citation resolves; no rule now claims it)

---

### R-002 · Context compounds — measure it as attention, not as cost

- **learned:** 2026-09-30
- **evidence:** the live session grew 34,888 → 126,974 tokens, a 3.64× increase across 94
  calls (`node alpha.mjs`, session `sess_e124448c`).
- **correction:** an earlier version of this rule said context is "quadratically expensive."
  That was written before cache accounting existed. With 98% cache hit rate, re-reading
  context is close to free in tokens; it still costs latency and attention.
- **check:** `contextGrowth`
- **means:** Length is not automatically a problem, but it is never free. Finishing a line of
  work and handing off is still better than accumulating, for reasons that have nothing to do
  with the token bill.

---

### R-003 · Work that is paid for and not delivered is the worst outcome

- **learned:** 2026-09-30
- **evidence:** sub-agent `sess_subagent_agent_561f01b1` made 20 calls and emitted 5,027
  output tokens against 1,567,880 input tokens. It was given "read the whole 266 KB
  transcript" as its task.
- **LABELLED CLAIM, NOT REPRODUCIBLE:** that trace file was deleted by ZCode before
  `archiveRollouts` existed, and it is unrecoverable — not in the live rollout dir, not in
  `raw/`, nowhere on disk. The figure above is from the session that observed it. Under R-007
  this citation is a claim, not evidence.
- **check:** `lowYield` (fresh input per output token, threshold 12:1) **and `noOutput`**
  (a session that emits zero tokens fires `noOutput`; the threshold cannot catch it because
  its own ratio is undefined)
- **means:** Before spawning, name the smallest artifact that proves the premise. If you
  cannot name it, do not spawn. A sub-agent inherits your context and multiplies your turns.

---

### R-004 · RETIRED — a retry re-pays the whole conversation

- **retired:** 2026-09-30, after adversarial review
- **evidence:** 12 retried calls carrying `AiSdkModelAdapterError`, `AI_APICallError`, `Error`
- **why retired:** these are provider-side 500s and cancellations. The agent cannot prevent
  them. The check fired on `totalRetries > 0` and therefore never went green.
- **check:** `retryCost` (retained for citation; no rule now claims it)

---

### R-005 · Read the machine before you describe it — and check what the number counts

- **learned:** 2026-09-30, revised the same day after this rule was nearly violated by me
- **evidence:** alpha's founding claim was "this runtime burns ~100 input tokens per output
  token — a catastrophic ratio." Two independent reviewers found the same flaw, and I
  confirmed it directly: `usage.cacheReadTokens` was present in every record and never read.
  **98% of input tokens are cache re-reads.** The real figure is 207,609 fresh input tokens
  against 109,275 output — about **2:1**, which is unremarkable. The model in use,
  `new-provider/space-bunny-free`, is free, so the marginal cost of the raw number is $0.00.
- **check:** `none` (a standing discipline)
- **means:** A measurement is not a fact until you know what it counts. Before reporting a
  ratio, establish which term is inflated, which is real, and which is free. This rule caught
  its own author; that is the only evidence it has.

---

### R-006 · Don't build ceremony you have no evidence for — including mine

- **learned:** 2026-09-30
- **evidence:** I wrote this rule, then spent the next hour building exactly the thing it
  forbids: four non-falsifiable checks, a brief generator, a ledger, and 27 self-tests that
  largely asserted the arithmetic of my own code against itself. The two reviewers both found
  it. Six of six ledger entries read `VIOLATED`, and it never once could have read anything
  else.
- **check:** `none` (a standing discipline)
- **means:** Two of four original checks were deleted *because they could never go green*.
  When a verdict is structurally pinned, the verdict is decoration. Count how many of your
  rules could fail, not how many exist.

---

### R-007 · The harness deletes the evidence

- **learned:** 2026-09-30
- **evidence:** ZCode removes `model-io-<subagent-session>.jsonl` when a sub-agent session
  ends. Two rule citations (R-002, R-003) pointed at sessions that no longer existed on disk,
  and the "lifetime" call count fell from 137 to 87 in three minutes because a 6 MB file
  disappeared. A citation to a deleted file is not evidence; it is a memory.
- **check:** `none` (handled mechanically by `archiveRollouts`)
- **means:** `raw/` snapshots every rollout file before it can vanish. Any claim in this file
  must be reproducible from `raw/`, or it is labelled a claim.

---

### R-009 · CAVEAT, not a rule — cache collapse is real but unpredictable

- **learned:** 2026-09-30
- **evidence:** `toolkit/attribution.mjs` — 5 of 197 calls (2.5%) hold 61% of all fresh compute.
  Normal calls average 803 fresh tokens; those five average 58,420. Worst single turn: 175,144
  at a 0.07% cache hit rate.
- **hypothesis tested and REJECTED:** that collapse follows large contexts. It does not. Rate by
  context band: 0-40k = 2/22, 40-80k = 0/39, 80-120k = 0/43, 120k+ = 1/99. Observed at
  contexts of 19,483 / 28,876 / 34,888 / 36,601 / 175,272 — no size correlation.
- **why this is not a rule:** the agent cannot influence it. "Keep context small to avoid
  collapse" would have read like a measured insight and been worth nothing. Filed as a caveat so
  the number is not rediscovered and misattributed (R-006).
- **what it does change:** any cost model reasoning about *means* is wrong about this workload
  by two orders of magnitude. Read the tail, never the average.

---

### R-008 · Session-level ratios cannot support a decision

- **learned:** 2026-09-30, from the product review
- **evidence:** every finding in alpha is a session-level aggregate. The 312:1 sub-agent and
  the 3:1 main session are both true and both useless for deciding what to do next.
- **check:** `none` (known gap — see the open questions in `AGENTS.md`)
- **means:** To attribute cost to a decision, spend must be attributed to the *turn* that
  caused it. Not yet built. This is the highest-value missing piece, and it needs Owen to
  choose what the unit of attribution should be.