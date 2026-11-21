# Ring 0 and the smoke test of v0.1.24-rc.10, 2026-11-21

`v0.1.24-rc.10` (`4b42340a`) is the candidate for the final `v0.1.24`. The Buddy GEN4 coordinator decided on 2026-11-21
at 10:41Z that the final is made from it, not from `rc.6`. Since `rc.6` it carries the canary record of `rc.6` (#1125),
the Buddy frame's `lazurio.buddy.shown` (#1123), Brain R11a for Buddy GEN4 (#1131, #1132, #1133, #1134), the Module
Standard (#1127, #1130), Buddy GEN4 on a fresh Environment (#1138) and the Folder manual rule (#1140): 10 commits. LZD-0041
phase A (#1114) is unchanged since `rc.3`. The canary stage ran on 2026-11-21 from 15:08:59Z to 15:17:29Z in one complete
pass, including the real work on a Machine (`docs/recovery-mode.md` G.3). It is green.

The record is [`qualification/canary/v0.1.24-rc.10.json`](../../qualification/canary/v0.1.24-rc.10.json), added by the
same pull request as this section. Machines are opaque ids under the key of the earlier records, kept only at the
station, so every Machine keeps the id it had there.

**This record is not a release.** The final `v0.1.24` is tagged only on the release owner's approval in the `release`
environment. Its tree is `4b42340a`'s outside `qualification/` and `docs/evidence/`, on a release commit whose parent is
this record's merge, as for `v0.1.20` to `v0.1.23`.

## The candidate

- Tag `v0.1.24-rc.10` at `4b42340a72078150340eb9d08e1f8ef325ffee6d`, release run 44895538960 (success),
  prerelease published 2026-11-21T10:53:17Z.
- linux-x64: sha256 `e7cf3f61…`, 102 782 432 B. `lazurio.sigstore.json`: sha256 `ca031167…`, 11 624 B. Both were checked
  on the downloaded files, and `gh attestation verify` accepts the binary (`release.yml@refs/tags/v0.1.24-rc.10`).
- Qualification `qualify.yml` run 44896454281 on `4b42340a`: success.

## Scope and how each Machine got the candidate

- **The four Environments of the pilot Organization** on its tailnet host (the Owner's and the member's Work
  Environments, the Team Environment and the Prostředí služeb) got it from LazurioExampleOrganization/infra#377. The
  pull request was merged at 14:31:25Z after an independent review on the exact head and a fresh CI Plan (`cb1cb5b0…`,
  34 actions, 0 deletions, Machines v0.12.260), and after the hosts' other lanes of the day (#376, #380, #381, #382,
  #379) in the order agreed between their threads. Its push run applied it, `success`, `healthy` and `conformant`,
  ending at **15:08:59Z**. That was the last time a Machine in scope got the candidate, and it is the start of the stage.
- **One personal VM**, the Owner test account's Personal Environment, got it from its own lane
  (LazurioExampleOrganization/infra#379), applied 13:44:22–13:53:25Z. The Buddy GEN4 coordinator accepted `rc.10` there,
  also as the persona (14:31–14:32Z).
- **Not in this record:** the release owner's own Personal Environment, and the member test account's fresh Personal
  Environment, which the station's member proxy does not reach (every step on it was INCONCLUSIVE, never FAIL).

## The stage

By one thread, read-only except the smoke tests and the real work on a Machine. Both personas were free at the start
(the coordinator's pass ended at 14:32Z) and were held by this thread from 15:11Z to its end.

1. **R1, 15:11:20–15:12:01Z.** Every Machine through its own Launchpad, as the test accounts: `/api/recovery`, which is
   the use case of `lazurio recover --json`, and `/api/update/status`.
2. **Real work on the Owner's Work Environment, 15:12:07–15:12:17Z,** a Machine this lane updated, over its operator
   SSH entry:
   - `lazurio --version`: `0.1.24-rc.10`, commit `4b42340a`;
   - `lazurio doctor`: verdict `broken` because one required tool is missing on this test account (`tool`: `fail`,
     `required-missing`). Besides that, two recommended tools are missing, six modules have no app (`module`: `warn`,
     `no-app`), the Codex app-server is outdated and the chat defaults are unavailable, all `warn`;
   - `lazurio machine folder-refresh`: `unchanged`;
   - a restart of the Launchpad unit at 15:12:08Z: active again with `NRestarts` 0;
   - `lazurio recover --json`: healthy, all five checks `ok`;
   - no failed unit; T3 Code stayed active.
3. **The smoke tests,** each persona in a fresh headless profile of its own:
   - `suite both`: 17 of 17 required steps passed. 7 optional passed and 2 were INCONCLUSIVE, both because the member's
     proxy does not reach a Personal Environment;
   - the main path as the Owner and the member: 19 of 19 required passed, the Marketplace included. Of the optional
     steps 12 passed, 1 was INCONCLUSIVE (the same unreachable Personal Environment) and 1 failed: Připojení on the
     Owner test account's Personal Environment. Its API answered `no-remote-control` and the page offered "Restart
     Codex", because the Codex app-server daemon was not running there (`lazurio doctor`: `codex-app-server` `warn`,
     `daemon-state-unknown`). That is the designed answer to that state (`src/connections/pairing.ts`,
     `src/launchpad/connections-view.ts`). Neither file nor the rest of `src/connections` changed between `rc.6`,
     where the same step read `ready`, and `rc.10`. The thread did not restart Codex on that Environment.
     **Cause, not in the candidate:** the Buddy GEN4 coordinator had stopped the `codex` processes on that Environment
     repeatedly during the morning's failure-state test (09:16Z) and so also the app-server daemon. The coordinator
     restarted `lazurio-codex-app-server.service` over the operator path at 15:29Z; `lazurio doctor` then reported
     `codex-app-server` only as `warn` `app-server-outdated` (app-server 0.171.0, CLI 0.169.0). **Repeated at 15:31:20Z**
     as the Owner (the main path as the Owner, 10 of 10 required and 7 of 7 optional passed): Připojení on that
     Environment answered `ready` and offered pairing, without a Codex restart offered;
   - Apps on every Environment each account lists.
4. **R2, 15:16:43–15:17:23Z.** The same readings.
5. **Recovery issues:** none open with the label `recovery` (15:17Z).
6. **End:** `2026-11-21T15:17:29Z`, the green light.

**Quiet:** the pilot Organization's Deployment Repo ran no workflow inside the window. The lane's apply left node 1007 (a device approved for one test of the day, #381 and #382) among the device-channel sources
of the Owner's gateway; this was read in `/etc/lazurio/workspace/Caddyfile` on that Machine.

### Per Machine

At both edges, `recover` answered `healthy` with all five checks `ok`, `update status` answered running and active
`0.1.24-rc.10`, and the Launchpad unit's `NRestarts` was 0. On the Owner's Work Environment this is the count after its
restart in step 2. The `/health` column is the Launchpad's own `GET /health` at each edge. T3 Code is not part of this
candidate; its version is recorded only so that a change can be told apart.

| Machine | Kind | R1 | R2 | `recover` R1 / R2 | `active` R1 / R2 | `/health` R1 / R2 | Modules started and opened | T3 Code |
|---|---|---|---|---|---|---|---|---|
| `4cb47f16810a7edb` | work (Owner) | 15:11:25Z | 15:16:48Z | healthy / healthy | 0.1.24-rc.10 / 0.1.24-rc.10 | 0.1.24-rc.10 / 0.1.24-rc.10 | Knowledgebase 15:13:37Z and Design system 15:13:43Z, each started from its tile and opened on its own origin with HTTP 200 and its heading; the chat answered; the real work of step 2 ran here | 0.1.10-preview.20261120.1 |
| `7d3f2189170e39ea` | work (services) | 15:11:29Z | 15:16:52Z | healthy / healthy | 0.1.24-rc.10 / 0.1.24-rc.10 | 0.1.24-rc.10 / 0.1.24-rc.10 | none to start: its one tile is the Organization's AI pool service, a service page and not a module | 0.1.2-lazurio.6 |
| `9289bc065828421b` | work (team) | 15:11:56Z | 15:17:18Z | healthy / healthy | 0.1.24-rc.10 / 0.1.24-rc.10 | 0.1.24-rc.10 / 0.1.24-rc.10 | none to start: Apps shows 0 module tiles | 0.1.2-lazurio.6 |
| `c04fe553256c9e52` | work (member) | 15:12:01Z | 15:17:23Z | healthy / healthy | 0.1.24-rc.10 / 0.1.24-rc.10 | 0.1.24-rc.10 / 0.1.24-rc.10 | Knowledgebase 15:14:34Z, started from its tile and opened on its own origin with HTTP 200 and its heading; the chat answered | 0.1.9-lazurio.2 |
| `bce5a5489ecd7010` | personal (Owner) | 15:11:20Z | 15:16:43Z | healthy / healthy | 0.1.24-rc.10 / 0.1.24-rc.10 | 0.1.24-rc.10 / 0.1.24-rc.10 | none to start: Apps shows 0 module tiles; Připojení as described in step 3 | 0.1.10-lazurio.4 |

The Team Environment is listed as `work`, because the record's kinds are `work` and `personal`.

## Not verified

- Safari, Firefox and a phone.
- The candidate's other changes beyond the main path and the acceptances named above.

## Earlier candidate: v0.1.24-rc.6, 2026-11-20

The final is no longer made from `rc.6` (see the top of this file). Its record stays as it was merged in #1125:


`v0.1.24-rc.6` (`af650b19`) is the candidate for the final `v0.1.24`. It carries LZD-0041 phase A (#1114): a stale
projection digest no longer decides whether an Organization root runs. The digest is reported, and a root runs whether
or not it declares the digest or keeps `company.gen3.json`. It also carries Brain R11a for Buddy GEN4 (#1085, #1103 to
#1110, #1119, #1120 by #1122, #1124), the Buddy GEN4 sign and skills (#1100, #1102, #1106, #1116 to #1118), and the
canary record of 0.1.23 (#1107). Those are 14 commits since `v0.1.23-rc.4`. The canary stage ran on 2026-11-20 from
06:31:58Z to 07:19:06Z in two passes. The second pass was complete and included the real work on a Machine that the
first had left out (review of #1125). It is green.

The record is [`qualification/canary/v0.1.24-rc.6.json`](../../qualification/canary/v0.1.24-rc.6.json), added by #1125. Machines are opaque ids under the key of the earlier records, kept only at the station,
so every Machine keeps the id it had there.

**This record is not a release.** The final `v0.1.24` is tagged only on the release owner's approval in the `release`
environment. Its tree is `af650b19`'s outside `qualification/` and `docs/evidence/`, on a release commit whose parent is
this record's merge, as for `v0.1.20` to `v0.1.23`.

### The candidate

- Tag `v0.1.24-rc.6` at `af650b1962c9e5a4d6930d4015a5e2d875da0cfd`, release run 44680227406 (success),
  prerelease published 2026-11-20T05:39:22Z.
- linux-x64: sha256 `d6e18cbb…`, 102 753 760 B. `lazurio.sigstore.json`: sha256 `9ebe1ea1…`, 11 933 B. Both were checked
  on the downloaded files, and `gh attestation verify --bundle … --source-digest af650b19 --signer-workflow
  …/release.yml` accepts the binary.
- Qualification `qualify.yml` run 44682475619 on `af650b19`: success.

### Scope and how each Machine got the candidate

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

### The stage

By one thread, read-only except the smoke tests and the real work on the personal VM.

**First pass, 06:48:39–07:00:20Z.** The personas were taken one after the other, because the Buddy GEN4 coordinator held
the Owner persona from 06:48Z to 06:54Z. It covered R1 of every Machine, the standard suite and the main path as the
member (10 of 10 and 9 of 9 required) and as the Owner (7 of 7 and 10 of 10 required), Apps on every Environment, and R2.
All of it was green. It left out the real work on a Machine (`docs/recovery-mode.md` G.3: a Folder refresh and a
Launchpad restart), so the stage was run again in full.

**Second pass, 07:11:15–07:19:06Z, complete:**

1. **R1, 07:11:39–07:12:26Z.** Every Machine through its own Launchpad, as the test accounts: `/api/recovery`, which is
   the use case of `lazurio recover --json`, and `/api/update/status`.
2. **Real work on the personal VM, 07:12:36–07:12:48Z,** over its operator SSH entry:
   - `lazurio doctor`: verdict `broken` only because `gh` is not signed in on this test account (`tool gh: fail`), the
     same as for `v0.1.23`;
   - `lazurio machine folder-refresh`: `unchanged`;
   - a restart of the Launchpad unit at 07:12:38Z: active again with `NRestarts` 0;
   - `lazurio recover --json`: healthy, all five checks `ok`;
   - no failed unit. `gbrain.service` and T3 Code stayed active and were not restarted.
3. **The smoke tests,** each persona in a fresh headless profile of its own:
   - `suite both`: 17 of 17 required steps passed. 7 optional passed and 1 was INCONCLUSIVE: the member's refusal at the
     Owner's Personal Environment, which the member's tailnet client cannot reach;
   - the main path as the Owner and the member: 19 of 19 required and 13 optional passed, the Marketplace included;
   - Apps on every Environment each account lists.
4. **R2, 07:18:04–07:18:57Z.** The same readings.
5. **Recovery issues:** none open with the label `recovery` (07:19Z).
6. **End:** `2026-11-20T07:19:06Z`, the green light.

**Not quiet:** the Buddy GEN4 coordinator accepted Brain on the Owner's Personal Environment from 06:48Z to 06:54Z,
between the start of the window and the second pass. That covered sign-in as the Owner, Apps → Integrations, a question
to the agent, and one test page written to and read from Brain through Executor. The Launchpad, T3 Code and the gateway
were not restarted, and both passes read that Machine as healthy on the candidate. The pilot Organization's Deployment
Repo ran no workflow inside the window.

#### Per Machine

At both edges of the second pass, `recover` answered `healthy` with all five checks `ok`, `update status` answered
running and active `0.1.24-rc.6`, and the Launchpad unit's `NRestarts` was 0. On the personal VM this is the count after
its restart in step 2. The first pass read the same. The `recover` check `launchpad-health` is the Launchpad's own
`GET /health` (`src/recover/observe.ts`). It passes only when `/health` answers in normal mode with the active version,
so the `/health` column shows that answer at each edge. T3 Code is not part of this candidate; its version is recorded
only so that a change can be told apart.

| Machine | Kind | R1 | R2 | `recover` R1 / R2 | `active` R1 / R2 | `/health` R1 / R2 | Modules started and opened | T3 Code |
|---|---|---|---|---|---|---|---|---|
| `4cb47f16810a7edb` | work (Owner) | 07:11:44Z | 07:18:09Z | healthy / healthy | 0.1.24-rc.6 / 0.1.24-rc.6 | normal, 0.1.24-rc.6 / normal, 0.1.24-rc.6 | Knowledgebase 07:14:37Z and Design system 07:14:42Z, each started from its tile and opened on its own origin with HTTP 200 and its heading; the chat answered | 0.1.10-lazurio.3 |
| `7d3f2189170e39ea` | work (services) | 07:11:48Z | 07:18:14Z | healthy / healthy | 0.1.24-rc.6 / 0.1.24-rc.6 | normal, 0.1.24-rc.6 / normal, 0.1.24-rc.6 | none to start: its one tile is the Organization's AI pool service, a service page and not a module | 0.1.2-lazurio.6 |
| `9289bc065828421b` | work (team) | 07:12:21Z | 07:18:53Z | healthy / healthy | 0.1.24-rc.6 / 0.1.24-rc.6 | normal, 0.1.24-rc.6 / normal, 0.1.24-rc.6 | none to start: Apps shows 0 module tiles | 0.1.2-lazurio.6 |
| `c04fe553256c9e52` | work (member) | 07:12:26Z | 07:18:57Z | healthy / healthy | 0.1.24-rc.6 / 0.1.24-rc.6 | normal, 0.1.24-rc.6 / normal, 0.1.24-rc.6 | Knowledgebase 07:15:42Z, started from its tile and opened on its own origin with HTTP 200 and its heading; the chat answered | 0.1.9-lazurio.2 |
| `bce5a5489ecd7010` | personal (Owner) | 07:11:39Z | 07:18:04Z | healthy / healthy | 0.1.24-rc.6 / 0.1.24-rc.6 | normal, 0.1.24-rc.6 / normal, 0.1.24-rc.6 | none to start: Apps shows 0 module tiles; the real work of step 2 ran here | 0.1.10-lazurio.3 |

The Team Environment is listed as `work`, because the record's kinds are `work` and `personal`.

### Phase A of LZD-0041, accepted on this ring

Phase A was accepted as the Owner test account on `v0.1.24-rc.3` (02:46–02:48Z, Lazurio/LazurioPlatform#1094). `rc.6`
carries the same code (#1114 is unchanged since).

- The Owner's Organization root was moved locally to the fixture of #1094 (LazurioExampleOrganization_GEN3 `614a415`:
  the same sentence edited in both documents, the digest not recomputed). Lazurio 0.1.23 reads that root as `conflict`.
- On the candidate it ran: `transition` with the issue `canonical_projection_hash_invalid`.
- Apps showed its 12 modules with no conflict line, Knowledgebase started, and Začínáme kept its step done.
- The routine `lazurio update` fast-forwarded the root back to `main`.

### Not verified

- Safari, Firefox and a phone.
- The candidate's other changes beyond the main path and the acceptances named above. The Buddy GEN4 sign is known and
  does not block the final, according to its coordinator.
