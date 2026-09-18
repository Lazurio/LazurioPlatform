# Profile evidence and optional measurement

Status: accepted requirement to design voluntary minimal measurement from the start;
proposed contract, no collector/backend or recommendation engine implemented. Its
consumer is a person comparing profiles for a particular task, model, harness and
amount of human oversight. There is no universal best agent score.

## Separate sources of evidence

Controlled benchmarks use repeatable task fixtures, a declared rubric, pinned profile,
model and harness versions, tool availability and human-oversight policy. Repeat runs,
report failures and compare against a simple baseline. A senior marketing specialist
profile must demonstrate domain outcomes; its name or popularity is not competence.

Optional field experience reflects self-selected tasks and users. Keep it visibly
separate from benchmark results and qualitative community reports. Display eligible
runs, observed samples, missing values, version/date range, uncertainty and likely
selection bias. Correlation cannot establish that the profile caused an improvement.
Do not rank sparse subgroups, mix incompatible versions or hide human corrections.
Manipulated submissions, duplicate reports and paid promotion need review; avoid
solving abuse by adding a persistent identity/fingerprint to supposedly anonymous data.
Until credible moderation and aggregation exist, present curated examples rather than
an authoritative ranking. Commercial recommendation interests must be disclosed.

## Proposed minimal field record

| Dimension | Minimized representation / boundary |
| --- | --- |
| Profile | Public profile version; custom variant marked separately, never custom text or a hash of private instructions |
| Model | Provider/model and known version; unknown version explicitly unknown |
| Harness | Codex or Claude Code and known version/capability class |
| Task | Coarse user-visible category/persona, not task title, client or Organization |
| Result | Declared completion/failure and rubric provenance, not generated content |
| Human intervention | Coarse count/category; no transcript or reviewer identity |
| Duration | Coarsened elapsed-time bucket; no exact behavioral timeline |
| Usage/cost | Available measured values and currency/basis, coarsened where necessary; missing is null/unavailable, never zero |

Exact custom revision can be pinned locally for a reproducible local comparison.
Public export identifies only an explicitly shared public variant revision or a coarse
custom category. Do not export local revision IDs or stable hashes that fingerprint
private text. Model/harness versions may also need coarsening or suppression in rare
combinations; document the lost analytical precision rather than claiming both perfect
anonymity and exact attribution. No conversation, prompt, code, instructions, paths,
Organization names, private context, credentials or secrets belong in a field record.

## Consent and privacy before collection

Default is off. Separate local benchmark operation from consent to send field data.
The Machine-local settings owner presents the exact schema, destination, purpose,
retention and available deletion controls before opt-in; a user can inspect a payload,
turn it off and discard queued unsent records. Consent is versioned and revocable;
profile import and product upgrade cannot enable it. A changed collection purpose or
payload requires renewed consent. No continuous profile text upload is implied.

Removing a name is not anonymity. Before any transmission, assess linkage across
profile/model/time/cost, rare task combinations, custom variants, IP addresses,
transport/CDN/access logs, stable identifiers and small aggregate cells. Avoid account,
installation and device identifiers. Coarsen/batch records, suppress small cells and
bound raw and aggregate retention with explicit deletion jobs. Exact retention period,
minimum cell size, transport/log configuration and processor jurisdiction must be
selected and tested before collection is enabled. Do not promise anonymous collection
until the complete transport and aggregation path supports that claim. A local-only
preview is the baseline while those controls remain unresolved.

Anonymous aggregates may not support locating an individual's already merged record;
explain this limitation before consent rather than pretending account-based erasure.
Diagnostic failure evidence is a separate private store, never automatic telemetry.
Export/share must not reuse its raw logs. No new costly telemetry backend is justified
by this draft: first test payload minimization and consent with local synthetic data,
then assess existing standard aggregation capabilities against the real consumer.

## Acceptance and owner

The product/profile owner defines the rubric and local settings; the collection
operator owns lawful handling, retention and transport configuration; neither is an
Organization access authority. Tests prove default-off/no network, consent revoke
and queue purge, missing cost remains unknown, private custom text/hash exclusion,
rare-cell suppression, log/IP disposition and no rank from insufficient samples.
A benchmark rerun and a voluntary field record must remain distinguishable in the
comparison UI. No production collection or backend rollout follows from this document.

## Product, community and commercial visibility from first public version

Accepted requirement: product owners can assess real use, community participation and
business outcomes from the first public product version. Keep three analytical purposes
separate: product/community adoption, identified commercial records, and profile/model
benchmarking. They must not become one user fingerprint or a causal leaderboard.

Proposed baseline is an existing analytics capability plus an existing CRM, with each
source retaining ownership. No vendor is selected. Compare reuse against a manual,
source-linked report before building any new data platform. Product signals should cover
first completed work, returning use and subsequent completed work; community signals cover
shared/adapted profiles and meaningful feedback, not just reach/downloads. Commercial
records describe explicit leads, implementations and realized revenue using their owning
CRM/financial sources. Definitions, denominator, observation window, freshness, missingness
and consent coverage accompany every metric; self-selected samples do not represent all
users. Never infer lifetime customer value or conversion from anonymous totals.

Local measurement remains voluntary, minimal, default-off and content-free under the
consent rules above. Do not automatically join anonymous/pseudonymous use to a customer,
email, provider identity or CRM record. Any proposed identified measurement has a separate
purpose, explicit informed consent and access/retention review before implementation;
first-version visibility does not depend on that join. Customer financial/business data
stays in the owning private Organization. No collection or vendor integration is authorized
here. The first analyst pilot consumes permitted sources and clearly reports unavailable
data; a reporting requirement must never be met with fabricated counts or unsafe collection.
