# Migration: remove rollback

Converges what an installation of `v0.1.0`–`v0.1.x` left for program rollback, once
the first release without rollback (below: vN) is the active version. Background: the
recovery-mode shaping (proposed decision F21), section H, and
[product update](../../../../docs/update.md) "Activation".

Migration code lives here and nowhere else. The current direction (`activation.ts`,
`layout.ts`, `update.ts`, `install.ts`) knows nothing of `previous`, `pending.json` or
`lazurio-rollback.service`; it calls the two entry points below and nothing more.

## Entry points

| Function | Caller | What it does |
| --- | --- | --- |
| `removeRollbackLeftovers` | `performUpdate` and `lazurio install`, under the update lock, before anything else | Validates the whole update state first (an unreadable mark or marker stays `state-invalid`, untouched), then converges forward, in this order |
| `legacyRollbackState` | `readStatus` (`update status`, the pill) | Read-only: `legacyRollbackState: true` while anything below is left |

What `removeRollbackLeftovers` converges:

1. **`update/pending.json`.** Selector on `from`: deleted. Selector on `to` (with
   `previous` on `from`): the high-water mark is raised to `to` and the marker is
   deleted, whether or not the Launchpad reports `to`. When it does not, the result
   says `unhealthy`; `lazurio update` then answers `activation-unhealthy` unless it
   activates a newer release. **Nothing is switched back.** Any other combination is
   `state-invalid` and stays.
2. **Units written by `lazurio install --service`** (first line is the installer's
   marker): `lazurio-rollback.service` is deleted; the Launchpad unit of this install
   base that still carries `OnFailure=` is rewritten to the current text
   (`Restart=always`, no start limit, the PATH line). `systemctl --user daemon-reload`,
   no restart: the new `Restart=` applies from the Launchpad's next exit. A unit
   without the marker, or of another install base, is someone else's and stays.
3. **`previous`.** The link is deleted and every version except the active one is
   pruned.

## The update TO vN is still performed by the old updater

The executable that updates an installation to vN is the installed v0.1.x. It still
writes `previous` and a marker, and it still switches back when vN's restarted
Launchpad does not report healthy within 30 s; a leftover `lazurio-rollback.service`
still runs the old `previous` binary when the old unit hits its start limit. That is
the last rollback that can happen, it cannot be prevented without blocking the update,
and it happens only if vN is unhealthy. vN in Recovery mode answers its health socket
with 503, so the old updater's decision is the correct one. From the first mutating
command run by vN on, this migration removes all of it.

## Condition for deleting this directory

Delete it, its two call sites and `legacyRollbackState` in `update status`, in the
first release whose `minimum_updater_version` is at least vN: no updater that can
still install it writes the state this migration removes.
