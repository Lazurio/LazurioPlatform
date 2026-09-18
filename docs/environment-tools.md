# Environment tools and operator sign-ins

Proposed bounded pilot procedure under accepted decision 0144. This document does
not claim an implemented tool installer, authenticated harness or usable Environment.
Machines delivers the online Machine and selected Platform release; local Platform
operations and the operator prepare what is needed inside it.

## Ownership

| Capability | Platform responsibility | Operator / external owner responsibility |
| --- | --- | --- |
| Standalone Lazurio CLI | Verify the release, stage and activate the selected artifact; no external Bun/Node prerequisite | Approve channel/target; Machines performs its infrastructure installation handover |
| Git and GitHub CLI (`gh`) | Diagnose availability and required capabilities; propose explicit preparation of missing tools | Authorize package/system changes; authenticate as the intended Principal and grant actual repo access |
| Module runtime (for example Bun) | Coordinate the module's declared preparation; report missing/incompatible runtime without claiming readiness | Module owns exact dependency/runtime requirements and preparation; operator approves installation |
| Codex / Claude harness | Diagnose the selected harness, instruction loading and required capabilities; provide one Folder-owned instruction contract | Choose the harness, accounts/model access and consent; complete provider-native sign-in |
| Credentials | Use an existing approved provider/credential interface; retain only non-secret diagnostic outcomes | Existing credential owner retains custody, rotation and revocation |

Do not install both harnesses merely because they are supported consumers. The pilot
must select and qualify an actual agent, not infer success from an executable's presence.
Do not copy sessions, tokens or another Principal's Personalspace from a workstation.
An operator identity in `lazurio.machine.json` does not authorize GitHub, model access,
package installation, a paid subscription or a Machine-wide system change.

## Minimal preparation sequence

1. Load and bind the Machines context; inspect tools under the actual execution user.
   Follow the existing decision 0140 tool-resolution rule: resolve the first executable
   on process PATH, then check capabilities/compatible versions. Do not introduce
   Homebrew or a hard-coded installation-directory allowlist as a universal prerequisite.
   This generic tool policy does not weaken the trusted system-account lookup used to
   bind the Linux operator or the artifact custody rules of the product installer.
2. Report separately: available, missing, incompatible, unauthenticated and access
   denied. A tool version, successful login or owner name alone cannot prove permission
   for an exact Organization/repository operation.
3. Present a bounded preparation plan: exact missing tool/version, official source,
   verification method, target scope and whether privilege/network access is needed.
   Reuse compatible installations. Do not silently upgrade global PATH tools or run
   guessed package commands. Select concrete sources/pins for the approved guest before
   implementing the installer; no universal package manager is chosen by this design.
4. Let the operator complete interactive/provider-native sign-ins. Recheck actual
   identity and exact repository rights before Organization materialization; denied or
   unavailable access stops that operation without deleting existing work.
5. Use the module's declared dependency preparation, then exercise prepare/start/open/
   functional check/status/stop through shared CLI/Launchpad behavior. Module dependencies
   are not bundled CLI requirements and preparation success alone is not app readiness.
6. Start a fresh selected agent and prove Folder instructions, Organization rules and
   one bounded real task. Store only sanitized evidence in the owning private scope.

## Pilot limits

Implement read-only diagnosis and one explicitly approved preparation path first.
No credential broker, account registry, automatic model login, general tool updater
or package-manager matrix is required. Unknown installation state receives a diagnosis
and operator repair procedure, not an improvised privileged cleanup. Missing accounts
remain an explicit pilot prerequisite, not something Machines or a profile can grant.
Real Organization materialization and canonical document adoption have their separate
decision/authorization gate; this proposal does not authorize conversion or cloning.
