# Contributing to Lazurio

> **Draft skeleton, not in force.** This file waits for the licensor's decisions in
> [#1274](https://github.com/Lazurio/LazurioPlatform/issues/1274). Until decision 1
> (inbound rights) is taken and its text has been reviewed by a lawyer, no pull request
> from an author outside Human and Machine s.r.o. can be merged. Sections marked
> **PENDING** say which decision they wait for.

Lazurio grows from what its users and their agents run into. A clear report of a bug
or an idea helps as much as code: most changes here start as an issue.

## Report a bug or an idea

Open an issue with the **Bug** or **Improvement** template. The templates are a hint,
not a form. A good report lets someone fix the problem without asking you back: what
happened and what should have, where (Lazurio version, Folder template revision, kind
of Environment), how to reproduce it, and a proposed fix when you have one. Say what
you did not verify. Examples that were fixed without a single question: #1223, #1030,
#1065.

An installation or update problem has its own template.

## Propose a change as a pull request

**PENDING decision 2** (contribution fork, review of community pull requests).

1. Read `AGENTS.md`, `ARCHITECTURE.md` and the decisions your change touches. Lazurio
   keeps its model in `docs/decisions.md`; a change that needs a new decision says so
   in its pull request instead of deciding it in code.
2. Without write access to this repository, fork it to your own GitHub account and
   open the pull request from a branch of your fork. *(Pending: the contribution fork
   is an explicit exception for this public product repository; agents in Lazurio
   still never fork an Organization's repository around a missing right.)*
3. One problem per pull request. Fill in the pull request template; describe what you
   actually ran.
4. Run the checks locally: `bun install --frozen-lockfile`, then `bun run check`.
   Changes to generated Folder text move `instructionTemplateRevision` and repin its
   digest (`tests/folder-template-revision.test.ts`).
5. First-time contributors' workflow runs wait for a maintainer's approval
   *(pending: repository setting, to be confirmed by an admin)*.

## Review

**PENDING decision 2.** Today `CODEOWNERS` requires an exact-head review from one
account for everything. Open: who reviews community pull requests, and whether we
promise a first response within a set time.

## Contributor License Agreement

**PENDING decision 1.** Lazurio is offered under Elastic-2.0, one directory under MIT,
and Human and Machine s.r.o. also grants separately negotiated commercial licenses
(`docs/licensing.md`). A contribution therefore needs to come with a right for the
licensor to sublicense it, not only to redistribute it under the public license.

The recommended option in #1274 is a CLA (individual and corporate) signed once,
through a comment on the first pull request. The text is not written here: it is a
legal document and needs a lawyer's review before it goes live. Until then:

- no outside contribution is merged;
- an agent never signs for a person; it explains the CLA in one sentence and leaves
  signing to them.

## Keep it public-safe

This repository is public. Never name a customer Organization, its modules,
Environments or people, and include no secrets, tokens, customer data, private logs
or internal host names, in code, commits, issues, pull requests or comments.
`docs/public-development.md` has the details. A problem of one Organization belongs
in that Organization's own repository.
