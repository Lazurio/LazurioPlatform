# The canary of v0.1.8-rc.70 and the final release v0.1.8, 2026-10-14/15

Evidence for [recovery mode G.3](../recovery-mode.md#g3-canary-stage-8-hours-on-every-machine-of-the-pilot-organization)
and [the release cycle](../release-cycle.md#qualification-and-the-canary): the candidate
`v0.1.8-rc.70` (source `1d4e24c7863bb684fa4bd3be9685bec674b19a43`) ran for 8 hours on the
hosted Machines of the pilot Organization before the final tag `v0.1.8` at the same source.
The record is [`qualification/canary/v0.1.8-rc.70.json`](../../qualification/canary/v0.1.8-rc.70.json).
Machines are opaque ids, as the record's; the pilot Organization and its Machines are named
only in its owner's private records.

## Scope

9 work VMs of the pilot Organization and the personal VMs of its 2 operators. Two
of the pilot Organization's work VMs were excluded from this candidate's canary by Matěj's
decision recorded in the root decision register (0166, addendum of 2026-10-14).

How each Machine got the candidate:
- the work VMs through the pilot Organization's Machines lane (Plan, Permit and apply). The
  first apply was interrupted after its Permit, and two reviewed recoveries completed it
  (the last at 17:22:38Z);
- the two personal VMs by their own updater (`lazurio update --version v0.1.8-rc.70`, which
  verifies the release's attestation) followed by `lazurio machine folder-refresh`, as the
  hosting apply does. Their personal lanes' pins were not raised for this candidate: a pin
  is a minimum (root decision 0161, addendum of 2026-09-28).

## The stage

- **Start:** `2026-10-14T17:23:55Z`. The last Machine was proven on the candidate then: `lazurio update
  status --json` active `0.1.8-rc.70`, Launchpad health on the candidate, `lazurio recover --json` healthy.
- **End:** `2026-10-15T01:24:27Z`.
- **Observation:** a read-only round on every Machine every 30 minutes (`update status`,
  `self-check`, `recover`, the Launchpad unit's state and `NRestarts`, module app units).
  Rounds (UTC, Machines on the candidate and healthy / Machines): 2026-10-14T17:24:35Z 11/11; 2026-10-14T17:55:07Z 11/11; 2026-10-14T18:25:39Z 11/11; 2026-10-14T19:27:59Z 11/11; 2026-10-14T19:58:29Z 11/11; 2026-10-14T20:29:02Z 11/11; 2026-10-14T20:59:29Z 11/11; 2026-10-14T21:30:00Z 11/11; 2026-10-14T22:00:33Z 11/11; 2026-10-14T22:31:00Z 11/11; 2026-10-14T23:01:29Z 11/11; 2026-10-14T23:31:56Z 11/11; 2026-10-15T00:02:24Z 11/11; 2026-10-15T00:32:52Z 11/11; 2026-10-15T01:03:21Z 11/11; 2026-10-15T01:24:27Z 11/11.
- **The runner's sleep (about 18:55–19:22Z, one round missed).** Snapshots alone would not
  exclude a transient entry into Recovery mode in that gap, so three durable sources close it:
  - Recovery mode is chosen only when the Launchpad starts (`startOrRecover` in
    `src/launchpad/recovery-mode.ts` at the candidate's tag). A Launchpad running in normal mode
    never switches into it, and a Launchpad serving it stays in it until it is restarted.
  - The Launchpad unit's `ActiveEnterTimestampMonotonic` is identical on every Machine in the
    rounds before (18:25Z) and after (19:27Z) the gap, with `NRestarts` 0: the same process ran
    throughout, and at 19:27Z its health answered in normal mode on the candidate.
  - Each Machine's persistent user journal for the whole stage (17:23:55Z–01:24:27Z) has no
    start or stop of `lazurio-launchpad.service` except one deliberate restart on one personal
    VM at 23:56:05Z, and no Launchpad line that mentions recovery.
- **Real work:**
  - a Folder refresh and a deliberate Launchpad restart on one personal VM (23:56Z: refresh
    `unchanged`, unit back healthy; a manual restart does not count in `NRestarts`);
  - the hosting operator's own lane work on that VM (its vault member; a gateway restart, no
    Launchpad restart);
- **Recovery issues:** none: no issue in the public repository's search (state all, created since 2026-10-14) names 0.1.8-rc.70 in its body.

## Per Machine

| Machine | Kind | `active` at end | `recover` start / end | Launchpad `NRestarts` start / end | Launchpad health at end | Module apps active start / end |
|---|---|---|---|---|---|---|
| `46b09a7c373b1a91` | work | 0.1.8-rc.70 | healthy / healthy | 0 / 0 | 0.1.8-rc.70 | 0 / 0 (failed 0) |
| `482d0d709bcc19df` | personal | 0.1.8-rc.70 | healthy / healthy | 0 / 0 | 0.1.8-rc.70 | 2 / 2 (failed 0) |
| `4dfc6455ec59bedd` | work | 0.1.8-rc.70 | healthy / healthy | 0 / 0 | 0.1.8-rc.70 | 6 / 6 (failed 0) |
| `5edad8b607cadf67` | work | 0.1.8-rc.70 | healthy / healthy | 0 / 0 | 0.1.8-rc.70 | 3 / 3 (failed 0) |
| `7eebb34f258c618d` | work | 0.1.8-rc.70 | healthy / healthy | 0 / 0 | 0.1.8-rc.70 | 0 / 0 (failed 0) |
| `9aa4ebaa7ef08857` | work | 0.1.8-rc.70 | healthy / healthy | 0 / 0 | 0.1.8-rc.70 | 0 / 0 (failed 0) |
| `9f77a9463e2a96a1` | work | 0.1.8-rc.70 | healthy / healthy | 0 / 0 | 0.1.8-rc.70 | 1 / 1 (failed 0) |
| `a27ae3e0029b9fa5` | work | 0.1.8-rc.70 | healthy / healthy | 0 / 0 | 0.1.8-rc.70 | 0 / 0 (failed 0) |
| `cd11000dfff1e3a0` | work | 0.1.8-rc.70 | healthy / healthy | 0 / 0 | 0.1.8-rc.70 | 0 / 0 (failed 0) |
| `f6539c7df28011c9` | personal | 0.1.8-rc.70 | healthy / healthy | 0 / 0 | 0.1.8-rc.70 | 0 / 0 (failed 0) |
| `f772bb0f2335bcfb` | work | 0.1.8-rc.70 | healthy / healthy | 0 / 0 | 0.1.8-rc.70 | 0 / 0 (failed 0) |

"Module apps active" counts the module app units (`lazurio-app-*`) running at the start and at
the end; none failed.

## Module starts

- **During the stage**, no operator started a module: no `lazurio-app-*` unit started on any
  Machine (persistent user journals, 17:23:55Z–01:24:27Z), and none stopped or failed. The
  stage ran through the evening and the night.
- **Seven Machines have no module running.** Four have modules that ran since before the
  candidate: 3, 6 and 1 on three work VMs, 2 on one personal VM. All of them kept running
  and were reported healthy by `lazurio module status` at the end.
- **Starts under the candidate, observed right after the stage** (01:32–01:34Z, still on
  `0.1.8-rc.70`, the bytes of the final release's source), on the two Machines of the
  operator who leads this release:
  - a stopped module started with `lazurio module start`, was healthy after 8 s, and its
    hosted URL answered with the gateway's sign-in redirect (302); it was then stopped again;
  - a module running since before the candidate was stopped and started again, and became
    healthy;
  - on the personal VM, a personal module was stopped and started again, healthy after 1 s,
    and its hosted URL answered 302.

  The other operators' running modules were not restarted at night.

## Result

Every Machine ran the candidate for the whole stage with `lazurio recover --json` healthy at
the start and the end, no Recovery mode, no automatic Launchpad restart and no failed module
app; modules start under the candidate (see *Module starts*). The record passes `scripts/qualify/check-canary.ts`. The pilot Organization's release
reviewer adds it in [431](https://github.com/Lazurio/LazurioPlatform/pull/431).
