# Vendored brand assets of the Lazurio shell

Byte-for-byte copies; never edited here. A change is a new copy from the pinned
source with new hashes in this file, reviewed like code (decision F36).
`tests/apps-view.test.ts` ("every vendored file has the hash its README records") checks every file below against its hash.

## Lazurio design system

Source: `HumanAndMachine-ai/design-system-lazurio` at commit
`fdcc9b40ba29e334cf0d5187dd73ea99d7ff63fd` (2026-10-06, "Prvky: compact menu
item; the picker carries no Organization head; a check without the word
(#62)"). Since the previous pin `5bbc1f78fc5a10f0dcf8936bf54d27da2e2eeafb`
(#54) only `tokens.css` of the files below changed, in #58 and #59 (Anička,
2026-10-04): the comment on the radii now names three radii, one per kind of
thing (`radius-xs` fields, `radius-sm` controls and marks, `radius-md`
free-standing objects), and the token `--lz-shadow-float` (0 8px 24px, ink at
10 %) is new, the one shadow of a layer floating above the page. The logo
symbol, the stones and Iconoir's licence are byte-for-byte as before. The
shell draws its own components from the tokens and mirrors the design
system's rules in `src/shell/styles.ts`: #54's selection (`lz-picker`, the
quiet selected surface), #57's rail (B3, `lz-rail`), #58's three radii, #59's
floating layer and paper frame, and #62's compact menu item
(`lz-menu-item--compact`, the check with its word for screen readers only,
`lz-menu__head` only in the jump to any Environment). Matěj allowed publishing
these brand assets in this public repository (2026-10-03).

| File | Source path | SHA-256 |
| --- | --- | --- |
| `lazurio/tokens.css` | `tokens.css` | `a8e4be9f818a896537ccac7dd6a97fa58985ca4a05842b804e2eae2ab4093251` |
| `lazurio/symbol-color.svg` | `content/brand/logo/symbol-color.svg` | `657d021e5fab5f28df6b10488d68f567149783ec51d44f44ba18b129ce9c1941` |
| `lazurio/lockup-color.svg` | `content/brand/logo/lockup-color.svg` | `56148f482211a3bdb62311ccabb9f943f61440c7b2c23101f120fb1e0f02aefe` |

The lockup was added on 2026-10-17 from the same pinned commit, where it is
byte-for-byte the file on the design system's `main` of that day (unchanged since
the pin). It is the Launchpad page's, not the shell's: the band on top of its left
column (Apps and Settings, decision F36's addendum of 2026-10-17) draws it whole at
its smallest size, 18 px tall, as `content/brand/logo/logo.md` requires; it is never
rebuilt from the symbol and a word. The shell elements draw only the symbol.

Only the tokens, the logo symbol, the lockup and the module stones (below) are vendored:
the shell and the Launchpad page draw their own components from the tokens, so
`components.css` is not needed. The tokens declare their values on `:root`; inside a shadow root the
shell applies the same text to `:host` (`src/shell/base-styles.ts`), so the file
stays byte-for-byte and the tokens work inside the elements, as the design
system asks for the rail in the forks.

Since F36's addendum of 2026-10-13 (root decision 0200) the shell also puts the
file, without its comments, on the root of an app's document that has no tokens
of its own, marked `data-lazurio-theme="light"` (`src/shell/tokens.ts`): the
T3 Code fork maps its standard light look onto a short list of its names
(`declares.tokens` in `src/shell/interface.ts`). A new copy therefore reaches
every Environment's apps with the Platform. Both uses rely on the file's shape,
and `tests/shell-tokens.test.ts` fails when a copy is anything but one `:root`
rule of `--lz-*` custom properties, or lacks a promised name (dropping or
renaming one is an interface change, decided and announced first, not a
re-vendor). A changed value, a new name, or a change to a name nobody is
promised needs no other edit. Since F36's addendum of 2026-10-18 (root decision
0208) the shell ends that text with one rule of its own, `:root {
--lazurio-color-scheme: light; }`, the scheme of the values, and the
Environment's theme gives the promised colour names other values over them; the
theme Lazurio is this file's own values (`src/theme/palettes.ts`), so a new copy
reaches it too.

## Module stones

The design system's Lazurio stones (`content/brand/icons/*-96.png`, Lazurio's own
artwork, 96 × 96 px, drawn at 48 × 48 on a tile and 20 × 20 in a list), byte-for-byte
from `HumanAndMachine-ai/design-system-lazurio` at commit
`190e735c9c4ad2e2910ada07768191c6c5a0e983` (2026-10-11, "Prvky: Module stones on a
transparent background", #76): the surrounding of every stone is transparent instead
of a baked-in off-white square, so the stone alone sits on any surface; the stone
and its symbol are unchanged. `src/shell/stones.ts`
picks one by a generic semantic key only (the app's declared `icon`, or the
org-agnostic fallback of the root Launchpad), never by an Organization or a
module's name, as `content/brand/icons/icons.md` and the root Launchpad's
`launchpad/public/app-icons/lazurio/README.md` require.

| File | Source path | SHA-256 |
| --- | --- | --- |
| `stones/brainstorm-96.png` | `content/brand/icons/brainstorm-96.png` | `81b3e063e4ba41703d1f7a3729b462bd5168126fada3a61a2d4726dcbc5dc2ab` |
| `stones/clients-96.png` | `content/brand/icons/clients-96.png` | `ba430854d9cca2cbc966d1ae8d5d5227a276de9a507737bb13a7064e07885f4b` |
| `stones/content-96.png` | `content/brand/icons/content-96.png` | `3abfcd00573c073aba9c6398820267977aadd9bd9a21201cf3da69b48311d66f` |
| `stones/deals-96.png` | `content/brand/icons/deals-96.png` | `b198ecb48cff559d48bdffca9bd4ca6eb8b2a77b4db9913c1bdcc49cfc174aea` |
| `stones/guide-96.png` | `content/brand/icons/guide-96.png` | `e0deb1ac7e0dd695b3ee60115844743bb8f4c55ef67e2a1081fe51c91f7ff43a` |
| `stones/invoices-96.png` | `content/brand/icons/invoices-96.png` | `4ec8e212266ef58df65de0a531ac5626655064a73cfb9dea37377b682cdb79e9` |
| `stones/knowledgebase-96.png` | `content/brand/icons/knowledgebase-96.png` | `8457375f3e8ff9c7e83c1fc317e93024b71a5f96068fdb9e3ccb5798df67a264` |
| `stones/lazurio-design-system-96.png` | `content/brand/icons/lazurio-design-system-96.png` | `dd2a80f3be54bf846efa5bddd20899f065b53da9c3d8d6b0811ea7e9df993551` |
| `stones/mission-control-96.png` | `content/brand/icons/mission-control-96.png` | `e22f7a5f8cf4298884cb8b02c9972c039d666e6378d0f6319eeca162f8280bca` |
| `stones/presentation-96.png` | `content/brand/icons/presentation-96.png` | `ebe0d2511ea30d2f84ddb6a5a0eecc3288dd165de52c61dd9b215a6f1544dc5a` |
| `stones/pricebook-96.png` | `content/brand/icons/pricebook-96.png` | `6461b920fe470539883cf8203477d42a03dcfeddc92c1337645909e3f266ebd5` |
| `stones/settings-96.png` | `content/brand/icons/settings-96.png` | `76c4a0ed829370a4c952c0ee645a9ffd931ace8b746c3d603a40844e36171838` |
| `stones/website-lazurio-96.png` | `content/brand/icons/website-lazurio-96.png` | `0507f7f7012f05164144c254729dd7db844f4f4e7fc971ed3d7a54f8194a55b0` |

## Fonts

The design system's type is Inter Tight (variable) with Geist Mono
(`--lz-font-sans`, `--lz-font-mono` in `tokens.css`); the wireframe hosts both
from Fontsource. Only the Latin and Latin Extended subsets (Czech needs the
latter) of the upright styles are vendored. Both fonts are under the SIL Open
Font License 1.1, whose text is copied next to them.

Source: the npm tarballs `@fontsource-variable/inter-tight@5.3.0`
(integrity `sha512-ZhZZ29sNZ15P1K+cUt13GeBRYON0akgmNiftshUeDLos7X7zGcRgPzt434879Xhq1QbwlW3M/apBMk7jWabwvA==`)
and `@fontsource/geist-mono@5.3.0`
(integrity `sha512-UtJ1BBBCVpMYdIcW7nEB45UAoAw5M53ZXs2t0ciPW+IokuAAIc56M8+kW5tXbRJCTpDw4XTtU7proT6NdQAHTg==`),
files from `package/files/` and `package/LICENSE`.

| File | SHA-256 |
| --- | --- |
| `fonts/inter-tight-latin-wght-normal.woff2` | `77fefe8ca19b9f69b5284832c519e0493127c1f091f0a8936884be7721c4e618` |
| `fonts/inter-tight-latin-ext-wght-normal.woff2` | `fd9beddaaec644945809da574cf1caf342073c7e4b46a2ea5bd136c8cf1a9eca` |
| `fonts/geist-mono-latin-400-normal.woff2` | `3f98383b122fe015a48536cd4a1cda855a201718923ffe74931a01597107b9b5` |
| `fonts/geist-mono-latin-ext-400-normal.woff2` | `8ede9cb664d0e0446ed066201d58e444f6147645ae0cb1108f765f68c54fe0a4` |
| `fonts/LICENSE-inter-tight.txt` | `1e1c8b3dc6dfcbd5498a33f17fcc68ff2d39c599f6e8195fbf14601261dbef6a` |
| `fonts/LICENSE-geist-mono.txt` | `cc815ed4fc045f0e991abb10395b7932bd028c6a067deb13316d6002105074e6` |

## Interface icons

The shell and the Launchpad page draw their interface icons from Iconoir
(MIT, https://iconoir.com), the set the design system mandates for the
interface (`content/brand/icons/icons.md`). The path data is copied exactly as
the shell wireframe draws it (`HumanAndMachine-ai/prototypes-lazurio` 1acd615,
`app/v1/src/Icon.tsx`, `iconoir-react` 7.12.1), at the wireframe's stroke of
1.6, into `src/shell/icons.ts` and the page's inlined symbols. The page's `i-browser` (the right panel's Browser
toggle), which the wireframe does not draw, is Iconoir's `app-window` exactly
as `iconoir-react` 7.12.1 ships it (`AppWindow`). Iconoir's licence is copied
byte-for-byte from the design system at the pinned commit
(`content/brand/icons/LICENSE-iconoir.txt`).

| File | Source path | SHA-256 |
| --- | --- | --- |
| `LICENSE-iconoir.txt` | `content/brand/icons/LICENSE-iconoir.txt` | `869b60da1ada5b896d1f285c3c24ca193d612e308d1710a77a58f2f572eb4fa2` |

## Svěží palette refresh (2026-10-19)

`tokens.css` is a byte-for-byte copy from `HumanAndMachine-ai/design-system-lazurio`
commit `f3eb7117e81ea52b341a03b0d45a8842a9b81525` (reviewed PR #99). Success, warning and danger
use the approved semantic foreground, background and border values. Other assets
retain the provenance recorded above.
