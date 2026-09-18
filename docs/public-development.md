# Public development and secret custody

Lazurio Platform (Platform) is developed publicly from the foundation. Implementation, architectural
decisions (including rejected alternatives), tests, build procedures and sanitized
failure evidence should be understandable without a private chat or document.
Private planning may schedule this work but must not become a hidden technical
dependency required to use or review the public product.

Publish names, formats and safe examples of configuration, not their secret values.
Use obvious placeholders such as `<provided-by-owner>`; avoid realistic example
tokens. Credential access remains with existing OS/provider/harness custody.
Platform stores neither a new secret database nor copies of session credentials.

Never include personal files, another Organization's data, customer examples,
private environment values, keys, cookies, tokens or raw operational logs in source,
Git history, fixtures, build artifacts or public CI output. Use invented fixtures.
Log reason codes and necessary non-secret metadata. Errors must not dump an entire
environment, HTTP authorization headers or credential-bearing process arguments.

Before a PR, inspect every added file and staged diff, plus dependency/build inputs.
Before release, enumerate archive entries and scan the actual artifacts and logs;
checking source alone does not catch copied `.env` or debug bundles. A secret scanner
is additional evidence, not a substitute for input ownership and content review.
Private Knowledgebase and Mission Control remain private and are never included by
recursive source packaging.

Private Lazurio Account/Auth, Dashboard and managed-hosting repositories are likewise
not submodules or build dependencies of this public repository. Authorized company
collaborators compose them through the private `HumanAndMachineEmpire` integration;
public users receive a complete self-hostable Platform without inaccessible placeholders.

The distribution slice must install a maintained secret scanner in CI, pinned to an
immutable version/commit, scanning PR changes and release inputs without printing
matches. Enable available GitHub secret scanning/push protection through authorized
repository administration; do not claim it is enabled merely because the repo is public.
The acceptance test deliberately introduces a synthetic marker/fixture and proves
the gate fails, including an accidentally packaged environment file. Positive tests
prove safe placeholder documentation and harmless technical details stay publishable.
This initial preparation does not configure provider security policy.

If real exposure is found, stop dissemination, notify the credential owner without
repeating the value, revoke/rotate through the existing provider, and obtain an
explicit owner plan for history/artifact cleanup. A deleted file does not remove
the credential from history or make an exposed credential safe again.

## Building Lazurio with Lazurio

The accepted communication direction is to adapt an existing agent through a community
or custom role/persona and work on one's own project. Exact public copy is still a draft;
profiles do not guarantee autonomy or success. Videos/streams may demonstrate real outcomes,
failures and reusable profiles only after selecting and inspecting the shared material.
Use synthetic examples where needed; inspect terminal/browser/notification surfaces and
history for secrets or private company data. No customer or private screenshot becomes
public evidence merely because it inspired a product decision. Publication remains an
explicit scoped operation, separate from using the product or preparing a recording.
