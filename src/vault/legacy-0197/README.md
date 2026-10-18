# Frozen: the 0197 pilot vault, read only

Root decision 0198 gives every Environment its own vault (decision F53 in
`docs/decisions.md`, the core in `../flow.ts`). A few Environments were connected
earlier the 0197 way (decision F43): an account `vaultwarden@<Environment address>`
that a person invited into a collection of their own organization, the collection
recorded by its ID beside the account in
`${XDG_STATE_HOME:-~/.local/state}/lazurio/vault/<vault host>/<Environment address>/`.

This folder keeps exactly those Environments working, read only and as before, while
their Machine handover names no `vault`:

- `context.ts` says where such an account is, derived as F43 derived it: the vault
  from `network.headscale_server_url`, the address from the hosted entry.
- `pilot.ts` reads it: the status (connected, revoked, unreachable or failed), the one
  shared session unlocked for agents (`lazurio vault env`), and the runtime secrets of
  decision F46 from the recorded collection, under F46's rule of 0197 (only the
  owning Organization's applications; never a Personalspace module).

Nothing here connects an Environment, registers an account, confirms a member, adopts
a collection by its name or disconnects, and nothing of the pilot is written but the
shared session. When the handover gains `vault`, the Environment's own vault is set up
with the new account in a directory of its own, and this pilot's directory stays
untouched for the move of its items (DEV-6631 task 649).

A personal Environment whose pilot was never connected (`pilotConnected` is false)
connects its person's own Bitwarden instead (root decision 0203 point 7,
`../connection.ts`); a connected pilot keeps working as above and offers no such
connection.

## Deletion condition

Delete this folder when both hold:

1. every Environment's handover carries `vault`, and
2. DEV-6631 task 649 has moved every pilot's items into its Environment's own vault.

Deleting it means removing this folder, the `pilotContextOf` and `pilotConnected`
fallbacks in `../host.ts`, the `context.kind === "pilot"` branches and the
`PilotContext` member of `VaultHost.context` in `../flow.ts`, the pilot's branch of
`vaultInAppsOf` in `src/launchpad/boot-document.ts` (whether the Apps column lists
Trezor), and the pilot tests (`tests/vault-pilot.test.ts`). Nothing else depends on
it.
