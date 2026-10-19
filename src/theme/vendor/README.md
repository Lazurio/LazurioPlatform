# T3 Code's built-in themes, vendored

Byte-for-byte copies; never edited here. A change is a new copy from the pinned
source with new hashes in this file, reviewed like code (root decision 0208, F36's
addendum of 2026-10-18). `tests/theme-palettes.test.ts` ("every vendored file has the
hash its README records") checks every file below against its hash.

Source: `Lazurio/t3code`, the T3 Code fork of the Lazurio distribution, at its
release tag `v0.1.0-lazurio.2` (commit `9a38526c145747f4aafb974170b4cd2c55063fe1`,
2026-10-17). The palette file there is byte for byte upstream T3 Code's `v0.1.0`
(commit `81493efb71e8e8244f95d3e9f71d8369654ab151`): the fork's overlay does not touch
it. T3 Code is under the MIT License, Copyright (c) 2026 T3 Tools Inc.; its licence is
copied next to the file, byte for byte from the same tag.

| File | Source path | SHA-256 |
| --- | --- | --- |
| `t3code/themePalettes.ts` | `packages/shared/src/themePalettes.ts` | `a6fb0f8276608dfc8ba5edc94a786e9e6b436abb9604e38f8eff5f4898b92367` |
| `t3code/LICENSE` | `LICENSE` | `935d8f2af0c703f9c39517ee57cc4930b19d02d533be930b63f0e82f93614b43` |

What is used: the four built-in palettes Grove, Ocean, Ember and Iris and
`getThemeColorsForAppearance`, through the projection in `src/theme/palettes.ts`. T3
Chat (`T3_CHAT_THEME`), T3's own brand palette, is not offered (root decision 0208
point 2), and nothing else of the file is used. The file is imported as it is: the
repository's TypeScript checks it, Biome skips this directory (`biome.json`). Only the
Launchpad's server and the CLI carry it; the shell's script and the Launchpad page get
the projected values, never the file.

Re-vendor at each rebuild of the T3 Code fork: the new tag and hashes here, then the
tests of `tests/theme-palettes.test.ts`, whose contrast checks decide whether a
palette's changed values may ship.
