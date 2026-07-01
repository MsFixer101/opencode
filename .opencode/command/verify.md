---
description: Run a full verification pass on this session's code changes (spawns the verifier subagent).
agent: verifier
subtask: true
---

Run a full verification pass on all code changes made in this session. Check formal correctness (types, lint, tests) AND semantic correctness (does the code do what was intended). Report with evidence: command run and output observed for every claim.

Additional scope or focus: $ARGUMENTS
