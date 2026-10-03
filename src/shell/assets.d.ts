// A font file imported with `{ type: "file" }` (Bun): its path, embedded in
// a compiled executable.
declare module "*.woff2" {
  const value: string;
  export default value;
}
// A stone imported with `{ type: "file" }`: its path, as above.
declare module "*.png" {
  const value: string;
  export default value;
}
