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

You are already checked out on the correct feature branch. Do NOT run `git checkout -b`
or create a new branch. Stage and commit all changes with clear commit messages. The
harness opens the pull request automatically — do NOT run `gh pr create`.

---

## Your Task

Task: Fix Chat header / back link text to use compact "← Projects" (chevron + word) instead of "Back to projects"

Context:
- User and reviewers agreed the back-navigation label should be compact: a chevron icon followed by the singular word "Projects" (rendered visually like "← Projects").
- An implementation PR currently uses the text "Back to projects". We must change the UI and tests to match the agreed design.
- Repositories: multi-agent-harness (origin). The original feature branches/PRs are the Chat back-navigation and NewProject history replace implementations; this task should modify the relevant branch or create a new branch and PR if updating the original branches is not permitted.

Goal:
- Replace instances of "Back to projects" with the compact chevron + "Projects" UI (visually "← Projects"). Ensure accessibility (screen-reader-friendly label), preserve existing navigation behavior, and update tests/snapshots.

Acceptance criteria / deliverables:
1. Identify all locations where back-navigation text is rendered (Chat header, NewProject page, and any related components or shared link component). Include file paths and PR/branch names in the report.
2. Implement the UI change so the visible text is compact: show the chevron icon followed by the word "Projects" (no extra words like "Back to"). Prefer re-using the existing chevron/back-icon component used elsewhere in the app; if none exists, use the established icon component library.
3. Keep or add an accessible label for screen readers that preserves the original meaning, e.g., aria-label="Back to projects" while visually showing "← Projects". If the project uses an i18n system, update keys accordingly and preserve translations.
4. Update unit/component tests and snapshots that assert on the visible text. Ensure tests assert on the visible content ("Projects" preceded by icon) and on accessible label where appropriate.
5. Run linters and unit tests locally (or via CI) and make any small fixes needed for formatting or failing tests. Document test results.
6. Push changes to a branch named fix/chat-backlink-compact-label (or update the existing feature branch if instructed). Open a PR titled: "UI: Use compact '← Projects' back link in Chat and NewProject" and reference the original implementation PR(s) that introduced the previous text.
7. In the PR description, include screenshots or short notes describing the visual change, list of updated files, and mention accessibility aria-label decision.
8. Provide the PR URL and branch name in the task result.

Technical guidance for implementer:
- Search the codebase for occurrences of the string "Back to projects" and the components rendering header/back links.
- Prefer modifying the shared back-button component if multiple pages reuse it.
- Use an aria-label to keep the semantic text for screen readers, e.g., <button aria-label="Back to projects"> <ChevronLeftIcon/> <span>Projects</span> </button>
- Update tests that match exact strings or snapshots. If snapshots are used, update them or modify tests to be less brittle by checking for the presence of the icon and the word "Projects".
- Run yarn/npm test and lint commands consistent with repository conventions and fix issues.
- Push changes and open a PR; mark it ready for review.

If blocked (protected branches, missing permissions, failing CI):
- Document the blocking error and include a suggested fix (e.g., update snapshot, fix i18n keys, request permission to push). If updating the original feature branch is not allowed, create an integration branch and PR.

Report format (in task result):
- Files modified and why
- Branch name and PR URL
- Test/CI summary
- Any accessibility considerations
- Recommended follow-ups (if any)

This task should be idempotent and focused: do not change navigation behavior, only the visible label and associated tests/accessibility text.


Note: AI agent completed but made no file changes.
Completed at: 2026-03-27T23:06:18.274Z
