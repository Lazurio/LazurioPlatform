# Elastic License 2.0

The Principal selected **Elastic License 2.0**, SPDX `Elastic-2.0`, for newly
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
| Supplied first-party runtime and embedded templates | Elastic-2.0; retain the license and notices when copying these portions into generated outputs |
| Existing reused code/assets | Exact original license and provenance; separate permission for intended reuse |
| Binaries and dependencies | First-party parts under Elastic-2.0; bundled third-party components retain their original licenses and notices |
| User-authored data, custom profiles and projects | Running the generator does not relicense the user's content; copied supplied templates retain their own terms |
| Marketplace submissions | Authors' own licenses and submission terms; catalog membership does not relicense them |

## Provenance and audit

The current proof was newly authored in this task at the Principal's direction;
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
