import { encode } from "uqr";

// A QR code the operator can actually scan (decision F19): the WhatsApp
// pairing payload of wacli, drawn by the Launchpad as crisp SVG on white and
// by the CLI with Unicode half blocks on an explicitly white background, so a
// dark terminal theme does not invert it. The encoder is `uqr` (MIT, no
// dependencies, a port of Project Nayuki's reference-quality generator); this
// module owns only the drawing.

export type QrMatrix = Readonly<{
  version: number;
  size: number;
  maskPattern: number;
  /** Row-major, `true` is a dark module; without the quiet zone. */
  modules: readonly (readonly boolean[])[];
}>;

/** The ISO/IEC 18004 quiet zone, in modules. */
export const qrQuietZone = 4;

export function qrMatrix(
  payload: string,
  options: Readonly<{
    ecc?: "L" | "M" | "Q" | "H";
    maskPattern?: number;
  }> = {},
): QrMatrix {
  if (payload.length === 0 || payload.length > 2048)
    throw new Error("A QR payload of 1 to 2048 characters is required");
  const result = encode(payload, {
    ecc: options.ecc ?? "M",
    border: 0,
    ...(options.maskPattern === undefined
      ? {}
      : { maskPattern: options.maskPattern }),
  });
  return {
    version: result.version,
    size: result.size,
    maskPattern: result.maskPattern,
    modules: result.data.map((row) => [...row]),
  };
}

/** A standalone SVG: white background including the quiet zone, one black
 * path, crisp edges, no text, no script and nothing from the payload but the
 * modules. The viewBox is in modules; the page sizes it. */
export function qrSvg(matrix: QrMatrix): string {
  const side = matrix.size + 2 * qrQuietZone;
  const runs: string[] = [];
  matrix.modules.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < row.length && row[x]) x++;
      runs.push(
        `M${start + qrQuietZone} ${y + qrQuietZone}h${x - start}v1h-${x - start}z`,
      );
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges"><rect width="${side}" height="${side}" fill="#fff"/><path fill="#000" d="${runs.join("")}"/></svg>`;
}

/** Terminal lines: two module rows per line with half blocks, black on an
 * explicit bright white background (ANSI 30;107) including the quiet zone,
 * so it reads the same on dark and light themes. */
export function qrTerminal(matrix: QrMatrix): string[] {
  const side = matrix.size + 2 * qrQuietZone;
  const dark = (x: number, y: number) =>
    matrix.modules[y - qrQuietZone]?.[x - qrQuietZone] === true;
  const lines: string[] = [];
  for (let y = 0; y < side; y += 2) {
    let line = "";
    for (let x = 0; x < side; x++) {
      const top = dark(x, y);
      const bottom = y + 1 < side && dark(x, y + 1);
      line += top ? (bottom ? "█" : "▀") : bottom ? "▄" : " ";
    }
    lines.push(`\u001b[30;107m${line}\u001b[0m`);
  }
  return lines;
}
