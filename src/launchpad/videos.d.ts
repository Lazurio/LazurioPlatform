// A guide video or its poster imported with `{ type: "file" }` (Bun): its
// path, embedded in a compiled executable (guide-video-files.ts).
declare module "*.mp4" {
  const value: string;
  export default value;
}
declare module "*.webp" {
  const value: string;
  export default value;
}
