import { gunzipSync } from "node:zlib";

// An independent reader of the release's shell artifact (`lazurio-shell.tar.gz`,
// scripts/release-shell.ts): the entries of a gzipped POSIX ustar archive with
// the header fields a host relies on, as tests/shell-artifact.test.ts and
// tests/browser-contract-artifact.test.ts read the archive.

export type TarEntry = Readonly<{
  header: Readonly<{
    path: string;
    mode: number;
    uid: number;
    gid: number;
    mtime: number;
    type: string;
    magic: string;
    owner: string;
    group: string;
  }>;
  data: Uint8Array;
}>;

/** The entries of the archive as an independent reader sees them. */
export function tarEntries(archive: Uint8Array): TarEntry[] {
  const tar = new Uint8Array(gunzipSync(archive));
  const text = (block: Uint8Array, start: number, length: number) => {
    const bytes = block.subarray(start, start + length);
    const end = bytes.indexOf(0);
    return new TextDecoder().decode(
      end === -1 ? bytes : bytes.subarray(0, end),
    );
  };
  const octal = (block: Uint8Array, start: number, length: number) =>
    Number.parseInt(text(block, start, length), 8);
  const found: TarEntry[] = [];
  for (let at = 0; at + 512 <= tar.length; ) {
    const block = tar.subarray(at, at + 512);
    if (block.every((byte) => byte === 0)) break;
    const size = octal(block, 124, 12);
    found.push({
      header: {
        path: text(block, 0, 100),
        mode: octal(block, 100, 8),
        uid: octal(block, 108, 8),
        gid: octal(block, 116, 8),
        mtime: octal(block, 136, 12),
        type: text(block, 156, 1),
        magic: new TextDecoder().decode(block.subarray(257, 265)),
        owner: text(block, 265, 32),
        group: text(block, 297, 32),
      },
      data: tar.subarray(at + 512, at + 512 + size),
    });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return found;
}
