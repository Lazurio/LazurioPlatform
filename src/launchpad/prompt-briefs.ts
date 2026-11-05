import { randomBytes } from "node:crypto";
import type { NewModuleOffer } from "./apps-view";

// The descriptions "+ Nový modul" hands to Chat (decision F36's addendum of
// 2026-11-05). A link names a prompt by its id and never carries text
// (prompts.ts), and Chat's fork takes nothing else, so what a person wrote
// reaches the composer through this Launchpad: the page leaves the
// description here at the click, gets the id of a brief made of the prompt's
// own id and a random key, and the link names that id. A brief lives in this
// process's memory only, for a few minutes, a bounded number at a time; it
// says nothing without its key, and the route asks who may get the prompt
// again on every read.

export type BriefPromptId = NewModuleOffer["id"];

const briefPrompts: readonly string[] = [
  "new-module",
  "new-module-request",
  "new-personal-module",
] satisfies readonly BriefPromptId[];

/** Whether the prompt `id` takes a person's description. */
export const isBriefPrompt = (id: string): id is BriefPromptId =>
  briefPrompts.includes(id);

/** How long a brief waits for Chat, and how many wait at once. */
export const briefKeptMs = 15 * 60_000;
export const briefsKept = 32;

const briefId =
  /^(new-module|new-module-request|new-personal-module)-([0-9a-f]{32})$/;

/** The prompt a brief's id names, or null for any other id: within Chat's
 * grammar of a prompt's id (`chatPromptHref`). */
export function briefPromptOf(id: string): BriefPromptId | null {
  const match = briefId.exec(id);
  return match === null ? null : (match[1] as BriefPromptId);
}

export function createPromptBriefs(
  now: () => number = Date.now,
  key: () => string = () => randomBytes(16).toString("hex"),
) {
  const briefs = new Map<
    string,
    Readonly<{ organization: string; description: string; until: number }>
  >();
  const forget = () => {
    for (const [id, brief] of briefs)
      if (brief.until <= now()) briefs.delete(id);
  };
  return {
    /** Keeps a description for the prompt and the login a link will name:
     * the brief's id. The oldest gives way when too many wait. */
    keep(
      prompt: BriefPromptId,
      organization: string,
      description: string,
    ): string {
      forget();
      for (const oldest of briefs.keys()) {
        if (briefs.size < briefsKept) break;
        briefs.delete(oldest);
      }
      const id = `${prompt}-${key()}`;
      briefs.set(id, {
        organization: organization.toLowerCase(),
        description,
        until: now() + briefKeptMs,
      });
      return id;
    },
    /** The description of a brief for that login, letter case ignored, or
     * null: unknown, gone, or kept for another login. */
    read(id: string, organization: string): string | null {
      forget();
      const brief = briefs.get(id);
      return brief?.organization === organization.toLowerCase()
        ? brief.description
        : null;
    },
  };
}
