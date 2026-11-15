# Ring 0 and the smoke test of v0.1.22-rc.1, 2026-11-15

Evidence for [recovery mode G.3](../recovery-mode.md#g3-canary-stage-every-machine-of-the-pilot-organization-then-the-smoke-test)
and the [canary of the release cycle](../release-cycle.md#qualification-and-the-canary): the candidate `v0.1.22-rc.1`
(`a64bbcc8`) ran on every Machine in scope of the pilot Organization, LazurioExampleOrganization, and on one personal VM;
every Machine was read at both edges of the stage; one recorded smoke test as the pilot Organization's test accounts, its
Owner and a member, passed between the readings. The stage ran on 2026-11-15 from 21:05:43Z to 21:10:17Z.

The record is [`qualification/canary/v0.1.22-rc.1.json`](../../qualification/canary/v0.1.22-rc.1.json), added by the same
pull request as this file. Machines are opaque ids, as in the record: the first 16 hex digits of an HMAC-SHA-256 under the
key of v0.1.20's and v0.1.21's records, kept only by the release thread's station, so every Machine keeps the id it had
there; the personal VM of this stage is another Machine than v0.1.21's and has a new id. Which Machine is which is kept
only at the station.

**This record is not a release.** The final `v0.1.22` is tagged only on the release owner's decision, after his own look
at the candidate's main change. A newer candidate exists: `v0.1.22-rc.2` (`56e9cd14`, published 2026-11-15 at
19:56:49Z) has run on no Machine of Ring 0 and has no canary record. A final tagged with this record is the tree of
`v0.1.22-rc.1` (release.yml's `qualified` job: the tag differs from the candidate only under `qualification/` and
`docs/evidence/`); a final carrying rc.2's changes needs rc.2's own Ring 0 and record.

## What v0.1.22-rc.1 adds to v0.1.21

The source of v0.1.21 is `00dec36b` (rc.6). Code changes since then:

- Buddy moved by the person and standing free (#980; F60, addendum of 2026-11-14), the main change of this candidate;
- shared applications in Apps and "Share with colleagues" (#928);
- the agent entry to colleagues' applications through the Environment's relay, and its switch in Settings (#948, #949);
- Disk and Processor under Memory on the new tab (#941);
- Folder guidance: every Environment only through a tailnet (#945), Začínáme for the AI sign-in (#831), development
  previews in a new tab (#549), the access model of 2026-11-14 (#982).

## The candidate

`v0.1.22-rc.1` was tagged on 2026-11-14 at 22:17:51Z at `a64bbcc8`, where `main`'s Platform checks were green on every job,
`check (macos-15)` included, on the release owner's approval in the coordinating thread. The Release workflow's
"Attest and publish" waited for the `release` environment's reviewer, the release owner, and was approved on his earlier
word; the prerelease was published at 2026-11-15T00:18:55Z. Qualification run 43657564588 passed.

- linux-x64: sha256 `770123e0…`, 101 787 104 B;
- `lazurio.sigstore.json`: sha256 `9389c317…`, 11 753 B; `gh attestation verify` accepts the binary as signed by
  `release.yml` at `refs/tags/v0.1.22-rc.1` for `a64bbcc8`.

## Scope and how each Machine got the candidate

- **The four Environments of the pilot Organization** on its tailnet host (the Owner's and the member's Work
  Environments, the Team Environment and the Prostředí služeb): LazurioExampleOrganization/infra#293, applied by its push
  run after the merge at 10:29Z. #301 (Machines v0.12.246 and a disk growth) re-applied the same host and ended at
  15:53:38Z with the candidate unchanged; that is the last time a Machine in scope got the candidate.
- **One personal VM**, the Owner test account's Personal Environment: the product's own updater
  (`lazurio update --version v0.1.22-rc.1`, 2026-11-15 08:19Z, on the release owner's instruction), then its lane on the
  operator path (LazurioExampleOrganization/infra#298, applied 14:31–14:40Z after an independent review).
- **Not in this record:** the release owner's own Personal Environment, which also runs the candidate since
  HumanAndMachine-ai's lane change of 15:48Z, because the station cannot read it.
- **No longer Environments:** the former host's guests, destroyed by LazurioExampleOrganization/infra#302.

## The stage

By one thread, read-only except the smoke test.

1. **Quiet check, 21:05:24Z:** no rollout run in progress, queued or waiting in the pilot Organization's Deployment Repo;
   its last run (#302) had ended at 15:59:45Z. Every Machine had run the candidate since 15:53:38Z at the latest
   (the end of #301's apply), but nothing read their health or restarts between that apply and R1, so the stage
   starts at the first reading. **Start:** `2026-11-15T21:05:43Z`, R1's first reading.
2. **R1, 21:05:43–21:06:19Z.** Every Machine through its own Launchpad, as the test accounts, each through the client of
   its own space in the pilot Organization's tailnet (`/api/recovery`, the use case of `lazurio recover --json`, and
   `/api/update/status`).
3. **The smoke test, 21:06:55–21:08:24Z**, each persona in a fresh headless profile of its own, never in an Environment's
   browser:
   - **the standard suite as the Owner and the member** (skill `lazurio-example-smoke-test`, `suite both`): **17 of 17
     required steps passed**; 7 optional passed, 1 optional INCONCLUSIVE (the member's refusal at the Owner test
     account's Personal Environment, which her tailnet client could not reach: no proof either way);
   - **the movable launcher as the Owner** on his Work Environment: **7 of 7 required steps passed** and 4 optional
     passed: the served `/.lazurio/shell.js` carries the movable launcher, the launcher is drawn, a drag moved it by
     400 × 300 px and it kept its place after a reload.
4. **R2, 21:08:48–21:09:52Z.** The same readings. The Owner's first R2 run stopped before its sign-in on
   `net::ERR_NETWORK_CHANGED`; it ran once more at 21:09:30Z and passed.
5. **Recovery issues: none** (21:10:13–21:10:17Z): issues labelled `recovery`: 0; issues naming `0.1.22-rc.1`: 0.
6. **End:** `2026-11-15T21:10:17Z`, the green light. The result is green.

### Per Machine

At both edges `recover` answered `healthy` with all five checks `ok`, `update status` answered running and active
`0.1.22-rc.1`, and the Launchpad unit's `NRestarts` was 0. T3 Code is not part of this candidate; its version is recorded
to tell a change apart, and it did not change.

| Machine | Kind | R1 | R2 | `recover` R1 / R2 | `active` R1 / R2 | T3 Code |
|---|---|---|---|---|---|---|
| `4cb47f16810a7edb` | work | 21:05:48Z | 21:09:48Z | healthy / healthy | 0.1.22-rc.1 / 0.1.22-rc.1 | 0.1.2-lazurio.6 |
| `7d3f2189170e39ea` | work | 21:05:53Z | 21:09:52Z | healthy / healthy | 0.1.22-rc.1 / 0.1.22-rc.1 | 0.1.2-lazurio.6 |
| `9289bc065828421b` | work | 21:06:15Z | 21:08:48Z | healthy / healthy | 0.1.22-rc.1 / 0.1.22-rc.1 | 0.1.2-lazurio.6 |
| `c04fe553256c9e52` | work | 21:06:19Z | 21:08:53Z | healthy / healthy | 0.1.22-rc.1 / 0.1.22-rc.1 | 0.1.2-lazurio.6 |
| `bce5a5489ecd7010` | personal | 21:05:43Z | 21:09:43Z | healthy / healthy | 0.1.22-rc.1 / 0.1.22-rc.1 | 0.1.7-lazurio.1 |

The Team Environment is listed as `work`, because the record's kinds are `work` and `personal`.

## Not verified

- **The release owner's own look at the movable launcher** (a drag, a reload, Escape in Buddy's window). The launcher
  on the Owner test account's Work Environment shows the neutral Lazurio mark, not Buddy's figure: Buddy's picture did
  not show there for that account, which this stage did not explain. The figure itself was seen by the release owner on
  the test account's Personal Environment after its host-only update.
- **Escape inside a real Buddy window**: only in a stand-in frame of the Launchpad preview, which does not answer it.
- **Safari, Firefox and touch on a real phone.**
- **The other changes of the candidate beyond the standard suite** (shared applications, the agent entry, Disk and
  Processor, the Folder guidance): no step of this stage exercised them.
