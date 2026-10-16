# Elastic License 2.0

Matěj selected **Elastic License 2.0**, SPDX `Elastic-2.0`, for newly
owned Platform code, documentation, supplied first-party runtime and embedded
first-party templates on 2026-09-08. The [LICENSE](../LICENSE) is the unmodified
[official Elastic text](https://github.com/elastic/elasticsearch/blob/a92a647b9f17d1bddf5c707490a19482c273eda3/licenses/ELASTIC-LICENSE-2.0.txt).
Its SHA-256 is `48255018b41fc0e965b1115af7e6779bc218bb8a6747d561da800d5022622aa2`.
The licensor and copyright notice name the registered company Human and Machine s.r.o.

This is source-available software, not OSI open source. There is no automatic
two-year transition to Apache. Personal and internal company use, including a
rented server or internal cloud deployment, is allowed subject to the license.
An external implementer may configure Lazurio for a customer's own internal use;
that alone is not the customer-facing managed service reserved here, provided the
implementer does not operate a service exposing Lazurio functionality to third parties.
The restriction concerns offering a hosted or managed service to third parties
that exposes a substantial set of the software's features or functionality; it
applies even when the service is free. Such use needs a separate agreement from
the licensor. It is not a prohibition on every kind of hosting. License-key and
notice protections also apply; the standard text controls over this summary.
See the [official FAQ](https://www.elastic.co/licensing/elastic-license/faq).

Human and Machine s.r.o. may separately contract approved partners to provide managed
Lazurio services. That permission comes from an individually agreed commercial license;
it is not granted by repository access, contribution, Organization membership or the
public ELv2 terms. Exact commercial terms are intentionally not defined here.

Private Lazurio Account/Auth, Lazurio Dashboard and managed-hosting components composed
through `HumanAndMachineEmpire` remain under their own proprietary terms. They are
optional company services, not required dependencies of a self-hosted Lazurio Environment.

| Material | License boundary |
| --- | --- |
| Newly owned Platform code and documentation | Elastic-2.0 and the accompanying copyright notice |
| The Environment browser's contract: `src/browser/contract/`, the shell artifact's `browserContract` files and the functions T3 Code's overlay copied from `holds.ts` at 49d54c9 | MIT, the module's own licence file ([below](#the-environment-browsers-contract-mit)) |
| Supplied first-party runtime and embedded templates | Elastic-2.0; retain the license and notices when copying these portions into generated outputs |
| Existing reused code/assets | Exact original license and provenance; separate permission for intended reuse |
| Binaries and dependencies | First-party parts under Elastic-2.0; bundled third-party components retain their original licenses and notices |
| User-authored data, custom profiles and projects | Running the generator does not relicense the user's content; copied supplied templates retain their own terms |
| Marketplace submissions | Authors' own licenses and submission terms; catalog membership does not relicense them |

## The Environment browser's contract: MIT

Decision F50 point 6 (2026-10-12) licenses the Environment browser's contract
under the MIT License. The forks that take it, T3 Code under MIT and Lazurio
MausBot and agent-browser under Apache-2.0, can then vendor it without becoming
mixed-licence, and it can go upstream with them. Its terms are the module's own
[LICENSE](../src/browser/contract/LICENSE), which names the licensor of
[NOTICE](../NOTICE). The exception covers exactly three parts:

1. The directory `src/browser/contract/`: the contract module, its pure and
   Node parts, and its executable vectors with their README. It holds nothing
   from outside it; a later import from elsewhere into the module needs the
   exception widened by a decision, or the code moved in.
2. The files a release's shell artifact lists under `browserContract` in its
   `artifact.json`: below `browser-contract/`, the module's two parts as ES
   modules with their declarations, its vectors with their README, and its
   licence file. The archive's root `LICENSE` is the Elastic text for its
   other files, and its `NOTICE`, which a fork keeps beside the vendored files,
   names this exception (F50 point 5's addendum of 2026-10-14).
3. By the grant recorded in decision F50 point 6 (2026-10-12), the functions
   the T3 Code fork's overlay copied from `src/browser/people/holds.ts` at
   49d54c9 into `apps/server/src/lazurio/holders.ts`, as that file's header
   lists them: `BootTime`, `readBootClock`, `parseBootTime`, `RecordedTab`,
   `LiveTabs`, `parseLiveTabs`, `keptTabs`, `isStrip`, `holderDirectory`,
   `liveTabsPath`, `parseHolder`, `holderFileText`, `parseHolderRecords`,
   `replaceOwnerFile`, `processAlive` and `watchHolds` (there
   `watchDirectories`). They are the contract's code in an earlier place.

Everything else stays Elastic-2.0, the repository's root LICENSE included, and
so does every other Platform file an artifact ships. Platform code that
imports the module carries the parts it uses into the files built from it,
and those parts stay under the module's MIT terms and notice (its LICENSE, of
the same licensor) inside files that are otherwise Elastic-2.0:

- the shell artifact's `shell.js`: the target-id check, the strip grammar, the
  view-address and view-path rules, and the Environment id (`environmentIdOf`,
  `isEnvironmentId`);
- the shell artifact's `contract.js`: `environmentIdOf` and `isEnvironmentId`,
  which the shell's documents read;
- the view page's script, which the view serves at `/assets/view.js`: the
  target-id check, the view-path rule and the writers of the view's paths and
  addresses, and the Environment id;
- the Launchpad's own pages, which its executable serves: the rules Nová
  karta and the browser panel read.

A fork takes the contract from the module's own files, the shell artifact's
`browser-contract/`, not from these.

## Provenance and audit

The current proof was newly authored in this task at Matěj's direction;
no legacy implementation was imported. The organization legal-identity record
verifies the exact company name used in NOTICE. This is a scoped first-party
grant, not an assertion of ownership over other contributors' or users' work.
Before accepting outside contributions or importing existing material, establish
its authorship, inbound rights and notices explicitly. Company registration alone does
not establish ownership of pre-existing or third-party contributions; the contribution
process must preserve the licensor's rights to offer separately contracted licenses.

The legacy CLI manifest declares `FSL-1.1-ALv2`. This change does not relicense
that source. Dependencies remain pinned; product distribution must inventory
actual bundled components and ship their required notices. No product binary is
released by this preparation.

Before this decision, the public bootstrap and foundation commits had no LICENSE
or Apache grant. No Apache or FSL grant was introduced during the discussion;
history is retained. This decision supersedes the open choice in the initial
foundation draft, not any third-party rights. GitHub's automatic license label
is not a guarantee or an authority for the terms.

## Bundled third-party assets

| Asset | Where | License |
| --- | --- | --- |
| Brand icons of the Integrace catalog: the SVG path and colour of an app's icon | `src/integrations/catalog.json` (`icon.source` names `simple-icons@<version>/<slug>`) | [simple-icons](https://github.com/simple-icons/simple-icons), CC0-1.0; an icon simple-icons marks with a license of its own is never bundled |
| Claude's mark on Začínáme's "Přihlásit Claude": the SVG path only, filled in the button's colour | `src/launchpad/index.html` (the sprite's `i-claude`, its source named beside it) | simple-icons@16.35.0 `claude`, CC0-1.0 |

ChatGPT has no mark in this repository: simple-icons removed OpenAI in 16.0.0
(simple-icons#13944), because OpenAI's brand terms grant a permission that is not
transferable. "Přihlásit ChatGPT" shows its first letter instead, as Integrace does for
a brand simple-icons does not carry; bundling OpenAI's own mark would be a decision of
its own.

Brand names and logos remain the trademarks of their owners; the Launchpad shows
them only to identify the app an Integrace connects (decision F42,
[integrations](integrations.md#icons)).
