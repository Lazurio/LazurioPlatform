# Community contributions: the pull request route (proposal)

> **Proposal, not in force.** Waiting for the licensor's decisions in
> [#1274](https://github.com/Lazurio/LazurioPlatform/issues/1274). Nothing here changes
> generated Folder text yet; when the decisions are taken, the agreed parts move into
> the manual and a Folder skill in one pull request with a new
> `instructionTemplateRevision`.

The issue route (an agent offers once to file the user's bug or idea and writes a
report that can be fixed without asking back) is in the generated manual since
`base-instructions-156` (#1275) and does not depend on anything below.

## Decisions still missing

| # | Decision | Owner | Blocks |
| --- | --- | --- | --- |
| 1 | Inbound rights: CLA (individual + corporate), DCO, or DCO with terms in `CONTRIBUTING.md`; the final text reviewed by a lawyer; what happens with commits already on `main` from authors outside Human and Machine | licensor | merging any outside PR, the CLA tooling, the CLA section of `CONTRIBUTING.md` |
| 2a | Whether a contribution fork of this public repository is allowed as an explicit exception to the manual's fork rule, and in whose account it lives | licensor | the agent's pull request route, step 2 of `CONTRIBUTING.md` |
| 2b | Who reviews community pull requests (today `CODEOWNERS` names one account for everything) and whether a first response time is promised | licensor | the Review section of `CONTRIBUTING.md` |
| 3 | Labels `community` and `good first issue` (the latter exists), approval of workflow runs for first-time contributors | repository admin | measuring, CI safety for forks (CI is already read-only for `pull_request`) |

## Proposed agent behaviour once decided

Written as the manual text would read; the short form goes into `AGENTS.md`, the
procedure into a Folder skill (working name `lazurio-contribution`). A new skill is a
new Folder output and needs the next manifest schema, as `admin-request` did in
schema 6.

1. **The owner first.** The table *Who is responsible for what* in `manual/lazurio.md`
   decides whether it is Lazurio's matter. Organization and module problems keep going
   to their own repositories.
2. **One offer, three choices, after the task.** "File it as an issue", "Prepare a fix
   as a pull request", "Nothing". No repeat after a no; an own instruction turns the
   offers off.
3. **The fix.** In a clone of `Lazurio/LazurioPlatform` outside the Folder, in a
   worktree, following this repository's `AGENTS.md` and pull request template.
4. **The fork (2a).** Without write access, the agent forks this repository to the
   person's own GitHub account and pushes the branch there. This is the only fork
   allowed around a missing right; Organization repositories never.
5. **Before the first push** the agent shows the person what becomes public under
   their name: the diff, the title and the description, with nothing about their
   Organization. Opening the pull request is a Publication in a public repository and
   needs the person's explicit yes.
6. **CLA (1).** On the first pull request the agent explains the CLA in one sentence
   and leaves signing to the person. It never signs for them.

## Tooling options for decision 1

- CLA Assistant (hosted GitHub App): signatures outside the repository; needs the App
  installed by an Organization owner.
- `contributor-assistant/github-action`: signatures in this repository; runs on
  `pull_request_target`, so the workflow must never check out the pull request's code.
  Added through normal review here, after the text exists.
