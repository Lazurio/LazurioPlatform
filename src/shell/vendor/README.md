# Vendored brand assets of the Lazurio shell

Byte-for-byte copies; never edited here. A change is a new copy from the pinned
source with new hashes in this file, reviewed like code (decision F36).
`tests/apps-view.test.ts` ("every vendored file has the hash its README records") checks every file below against its hash.

## Lazurio design system

Source: `HumanAndMachine-ai/design-system-lazurio` at commit
`5bbc1f78fc5a10f0dcf8936bf54d27da2e2eeafb` (2026-10-04, "Prvky: selection is a
quiet surface; picker and Organization head (variant A) (#54)"). That commit
changed only `components.css` and the prvky documentation: the bytes of every
file below are the same as at the earlier pin
`4439aef645b7432181216aab3799d7f7819d6592` and at
`089d6cfbb5386a00e4a9f296f9f10b2901668f11`, the commit the first shell
wireframe vendored. The shell draws its own components from the tokens and
mirrors #54's rules (`lz-picker`, `lz-menu__head`, the quiet selected
surface) in `src/shell/styles.ts`. Matěj allowed publishing these brand assets
in this public repository (2026-10-03).

| File | Source path | SHA-256 |
| --- | --- | --- |
| `lazurio/tokens.css` | `tokens.css` | `0e12009f1991993727385308e4cc8cbeb8a0afee28287475d778c96aff09e4ed` |
| `lazurio/symbol-color.svg` | `content/brand/logo/symbol-color.svg` | `657d021e5fab5f28df6b10488d68f567149783ec51d44f44ba18b129ce9c1941` |

Only the tokens, the logo symbol and the module stones (below) are vendored:
the shell and the Launchpad page draw their own components from the tokens, so
`components.css` is not needed. The tokens declare their values on `:root`; inside a shadow root the
shell applies the same text to `:host` (`src/shell/styles.ts`), so the file
stays byte-for-byte and the tokens work inside the elements, as the design
system asks for the rail in the forks.

## Module stones

The design system's Lazurio stones (`content/brand/icons/*-96.png`, Lazurio's own
artwork, 96 × 96 px, drawn at 48 × 48 on a tile and 20 × 20 in a list), byte-for-byte
from the same commit (unchanged since `4439aef645b7432181216aab3799d7f7819d6592`). `src/shell/stones.ts`
picks one by a generic semantic key only (the app's declared `icon`, or the
org-agnostic fallback of the root Launchpad), never by an Organization or a
module's name, as `content/brand/icons/icons.md` and the root Launchpad's
`launchpad/public/app-icons/lazurio/README.md` require.

| File | Source path | SHA-256 |
| --- | --- | --- |
| `stones/brainstorm-96.png` | `content/brand/icons/brainstorm-96.png` | `9dadbe8fc531ecbde2b72bcaaf4dbf7ef863065534df8b00a096b49014ae2453` |
| `stones/clients-96.png` | `content/brand/icons/clients-96.png` | `b5464469cb9957d5d7f3252119ae546decc6fdd91c409d208e132dd214d50f6c` |
| `stones/content-96.png` | `content/brand/icons/content-96.png` | `655fd8310b1094cb5c3e434071bbdc0b4b263cca15803ca6c03fcf8b8f13754d` |
| `stones/deals-96.png` | `content/brand/icons/deals-96.png` | `54f89c003d5155a25b1ee4e04ef45c1a73c7fa7ca49928b539b1f20861da3aa6` |
| `stones/guide-96.png` | `content/brand/icons/guide-96.png` | `e228601424c4f630d0bb2a556f806467203bc1891b97abff3d1e762ecb804836` |
| `stones/invoices-96.png` | `content/brand/icons/invoices-96.png` | `4442cd37d0d5279fa2aaa62fa235e8867049872b36d1d799c5f8ad5963cf5c16` |
| `stones/knowledgebase-96.png` | `content/brand/icons/knowledgebase-96.png` | `5ddbc3c440af249093b497ba08b449ead6c306dd0ff7f608e5a21e44ad04af74` |
| `stones/lazurio-design-system-96.png` | `content/brand/icons/lazurio-design-system-96.png` | `bb4cc9c78b5e83813ff4fa6736a8633a733ec8c8ea8e4fa4429bf8a7ca156418` |
| `stones/mission-control-96.png` | `content/brand/icons/mission-control-96.png` | `1e91a80054049ac0a3dfa984a105536b37ddf34f47726ed00d09559a76b7ac1a` |
| `stones/presentation-96.png` | `content/brand/icons/presentation-96.png` | `0c77dbbaa25726035fb9f9ac534f4e532e68f85fcf6e2f363e3b77f20644246d` |
| `stones/pricebook-96.png` | `content/brand/icons/pricebook-96.png` | `760a4913432987a9a68944880a47c21b0c6e7d8cc8af6fb875b42467c082216c` |
| `stones/settings-96.png` | `content/brand/icons/settings-96.png` | `79b0857e7cbdcd6137e13ad1751ed2353a523378aa29c5b5592b77f6700afd1f` |
| `stones/website-lazurio-96.png` | `content/brand/icons/website-lazurio-96.png` | `b107e0950ebb7d555619735cd6b7d82f3fcb2b2464eed3778582f230dc79c731` |

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
the shell wireframe draws it (`HumanAndMachine-ai/prototypes-lazurio` 1cbad15,
`app/v1/src/Icon.tsx`, `iconoir-react` 7.12.1) into `src/shell/icons.ts` and the
page's inlined symbols. The page's `i-browser` (the right panel's Browser
toggle), which the wireframe does not draw, is Iconoir's `app-window` exactly
as `iconoir-react` 7.12.1 ships it (`AppWindow`). Iconoir's licence is copied
byte-for-byte from the design system at the pinned commit
(`content/brand/icons/LICENSE-iconoir.txt`).

| File | Source path | SHA-256 |
| --- | --- | --- |
| `LICENSE-iconoir.txt` | `content/brand/icons/LICENSE-iconoir.txt` | `869b60da1ada5b896d1f285c3c24ca193d612e308d1710a77a58f2f572eb4fa2` |
