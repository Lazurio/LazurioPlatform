import { join } from "node:path";
import type { BrainState } from "./keys";

// Search by meaning in the person's memory (plan LZD-0033 R11a): a local
// embedding model, pinned per Platform release like GBrain itself, each file
// by its SHA-256. Matěj chose the multilingual bge-m3 on 2026-11-19, since a
// search that finds nothing in Czech would not help people: on 24 Czech
// questions sharing no word with their pages it put the right page first 23
// times (the earlier nomic-embed-text 5 times). Measured on a Personal
// Environment of 4 vCPU and 8 GB: 756 to 886 MB in memory, at least 4.4 GB
// of the Environment left free, a query by meaning in 0.3 to 0.4 s, the first
// embedding of a brain like the largest measured one in 8.6 minutes, an
// agent's turn not slowed down. Before the wave to people it is verified on
// one customer-class Environment.

export type MeaningPin = Readonly<{
  /** llama.cpp's server, one release for Linux on x86-64. */
  server: Readonly<{ build: string; url: string; sha256: string }>;
  /** The embedding model, a GGUF file. */
  model: Readonly<{ name: string; url: string; sha256: string }>;
  /** What gbrain calls the provider and model, and its width. */
  provider: string;
  dimensions: number;
  /** How llama-server pools a text into one vector, and its context. */
  pooling: "cls" | "mean";
  context: number;
}>;

export const meaningPin: MeaningPin = Object.freeze({
  server: Object.freeze({
    build: "b12119",
    url: "https://github.com/ggml-org/llama.cpp/releases/download/b12119/llama-b12119-bin-ubuntu-x64.tar.gz",
    sha256: "b766529b1a5082c65b9dc5a5f1a78092c6e107344dc383c53a00b83da47c16a6",
  }),
  model: Object.freeze({
    name: "bge-m3-Q8_0.gguf",
    url: "https://huggingface.co/gpustack/bge-m3-GGUF/resolve/main/bge-m3-Q8_0.gguf",
    sha256: "950f4a8e5e19477a6d3c26d2f162233c20002c601f75e4b002e3239997821167",
  }),
  provider: "llama-server:bge-m3",
  dimensions: 1024,
  pooling: "cls",
  context: 4096,
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

/** Whether a filling given up earlier is tried again on the gbrain release
 * `version`: only a filling (it ran windows: the model is on and the server
 * runs with it, so nothing is stopped or copied), only once per release
 * (`heldOn` names the one it gave up on; an attempt from before `heldOn`
 * existed gave up on an earlier release). A brain brought back from its copy
 * (`restored` before any window) stays held for the model. */
export function retriesFilling(
  attempt: BrainState["meaningAttempt"],
  version: string | undefined,
): boolean {
  return (
    attempt?.provider === meaningPin.provider &&
    attempt.result === "restored" &&
    attempt.windows !== undefined &&
    version !== undefined &&
    attempt.heldOn !== version
  );
}

export function meaningPaths(home: string): MeaningPaths {
  const root = join(home, ".local", "share", "lazurio-gbrain-meaning");
  return Object.freeze({
    server: join(root, meaningPin.server.build),
    model: join(root, "models", `${meaningPin.model.sha256}.gguf`),
  });
}
