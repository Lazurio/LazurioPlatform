# Vendored assets of Buddy's frame

Byte-for-byte copies; never edited here. A change is a new copy from the pinned
source with its new hash in this file, reviewed like code (as `src/shell/vendor/`).
`tests/buddy-frame-server.test.ts` checks the file against its hash.

## Mattyčus, Buddy's default avatar

Source: `HumanAndMachine-ai/design-system-lazurio` at commit
`e02712ce857dc450ce833f9f681430eaef2448b6`, where the file is unchanged since
`90bec10f6c606121e09b77b72d95c8442844b681` (2026-08-26, "Brand: establish Mattycus as
the default Buddy identity"). Its manifest, `content/brand/buddy/assets.json`, names it
the static idle frame for a fast first render of Buddy surfaces, 192 × 208 px, one frame
of the spritesheet the root Guide shows (`guide/app/v1/public/assets/mattycus/`).

| File | Source path | Bytes | SHA-256 |
| --- | --- | --- | --- |
| `mattycus-idle.png` | `content/brand/buddy/mattycus-idle.png` | 40375 | `5ea4b58dececcac9aad2d83000734e551320bd043c6a1e6358b3a5559a48b5bc` |

Human and Machine's own artwork, already public in the root repository's Guide. The
design system's consumer rules hold here (`content/brand/buddy/buddy.md`): Mattyčus
appears only on Buddy and Guide surfaces and only where a Buddy is configured, which
the frame always is; the raster is never redrawn, smoothed or re-proportioned, so it is
the design system's own frame and not one cut from the spritesheet here; it is shown
in its proportions and enlarged only by whole multiples with
`image-rendering: pixelated`. The frame serves it
as `/assets/avatar.webp`, the avatar's stable address for the shell's launcher, with
its true type `image/png`.
