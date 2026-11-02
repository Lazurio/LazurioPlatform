# Instruction qualification

The generated Folder is the context every agent in an Environment works from: `AGENTS.md`, `manual/` and the skills. These scenarios check that a fresh agent answers right and names where it found the answer. A wrong answer is a defect of the instructions, not of the agent.

`questions.yaml` holds the questions in both locales of the Folder and the key, `expected` and `source`. The key is never shown to the agent.

## When to run it

- Before a release candidate whose generated Folder text changed, which means a new `instructionTemplateRevision`.
- When an agent decided wrongly in practice. Add the question, fix the instructions, then measure again.

## How

1. **Render** the Folder from the candidate's source for each preset in both locales: `local` on macOS and on Windows, `hosted-personal`, `hosted-organization-personal`, `hosted-organization-team` and `hosted-organization-steward`. Use `renderOutputs` in `src/folder/preview.ts`, as `tests/folder-template-revision.test.ts` does for its compositions.
2. **Ask.** Start a fresh agent in each rendered Folder, read-only, without network and without other context or memory. Give it each question in the Folder's locale. Ask for the answer, the source (file and section) and how certain it is.
3. **Grade** each answer against `expected` and `source`:
   - **correct**;
   - **partial:** right, but a substantial part of the key is missing, or the source lies outside the Folder;
   - **wrong**.
4. **Record** the result with the source revision, the harness and its version, and the grades per preset and locale in `docs/qualification/`, as `agent-voice-macos-2026-10-13.json` does.

## Limits

- The questions are general: they hold for every Environment. Questions about one Organization (its modules, plans and rules) belong in that Organization's own repository.
- A rendered Folder has no Organization checkouts, so questions whose source is an Organization's `AGENTS.md` (C08, M04, M06) check only that the Folder sends the agent there.
- The scenarios test what the instructions lead to. They do not test live GitHub rights or the state of a running Environment.
