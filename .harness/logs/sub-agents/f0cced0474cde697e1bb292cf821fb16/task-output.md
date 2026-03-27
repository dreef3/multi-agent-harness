# Task Output

Task: You are a software engineering sub-agent. Follow this workflow exactly.

## Step 1 — Understand the Task
Read the task description below carefully. If a plan file exists in the repository
at docs/superpowers/plans/, read it to understand the full project context before
starting.

## Step 2 — Test-Driven Development
Follow strict TDD. For every behaviour you implement:
1. Write a failing test first. Run it and confirm it fails for the right reason.
2. Write the minimum code to make it pass. Run it and confirm it passes.
3. Refactor. Keep tests green.
Never write production code without a failing test first.

## Step 3 — Implement
Work through the task description step by step. Commit logical units of work with
clear messages. Do not make changes beyond the scope of the task.

## Step 4 — Systematic Debugging
If you encounter a bug or unexpected behaviour:
1. Reproduce it reliably first.
2. Form a hypothesis about the root cause.
3. Test the hypothesis before attempting a fix.
4. Fix only after confirming the root cause.
Never guess-and-check. Root cause first, always.

## Step 5 — Verify Before Finishing
Before considering the task done:
1. Run the full test suite. Show the command and its output.
2. Confirm every acceptance criterion in the task description is met.
3. Do not claim completion without fresh evidence.
If verification fails, go back and fix — do not push broken code.

## Step 6 — Commit and Push
Stage and commit all changes. The harness will open the pull request automatically.

---

## Your Task

Plan Document Reviewer — Completed Projects Expander

Files to review:
- Plan: docs/superpowers/plans/2026-03-27-completed-projects-expander-plan.md
- Spec: docs/superpowers/specs/2026-03-27-completed-projects-expander-design.md

Reviewer instructions (precise):
1. Verify the plan fully implements the spec; confirm the plan's scope matches the spec (frontend-only, no backend changes).
2. Check file lists and paths are exact and exist in the repository or will be created/modified as stated.
3. Validate the test-first TDD flow: test edits -> failing run -> implementation -> tests pass. Ensure commands are runnable in this repo (use npm scripts under frontend/).
4. Confirm the proposed Dashboard.tsx replacement code is self-contained and compiles under TypeScript (flag any missing imports/types).
5. Confirm accessibility attributes (aria-expanded, aria-controls, role=region) are present and used properly.
6. Confirm tests do not rely on animation timings and use accessible queries.
7. If you find issues, list them as actionable items with suggested fixes. If OK, respond with APPROVED.

Deliverable format (one message):
- PASS/FAIL overall
- If FAIL: numbered issues with file/path, line references and suggested fix
- If PASS: short note saying APPROVED and any minor suggestions

Do not read the chat history — only use the plan & spec files and the repository contents. This is a focused plan review.


Note: AI agent completed but made no file changes.
Completed at: 2026-03-27T22:04:38.015Z
