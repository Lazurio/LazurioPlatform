import { expect, test } from "bun:test";
import { qrMatrix, qrQuietZone, qrSvg, qrTerminal } from "../src/tools/qr";

// Reference matrices from two independent encoders (python-qrcode 8 and
// segno 1.6 for HELLO WORLD; python-qrcode for the URL, where segno's own
// mask evaluation differs), with the version, level and mask fixed. Dark = 1.
const helloWorld1Q = [
  "111111100001001111111",
  "100000100100001000001",
  "101110100100101011101",
  "101110101101001011101",
  "101110100111001011101",
  "100000101111001000001",
  "111111101010101111111",
  "000000001101000000000",
  "011000100101101101000",
  "000101011010010111011",
  "011000100011011110010",
  "001110000110000000100",
  "110111111110111011111",
  "000000001000011101111",
  "111111100111010000110",
  "100000100000111000010",
  "101110100111011010101",
  "101110100000000001000",
  "101110101100001000011",
  "100000101110100100001",
  "111111100100001001011",
];
const deviceUrl3M = [
  "11111110111001101110001111111",
  "10000010010001110011001000001",
  "10111010001110100111101011101",
  "10111010101100000010001011101",
  "10111010101000000110001011101",
  "10000010101110001101001000001",
  "11111110101010101010101111111",
  "00000000111001011101100000000",
  "10001011110001000110111111001",
  "01001000001111101110011111111",
  "00011110111100001010001100001",
  "01111100000000100110101111011",
  "00010110100101111100110000010",
  "01111001111110000010001111111",
  "10111110010101110110111101101",
  "01011000111011011101110000011",
  "11010111010101000100100100010",
  "10001000001001101010101111011",
  "00110110000000001110100000101",
  "00011101101000100110110110011",
  "11101011011001110100111111001",
  "00000000111010000001100010001",
  "11111110101111110011101011101",
  "10000010000111010101100010000",
  "10111010101001000101111111011",
  "10111010001000111110010000010",
  "10111010000100010101110001111",
  "10000010000011101110111011011",
  "11111110101100100100111111010",
];

const bits = (matrix: ReturnType<typeof qrMatrix>) =>
  matrix.modules.map((row) => row.map((dark) => (dark ? "1" : "0")).join(""));

test("the encoder matches independent reference matrices", () => {
  const hello = qrMatrix("HELLO WORLD", { ecc: "Q", maskPattern: 1 });
  expect([hello.version, hello.size, hello.maskPattern]).toEqual([1, 21, 1]);
  expect(bits(hello)).toEqual(helloWorld1Q);
  const url = qrMatrix("https://github.com/login/device", {
    ecc: "M",
    maskPattern: 4,
  });
  expect([url.version, url.size, url.maskPattern]).toEqual([3, 29, 4]);
  expect(bits(url)).toEqual(deviceUrl3M);
});

test("a WhatsApp-sized payload encodes at level M with an automatic mask", () => {
  const payload = `2@${"A".repeat(60)},${"b".repeat(44)}=,${"c".repeat(44)}=,${"d".repeat(44)}=`;
  const matrix = qrMatrix(payload);
  expect(matrix.version).toBeGreaterThanOrEqual(8);
  expect(matrix.version).toBeLessThanOrEqual(12);
  expect(matrix.size).toBe(17 + 4 * matrix.version);
  expect(qrMatrix(payload)).toEqual(matrix);
  expect(() => qrMatrix("")).toThrow();
  expect(() => qrMatrix("x".repeat(2049))).toThrow();
});

test("the SVG is white with a quiet zone, one black path, and nothing else", () => {
  const matrix = qrMatrix("HELLO WORLD", { ecc: "Q", maskPattern: 1 });
  const svg = qrSvg(matrix);
  const side = matrix.size + 2 * qrQuietZone;
  expect(svg).toMatch(
    new RegExp(
      `^<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges"><rect width="${side}" height="${side}" fill="#fff"/><path fill="#000" d="[Mhvz0-9 -]+"/></svg>$`,
    ),
  );
  // The path covers exactly the dark modules, offset by the quiet zone.
  const dark = new Set<string>();
  for (const run of svg.matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g))
    for (let x = 0; x < Number(run[3]); x++)
      dark.add(
        `${Number(run[1]) + x - qrQuietZone},${Number(run[2]) - qrQuietZone}`,
      );
  const expected = new Set<string>();
  for (const [y, row] of matrix.modules.entries())
    for (const [x, on] of row.entries()) if (on) expected.add(`${x},${y}`);
  expect(dark).toEqual(expected);
});

test("the terminal drawing is half blocks on an explicit white background with a quiet zone", () => {
  const matrix = qrMatrix("HELLO WORLD", { ecc: "Q", maskPattern: 1 });
  const lines = qrTerminal(matrix);
  const side = matrix.size + 2 * qrQuietZone;
  expect(lines).toHaveLength(Math.ceil(side / 2));
  for (const line of lines) {
    expect(line.startsWith("\u001b[30;107m")).toBe(true);
    expect(line.endsWith("\u001b[0m")).toBe(true);
  }
  const cells = lines.map((line) =>
    Array.from(line.slice("\u001b[30;107m".length, -"\u001b[0m".length)),
  );
  for (const row of cells) expect(row).toHaveLength(side);
  // The quiet zone is blank: two full lines on top, four columns each side.
  expect(cells[0]?.every((cell) => cell === " ")).toBe(true);
  expect(cells[1]?.every((cell) => cell === " ")).toBe(true);
  for (const row of cells) expect(row.slice(0, 4).join("")).toBe("    ");
  // Each cell is the pair of module rows it stands for.
  const at = (x: number, y: number) =>
    matrix.modules[y - qrQuietZone]?.[x - qrQuietZone] === true;
  for (const [line, row] of cells.entries())
    for (const [x, cell] of row.entries()) {
      const top = at(x, 2 * line);
      const bottom = at(x, 2 * line + 1);
      expect(cell).toBe(top ? (bottom ? "█" : "▀") : bottom ? "▄" : " ");
    }
});
