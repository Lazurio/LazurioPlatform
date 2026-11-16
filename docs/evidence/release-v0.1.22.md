# Ring 0 and the smoke test of v0.1.22-rc.3, 2026-11-16

Evidence for [recovery mode G.3](../recovery-mode.md#g3-canary-stage-every-machine-of-the-pilot-organization-then-the-smoke-test)
and the [canary of the release cycle](../release-cycle.md#qualification-and-the-canary): the candidate `v0.1.22-rc.3`
(`a00c77a6`) ran on every Machine in scope of the pilot Organization, LazurioExampleOrganization, and on one personal VM;
every Machine was read at both edges of the stage; between the readings the stage did real work on the personal VM and
ran recorded smoke tests as the pilot Organization's test accounts, its Owner and a member, along the main path: modules
started and opened from their tiles, the chat answering, Připojení, and the movable launcher. The stage ran on
2026-11-16 from 12:26:54Z to 12:36:45Z and is green.

The record is [`qualification/canary/v0.1.22-rc.3.json`](../../qualification/canary/v0.1.22-rc.3.json), added by the same
pull request as this file. Machines are opaque ids, as in the record: the first 16 hex digits of an HMAC-SHA-256 under the
key of v0.1.20's and v0.1.21's records, kept only by the release thread's station, so every Machine keeps the id it had
there. Which Machine is which is kept only at the station.

**This record is not a release.** The final `v0.1.22` is tagged only on the release owner's decision, after their own look
at the candidate's main change (a drag, a reload, Escape in Buddy's window). A final tagged with this record is the tree
of `v0.1.22-rc.3` (release.yml's `qualified` job: the tag differs from the candidate only under `qualification/` and
`docs/evidence/`).

## Earlier candidates of 0.1.22

- **`v0.1.22-rc.1`** had a stage on 2026-11-15, recorded in Lazurio/LazurioPlatform#1012. Its review found that stage
  invalid: it started at the first reading instead of when the last Machine ran the candidate, with no reading at that
  start, did no real work on the Machines and did not exercise the main path. #1012 is closed without a merge.
- **`v0.1.22-rc.2`** ran on every Machine of this scope on 2026-11-15, healthy at both edges, but its stage could not end
  green: no Work Environment of the pilot Organization had a module to start, because GitHub was not connected there after
  their return to the tailnet. No record was written. The modules were restored on 2026-11-16 before this stage.

## What v0.1.22-rc.3 adds to v0.1.21

The source of v0.1.21 is `00dec36b` (rc.6). Code changes since then:

- Buddy moved by the person and standing free (#980; F60, addendum of 2026-11-14), the main change of this release;
- shared applications in Apps and "Share with colleagues" (#928);
- the agent entry to colleagues' applications through the Environment's relay, and its switch in Settings (#948, #949);
- Disk and Processor under Memory on the new tab (#941);
- the Environment browser: the view's own picker for pop-ups (#972), file choosers in cross-origin frames (#975),
  windows that open blank with every tab in one overview (#993), payments declined over the page and card payments in the
  view without Chrome saving a card (#984, #994), a failed binding never leaving a session on another agent's tab (#986),
  and the browser CLI listing and letting go of the calling thread's windows (#971);
- the person's own instructions for agents in the Folder and `lazurio folder instructions` (#990), with
  "Vlastní pokyny pro agenty" in Settings (#991);
- Organization tools declared in `settings.tools` and provisioned by `lazurio update` (F73, #992);
- `lazurio doctor`: a module not shared by intent is a note, not a warning (#1013);
- chat defaults read T3 Code's answer from its last JSON line, an unreadable answer named as such (#1015);
- Folder guidance and decisions: every Environment only through a tailnet (#945), Začínáme for the AI sign-in (#831),
  development previews in a new tab (#549), the access model of 2026-11-14 (#982), and the decision addenda of
  2026-11-15 (#983, #988, #999, #1006, #1007, #1008, #1010).

## The candidate

`v0.1.22-rc.3` is tagged at `a00c77a6`. Its prerelease was published at 2026-11-16T08:10:10Z; qualification run
43829101725 of `main` passed.

- linux-x64: sha256 `69010c21…`, 102 061 536 B;
- `lazurio.sigstore.json`: sha256 `d052821c…`, 11 851 B; `gh attestation verify` accepts the binary as signed by
  `release.yml` at `refs/tags/v0.1.22-rc.3` for `a00c77a6` (verified 2026-11-16 at 12:38Z).

## Scope and how each Machine got the candidate

- **The four Environments of the pilot Organization** on its tailnet host (the Owner's and the member's Work
  Environments, the Team Environment and the Prostředí služeb): LazurioExampleOrganization/infra#308, merged at 11:47:28Z
  and applied by its push run, which ended at 12:14:30Z.
- **One personal VM**, the Owner test account's Personal Environment: its lane on the operator path
  (LazurioExampleOrganization/infra#309), merged at 12:16:01Z after an independent review and the Environment owner's
  consent to its exact Plan, applied by the operator. The apply ended at **12:26:54Z**; that is the last time a Machine in
  scope got the candidate, and the start of the stage.
- **Not in this record:** the release owner's own Personal Environment, because the station cannot read it.

## The stage

By one thread. Read-only except the real work on the personal VM and the smoke tests.

1. **Quiet check, 12:26:54Z:** the operator's apply had ended and released its lock. The pilot Organization's Deployment
   Repo had no run in progress; its last runs were the Plans of two Machines v0.12.247 pull requests
   (LazurioExampleOrganization/infra#310 and #311), which ended at 12:19:10Z and applied nothing. No run started during
   the stage. **Start:** `2026-11-16T12:26:54Z`.
2. **R1, 12:27:34–12:28:10Z.** Every Machine through its own Launchpad, as the test accounts, each through the client of
   its own space in the pilot Organization's tailnet (`/api/recovery`, the use case of `lazurio recover --json`, and
   `/api/update/status`).
3. **Real work on the personal VM, 12:28:33–12:28:45Z,** over its own SSH entry: `lazurio doctor` (machine binding and
   entry ok), `lazurio machine folder-refresh` (unchanged), a restart of the Launchpad unit (active again, `NRestarts`
   0), `lazurio recover --json` healthy, `lazurio doctor` again ok; the T3 Code units were not touched.
4. **The smoke tests, 12:28:49–12:35:23Z**, each persona in a fresh headless profile of its own, never in an Environment's
   browser:
   - **the standard suite as the Owner and the member** (skill `lazurio-example-smoke-test`, `suite both`): **17 of 17
     required steps passed**; 7 optional passed, 1 optional INCONCLUSIVE (the member's refusal at the Owner test
     account's Personal Environment, which the member's tailnet client could not reach: no proof either way);
   - **the main path as the Owner and the member**: every Environment each account lists; Apps of each own Work
     Environment (12 module tiles for the Owner, 11 for the member); Knowledgebase and the Design system started and
     opened from their tiles on their own origins with HTTP 200; the chat of each Work Environment answered a sum
     correctly within 5 s; Marketplace with 7 templates and the Mission Control detail; Připojení on every Environment.
     **19 of 19 required steps passed.** One optional step failed in the first run: the check expected no phone pairing
     on the Owner's Personal Environment, whose state is `ready` (own ChatGPT, Remote Control on), where the card offers
     pairing by design (`stateMessage` in `src/launchpad/connections-view.ts`). The check was corrected and the Owner's
     main path ran again at 12:33:57–12:34:53Z: **10 of 10 required and 7 of 7 optional passed**;
   - **the movable launcher as the Owner** on the Owner test account's Work Environment: **7 of 7 required steps passed** and 4 optional
     passed: the served `/.lazurio/shell.js` carries the movable launcher, the launcher is drawn, a drag moved it by
     400 × 300 px and it kept its place after a reload;
   - the Prostředí služeb carries only the Organization's AI pool service, with no module to start; the check that looked
     for one there found none, as it did for rc.2.
5. **R2, 12:35:43–12:36:20Z.** The same readings.
6. **Recovery issues: none** (12:36:43–12:36:45Z): open issues labelled `recovery` in this repository: 0; of the five
   issues naming `0.1.22-rc.3` in the release's Organizations, none reports a failure of the candidate (a version pin of
   another host's record, the restored modules, two plans and a closed incident of another host).
7. **End:** `2026-11-16T12:36:45Z`, the green light. The result is green.

### Per Machine

At both edges `recover` answered `healthy` with all five checks `ok`, `update status` answered running and active
`0.1.22-rc.3`, and the Launchpad unit's `NRestarts` was 0 (the personal VM's count after its restart in step 3).
T3 Code is not part of this candidate; its version is recorded to tell a change apart, and it did not change.

| Machine | Kind | R1 | R2 | `recover` R1 / R2 | `active` R1 / R2 | T3 Code |
|---|---|---|---|---|---|---|
| `4cb47f16810a7edb` | work | 12:27:39Z | 12:35:47Z | healthy / healthy | 0.1.22-rc.3 / 0.1.22-rc.3 | 0.1.9-preview.20261115.1 |
| `7d3f2189170e39ea` | work | 12:27:43Z | 12:35:51Z | healthy / healthy | 0.1.22-rc.3 / 0.1.22-rc.3 | 0.1.2-lazurio.6 |
| `9289bc065828421b` | work | 12:28:06Z | 12:36:15Z | healthy / healthy | 0.1.22-rc.3 / 0.1.22-rc.3 | 0.1.2-lazurio.6 |
| `c04fe553256c9e52` | work | 12:28:10Z | 12:36:20Z | healthy / healthy | 0.1.22-rc.3 / 0.1.22-rc.3 | 0.1.7-lazurio.1 |
| `bce5a5489ecd7010` | personal | 12:27:34Z | 12:35:43Z | healthy / healthy | 0.1.22-rc.3 / 0.1.22-rc.3 | 0.1.7-lazurio.1 |

The Team Environment is listed as `work`, because the record's kinds are `work` and `personal`.

## Not verified

- **The release owner's own look at the movable launcher** (a drag, a reload, Escape in Buddy's window).
- **Buddy's figure on the Owner test account's Work Environment**: the launcher there shows the neutral Lazurio mark, as
  it did for rc.1; this stage did not explain why.
- **Escape inside a real Buddy window**: only in a stand-in frame of the Launchpad preview, which does not answer it.
- **Safari, Firefox and touch on a real phone.**
- **The candidate's other changes beyond the main path** (shared applications, the agent entry, Disk and Processor, the
  Environment browser, the person's own instructions, Organization tools): no step of this stage exercised them.
