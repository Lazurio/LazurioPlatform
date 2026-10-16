# Workspace tabs: an Organization's own arrangement of its modules

Decision: [F32's addendum of 2026-10-16](decisions.md). Related: #428 (hide
auxiliary module tiles), #446 (the first proposal, Work / Administration per
browser, whose tabs pattern and tests this builds on).

## What a person sees

Apps keeps two sections, Workspace and Productionspace. When the Organization
has arranged its Workspace, a row of its tabs sits beside the Workspace pill:
"Každodenní práce", "Finance", "Sklad". The first tab opens; every module is in
exactly one tab; a module nobody placed is in the first. Favourites stay
first within a tab and pinned in the column. Without an arrangement, or with
fewer than two tabs that have something on this Environment, Workspace looks
as before.

The Organization's Owner also sees "Upravit karty" at the end of the row and
"Přesunout do karty" in each module's menu. Both lead to the Organization's
modules in its Dashboard. Nobody else sees an editing action.

## Where the arrangement lives

One setting of the Organization (root decision 0194):

```json
"settings": {
  "workspace": {
    "tabs": [
      { "name": "Každodenní práce", "modules": ["mission-control", "deals"] },
      { "name": "Finance", "modules": ["invoices", "pricing"] },
      { "name": "Sklad", "modules": ["stock"] }
    ]
  }
}
```

in the Organization root's `lazurio.organization.json`. The closed tree of
`src/organizations/organization-settings.ts` checks it: 1 to 12 tabs, names of
1 to 40 characters without surrounding spaces and unique with letter case
ignored, module ids as `lazurio.module.v1` writes them, a module in one tab at
most. The catalog reads it with the Organization (`workspaceTabs`), so the
CLI's `organization list --json`, the Launchpad and agents see one
arrangement.

### Options compared

| | Org root setting (selected) | Slot field in `modules.manifest.json` | Dashboard database | Per person in the browser (#446) |
| --- | --- | --- | --- | --- |
| Same for every member | yes | yes | yes | no |
| One truth, versioned and reviewable | yes, Git | yes, Git | no (0194 rejects it) | no |
| Writer | the Dashboard with the Owner's rights (0194 point 2); agents by pull request | pull request only | the Dashboard | each browser |
| Older releases | treat the settings section as invalid and keep the last applied settings | copy the field into the legacy projection | unaffected | unaffected |
| Local Folders, Team Environments | read from the root like every Organization file | same | need the relay | per browser |

The canonical manifest's top level is a closed schema, so a new top-level key
would make every older release refuse the Organization; the `settings` section
was made for this kind of Organization-wide choice and fails safe.

## How a change travels

1. The Owner clicks "Přesunout do karty" or "Upravit karty" and arranges the
   tabs in the Dashboard (Nastavení Organizace → Moduly).
2. The Dashboard plans the exact change of `settings.workspace`, the Owner
   approves it, and the Dashboard writes it to `main` with the Owner's own
   GitHub rights, with the blob's sha so a concurrent change is refused, then
   reads it back (the existing settings editor, `docs/organization-settings.md`
   §7 in the Dashboard).
3. Every Environment shows it once its Organization root has the new `main`:
   today after content synchronization; with relay delivery (below) within
   about two minutes.

## Failure modes

| Case | Result |
| --- | --- |
| The section breaks the contract (duplicate name, a module in two tabs, a 41-character name) | No tabs; the Workspace is one list, every module still there |
| A tab names modules that are not on this Environment | No tile for them; a tab left without any tile is not shown |
| A new module | Lands in the first tab until the Owner places it |
| The Owner's GitHub answer is late or fails | No editing actions (fail closed); everyone still sees the tabs |
| The Organization has no Dashboard page in the shell document | No editing actions |
| An older Dashboard or Environment meets `workspace.tabs` | The whole section is invalid to it; it keeps the settings it applied last. Rollout order below avoids it |

## Rollout order and next steps

1. Lazurio Core: add `workspace.tabs` to `organization-settings-lib.mjs` and
   the schema's `$defs.organizationSettings` (upstream of this contract).
2. This Platform change, released to the Organization's Environments.
3. Dashboard: validate the key, deliver it, and an editor in Nastavení
   Organizace → Moduly (create, rename, reorder, delete tabs; place modules),
   reached by `?tab=modules&focus=workspace-tabs[&module=<id>]`.
4. Only then does an Organization declare tabs.
5. Relay delivery (F45): the Launchpad prefers the recorded, delivered value
   on an Organization's Environment, so the change shows within minutes.

## Open questions

- Does the Owner arrange the tabs in the Dashboard (recommended, one writer),
  or directly in Apps? Moving in Apps would need either an Apps draft that
  the Dashboard publishes, or an amendment of root decision 0194 point 2.
- The first tab's suggested name when an Owner starts arranging: "Hlavní".
- Who besides the Owner may arrange: Stewards, as with "Přístup k modulu"?
- #428 (hiding auxiliary modules) is served by a tab such as "Správa"; a
  separate "hidden" state is not part of this.
