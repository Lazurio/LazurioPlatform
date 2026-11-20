# Ring 0 and the smoke test of v0.1.24-rc.6, 2026-11-20

`v0.1.24-rc.6` (`af650b19`) is the candidate for the final `v0.1.24`. It carries LZD-0041 phase A (#1114): a stale
projection digest no longer decides whether an Organization root runs. The digest is reported, and a root runs whether
or not it declares the digest or keeps `company.gen3.json`. It also carries Brain R11a for Buddy GEN4 (#1085, #1103 to
#1110, #1119, #1120 by #1122, #1124), the Buddy GEN4 sign and skills (#1100, #1102, #1106, #1116 to #1118), and the
canary record of 0.1.23 (#1107). Those are 14 commits since `v0.1.23-rc.4`. The canary stage ran on 2026-11-20 from
06:31:58Z to 07:00:20Z and is green.

The record is [`qualification/canary/v0.1.24-rc.6.json`](../../qualification/canary/v0.1.24-rc.6.json), added by the
same pull request as this file. Machines are opaque ids under the key of the earlier records, kept only at the station,
so every Machine keeps the id it had there.

**This record is not a release.** The final `v0.1.24` is tagged only on the release owner's approval in the `release`
environment. Its tree is `af650b19`'s outside `qualification/` and `docs/evidence/`, on a release commit whose parent is
this record's merge, as for `v0.1.20` to `v0.1.23`.

## The candidate

- Tag `v0.1.24-rc.6` at `af650b1962c9e5a4d6930d4015a5e2d875da0cfd`, release run 44680227406 (success),
  prerelease published 2026-11-20T05:39:22Z.
- linux-x64: sha256 `d6e18cbb…`, 102 753 760 B. `lazurio.sigstore.json`: sha256 `9ebe1ea1…`, 11 933 B. Both were checked
  on the downloaded files, and `gh attestation verify --bundle … --source-digest af650b19 --signer-workflow
  …/release.yml` accepts the binary.
- Qualification `qualify.yml` run 44682475619 on `af650b19`: success.

## Scope and how each Machine got the candidate

- **The four Environments of the pilot Organization** on its tailnet host (the Owner's and the member's Work
  Environments, the Team Environment and the Prostředí služeb) got it from LazurioExampleOrganization/infra#355. The
  pull request was merged at 06:00:23Z after an independent review on the exact head and a fresh CI Plan (`59bc07fb…`,
  34 actions, 0 deletions, Machines v0.12.258). Its push run applied it, ending at **06:31:58Z**. That was the last time
  a Machine in scope got the candidate, and it is the start of the stage. The lane had carried `rc.3` (#349) and `rc.5`
  (#353) before.
- **One personal VM**, the Owner test account's Personal Environment, got it from its own lane on the operator path
  (LazurioExampleOrganization/infra#354, Buddy GEN4). The pull request was merged at 05:46Z and applied under the station
  lock, which was free again before 06:00Z. Brain R11a was accepted there by the Buddy GEN4 coordinator, whose
  acceptance decides that the final is made from this candidate.
- **Not in this record:** the release owner's own Personal Environment.

## The stage

By one thread, read-only except the smoke tests. The personas were taken one after the other, because the Buddy GEN4
coordinator held the Owner persona from 06:48Z to 06:54Z.

1. **The member's part, 06:48:39–06:50:55Z.**
   - R1 of the member's two Environments: `/api/recovery`, the use case of `lazurio recover --json`, and
     `/api/update/status`, each through its own Launchpad.
   - The standard suite as the member: 10 of 10 required steps passed. The one INCONCLUSIVE is the member's refusal at
     the Owner's Personal Environment, which the member's tailnet client cannot reach.
   - The main path as the member: 9 of 9 required steps passed.
2. **The Owner's part, 06:55:00–07:00:20Z.**
   - R1 of the Owner's three Environments.
   - The standard suite as the Owner: 7 of 7 required steps passed.
   - The main path as the Owner: 10 of 10 required steps passed.
   - Apps on every Environment each account lists.
   - R2 of all five Environments.
   - Recovery issues: none open with the label `recovery` (07:00Z).
3. **End:** `2026-11-20T07:00:20Z`, the green light.

**Not quiet:** the Buddy GEN4 coordinator accepted Brain on the Owner's Personal Environment from 06:48Z to 06:54Z, inside
the window. That covered sign-in as the Owner, Apps → Integrations, a question to the agent, and one test page written
to and read from Brain through Executor. The Launchpad, T3 Code and the gateway were not restarted, and R1 and R2 read
that Machine healthy on the candidate afterwards. The pilot Organization's Deployment Repo ran no workflow inside the
window.

### Per Machine

At both edges `recover` answered `healthy` with all five checks `ok`, `update status` answered running and active
`0.1.24-rc.6`, and the Launchpad unit's `NRestarts` was 0. The `recover` check `launchpad-health` is the Launchpad's own
`GET /health` (`src/recover/observe.ts`). It passes only when `/health` answers in normal mode with the active version,
so the `/health` column shows that answer at each edge. T3 Code is not part of this candidate; its version is recorded
only so that a change can be told apart.

| Machine | Kind | R1 | R2 | `recover` R1 / R2 | `active` R1 / R2 | `/health` R1 / R2 | Modules started and opened | T3 Code |
|---|---|---|---|---|---|---|---|---|
| `4cb47f16810a7edb` | work (Owner) | 06:55:27Z | 06:59:29Z | healthy / healthy | 0.1.24-rc.6 / 0.1.24-rc.6 | normal, 0.1.24-rc.6 / normal, 0.1.24-rc.6 | Knowledgebase 06:56:45Z and Design system 06:56:51Z, each started from its tile and opened on its own origin with HTTP 200 and its heading; the chat answered | 0.1.10-lazurio.3 |
| `7d3f2189170e39ea` | work (services) | 06:55:32Z | 06:59:34Z | healthy / healthy | 0.1.24-rc.6 / 0.1.24-rc.6 | normal, 0.1.24-rc.6 / normal, 0.1.24-rc.6 | none to start: its one tile is the Organization's AI pool service, a service page and not a module | 0.1.2-lazurio.6 |
| `9289bc065828421b` | work (team) | 06:49:02Z | 07:00:06Z | healthy / healthy | 0.1.24-rc.6 / 0.1.24-rc.6 | normal, 0.1.24-rc.6 / normal, 0.1.24-rc.6 | none to start: Apps shows 0 module tiles | 0.1.2-lazurio.6 |
| `c04fe553256c9e52` | work (member) | 06:49:07Z | 07:00:11Z | healthy / healthy | 0.1.24-rc.6 / 0.1.24-rc.6 | normal, 0.1.24-rc.6 / normal, 0.1.24-rc.6 | Knowledgebase 06:50:26Z, started from its tile and opened on its own origin with HTTP 200 and its heading; the chat answered | 0.1.9-lazurio.2 |
| `bce5a5489ecd7010` | personal (Owner) | 06:55:22Z | 06:59:24Z | healthy / healthy | 0.1.24-rc.6 / 0.1.24-rc.6 | normal, 0.1.24-rc.6 / normal, 0.1.24-rc.6 | none to start: Apps shows 0 module tiles | 0.1.10-lazurio.3 |

The Team Environment is listed as `work`, because the record's kinds are `work` and `personal`.

## Phase A of LZD-0041, accepted on this ring

Phase A was accepted as the Owner test account on `v0.1.24-rc.3` (02:46–02:48Z, Lazurio/LazurioPlatform#1094). `rc.6`
carries the same code (#1114 is unchanged since).

- The Owner's Organization root was moved locally to the fixture of #1094 (LazurioExampleOrganization_GEN3 `614a415`:
  the same sentence edited in both documents, the digest not recomputed). Lazurio 0.1.23 reads that root as `conflict`.
- On the candidate it ran: `transition` with the issue `canonical_projection_hash_invalid`.
- Apps showed its 12 modules with no conflict line, Knowledgebase started, and Začínáme kept its step done.
- The routine `lazurio update` fast-forwarded the root back to `main`.

## Not verified

- Safari, Firefox and a phone.
- The candidate's other changes beyond the main path and the acceptances named above. The Buddy GEN4 sign is known and
  does not block the final, according to its coordinator.
