# ALPHA — Operating Brief

**Run `node alpha.mjs`.** Then read `brief.md`. Everything else here is short on purpose.

## What this is

Alpha reads ZCode's own execution record and measures what this agent actually did. ZCode
writes one JSON line per model call to `~/.zcode/cli/rollout/model-io-*.jsonl`. That file is
the only objective evidence available about how this agent is behaving, so alpha measures it,
and constrains itself with rules extracted from those measurements.

The genesis seed that started this project is preserved verbatim at `genesis/SEED.md`. It is
provenance, not policy. Its constitution, decision ritual and objectives registry were written
before anything was measured and were removed as decoration — see R-006.

## The measured state, and a retraction

Current numbers are in `brief.md`, regenerated every run. The headline:

| | |
|---|---|
| raw input : output | ~99 : 1 |
| **cache re-read** | **98% of all input tokens** |
| **fresh (computed) input : output** | **~2 : 1** |

**On 2026-09-30 this system's founding claim was wrong and is retracted.** It asserted a
"~100 input tokens per output token" pathology. `usage.cacheReadTokens` was present in every
single record and was never read. The real fresh-work ratio is about 2:1 — unremarkable. The
model in use, `new-provider/space-bunny-free`, is free, so the raw figure carried $0.00 of
marginal cost. Two independent reviewers found this; I confirmed it against the raw files.

The lesson is R-005, and it is the only rule with real evidence behind it: *a measurement is
not a fact until you know what it counts.*

## First action, every session

```
node alpha.mjs          # measure, verdict, regenerate brief.md
node toolkit/selftest.mjs   # 31 assertions against the live trace
```

Start from the measurement, not from recollection or from this file.

## What alpha cannot do yet

It measures. It has no actuation path — it cannot set a budget, disable a tool, switch a
model, or refuse to spawn. It is a mirror, not a governor. Owen has not decided whether it
should be allowed to act, or on what.

## Rules

`rules.md` — 6 live, 2 retired, each with evidence and an executable `check`. The loop:

1. Run the measurement.
2. A rule in `BREACH` means change behaviour, or write down why the rule was wrong.
3. New failures become new rules: `**evidence:**` citing a measurement, `**check:**` naming a
   function in `CHECKS`, `**means:**` stating the behaviour change.
4. A rule that cannot fail is retired — two already have been. A pinned verdict is noise.
5. Every cycle appends to `memory/learnings.jsonl`. Never truncate it.

## Open questions — these need Owen, not inference

1. **What is the goal variable?** Every rule so far is derived from cost, and the model is
   free. Cost may be the wrong thing to optimise. Latency, capability, reliability and
   context length are all plausible and all unmeasured.
2. **May alpha write to ZCode's configuration, or stay read-only?** Currently read-only. A
   self-improving loop that is measured by a check it cannot pass, and can edit the thing
   doing the measuring, is a loop that will eventually cheat. There is no human in it.
3. **What should a unit of attribution be?** All findings are session-level aggregates
   (R-008). To make a per-decision claim, cost must be attributed to the turn that caused it.

## Git policy — Owen's explicit rule

Set by Owen on 2026-09-30. Remote is `https://github.com/owenservera/alpha`, **public**.

**Standing authorisation.** Committing and pushing to `main` is pre-authorised, and only for
the purpose of keeping GitHub current. Push at the end of any session that produced real work.

**Requires Owen's explicit approval before doing any of these:**

- rewriting published history — `rebase`, `reset --hard`, `commit --amend` on a pushed commit,
  `filter-branch`, or any history rewrite
- force-pushing (`--force`, `--force-with-lease`) under any circumstance
- deleting or renaming a branch or tag that exists on the remote
- changing repository settings: visibility, description, topics, default branch
- adding collaborators, or changing anything about who can see or write to this repo
- `git clean`, `git checkout .`, or discarding any uncommitted local work

**Also out of bounds without asking:** anything that widens what is published. The repo is
public and permanent. A force-push or a visibility flip is not recoverable by deleting it
later, so treat both as destructive.

Note that `raw/` (full model I/O logs, 35 MB, grows every run) is gitignored and must stay
that way unless Owen says otherwise.

## Constraints

- **Do not modify ZCode's install** (`C:\Program Files\ZCode`). Analyse its traces; build
  plugins against it.
- **Do not delete Owen's data**: `C:\0-BlackBoxProject-0\Open`, the `ZCode` clone,
  `zcode-setup`, and `~/.agents/.skill-lock.json`. Read freely, ask before moving.
- **Do not publish a number the machine did not produce.** If it is not in a tool's output,
  call it a claim.
- **Owen has final authority on scope.** On 2026-09-30 he stated that prior implementations on
  this machine were tests and that alpha is the authoritative system.