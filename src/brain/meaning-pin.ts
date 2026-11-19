import { join } from "node:path";

// Search by meaning in the person's memory (plan LZD-0033 R11a): a local
// embedding model, pinned per Platform release like GBrain itself, each file
// by its SHA-256. Measured on a Personal Environment of 4 vCPU and 8 GB:
// 168 to 244 MB in memory, no processor at rest, about 725 tokens a second
// for the first embedding, an agent's turn not slowed down.

export type MeaningPin = Readonly<{
  /** llama.cpp's server, one release for Linux on x86-64. */
  server: Readonly<{ build: string; url: string; sha256: string }>;
  /** The embedding model, a GGUF file. */
  model: Readonly<{ name: string; url: string; sha256: string }>;
  /** What gbrain calls the provider and model, and its width. */
  provider: string;
  dimensions: number;
}>;

export const meaningPin: MeaningPin = Object.freeze({
  server: Object.freeze({
    build: "b12119",
    url: "https://github.com/ggml-org/llama.cpp/releases/download/b12119/llama-b12119-bin-ubuntu-x64.tar.gz",
    sha256: "b766529b1a5082c65b9dc5a5f1a78092c6e107344dc383c53a00b83da47c16a6",
  }),
  model: Object.freeze({
    name: "nomic-embed-text-v1.5.Q8_0.gguf",
    url: "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5.Q8_0.gguf",
    sha256: "3e24342164b3d94991ba9692fdc0dd08e3fd7362e0aacc396a9a5c54a544c3b7",
  }),
  provider: "llama-server:nomic-embed-text-v1.5",
  dimensions: 768,
});

export const meaningPort = 3132;
/** Embedding requests gbrain sends the local model at once (its default of
 * 20 times out on 4 vCPU). */
export const meaningConcurrency = 2;
export const meaningUrl = `http://127.0.0.1:${meaningPort}`;
export const meaningUnit = "lazurio-gbrain-meaning.service";

export type MeaningPaths = Readonly<{
  /** One directory per server build, the release unpacked in it. */
  server: string;
  /** The model file, named by its digest. */
  model: string;
}>;

export function meaningPaths(home: string): MeaningPaths {
  const root = join(home, ".local", "share", "lazurio-gbrain-meaning");
  return Object.freeze({
    server: join(root, meaningPin.server.build),
    model: join(root, "models", `${meaningPin.model.sha256}.gguf`),
  });
}
