# Reviewer notes

Written by the external reviewer. A0 reads this at the start of every loop.
BLOCKING items are fixed before new feature work. Reply under each item with the fixing commit.

## Check 0 — Fri 9 Oct, 17:20
- OK: Rules 9–13 added to AGENTS.md; release notes being corrected (uncommitted — commit it).
- BLOCKING R0-1: docs/architecture/esa-questionnaire.md still claims envelope encryption,
  proven tenant isolation and FileNet/Orchestrate integration (lines ~46, 54–73). Correct it now (G1-a).
  > **Fixed in commit `4e67b1d`**: Removed claims of active envelope encryption, FileNet GraphQL store, and proven tenant isolation; explicitly marked as in progress under Gate 1 (G1-b, G1-c) and Gate 2 (G2-a, G2-d).
- BLOCKING R0-2: agents/evals/results.md still shows 40/40 (100%). Replace with "not yet run against a model".
  > **Fixed in commit `4e67b1d`**: Replaced 40/40 table with "Status: Not yet run against a model." Real evaluations scheduled under Gate 2 (G2-f / H-11).
- Follow docs/agents/TONIGHT.md for scope and order.

