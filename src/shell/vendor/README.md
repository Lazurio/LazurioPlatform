# Vendored brand assets of the Lazurio shell

Byte-for-byte copies; never edited here. A change is a new copy from the pinned
source with new hashes in this file, reviewed like code (decision F36).
`tests/shell-vendor.test.ts` checks every file below against its hash.

## Lazurio design system

Source: `HumanAndMachine-ai/design-system-lazurio` at commit
`4439aef645b7432181216aab3799d7f7819d6592` (2026-10-03, "Prvky: Describe the
Environment rail target of 2026-10-03 (#53)"). The bytes of both files are the
same at `089d6cfbb5386a00e4a9f296f9f10b2901668f11`, the commit the shell
wireframe (`prototypes-lazurio`, branch `agent/DEV-6639-shell-iteration-2`)
vendors. Matěj allowed publishing these brand assets in this public repository
(2026-10-03).

| File | Source path | SHA-256 |
| --- | --- | --- |
| `lazurio/tokens.css` | `tokens.css` | `0e12009f1991993727385308e4cc8cbeb8a0afee28287475d778c96aff09e4ed` |
| `lazurio/symbol-color.svg` | `content/brand/logo/symbol-color.svg` | `657d021e5fab5f28df6b10488d68f567149783ec51d44f44ba18b129ce9c1941` |

Only the tokens and the logo symbol are vendored: the shell and the Launchpad
page draw their own components from the tokens, so `components.css` is not
needed. The tokens declare their values on `:root`; inside a shadow root the
shell applies the same text to `:host` (`src/shell/styles.ts`), so the file
stays byte-for-byte and the tokens work inside the elements, as the design
system asks for the rail in the forks.

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
