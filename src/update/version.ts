import { isProductVersion } from "./identity";

/** Semantic Versioning 2.0.0 precedence for the product's version grammar
 * (no build metadata). Returns <0, 0 or >0. "Never downgrades" depends on this
 * being total and exact, so invalid input is refused instead of compared.
 */
export function compareVersions(left: string, right: string): number {
  if (!isProductVersion(left) || !isProductVersion(right))
    throw new Error("Invalid product version");
  const split = (value: string) => {
    const dash = value.indexOf("-");
    const core = (dash === -1 ? value : value.slice(0, dash))
      .split(".")
      .map(Number);
    const pre = dash === -1 ? [] : value.slice(dash + 1).split(".");
    return { core, pre };
  };
  const a = split(left);
  const b = split(right);
  for (let index = 0; index < 3; index++) {
    const difference = (a.core[index] as number) - (b.core[index] as number);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  // A release outranks any of its pre-releases.
  if (a.pre.length === 0 || b.pre.length === 0)
    return a.pre.length === b.pre.length ? 0 : a.pre.length === 0 ? 1 : -1;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index++) {
    const x = a.pre[index];
    const y = b.pre[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      // Identifiers may exceed 2^53; compare by length, then lexically. The
      // product grammar tolerates leading zeros, which carry no value.
      const p = x.replace(/^0+(?=\d)/, "");
      const q = y.replace(/^0+(?=\d)/, "");
      if (p.length !== q.length) return p.length < q.length ? -1 : 1;
      if (p !== q) return p < q ? -1 : 1;
    } else if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
