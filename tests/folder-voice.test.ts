import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { parseFolderPreferences } from "../src/folder/state";
import {
  resumeProfileUpdate,
  updateProfile,
  updateTools,
} from "../src/folder/update-profile";
import { defaultVoices, maxVoiceBytes } from "../src/folder/voice";

async function fixture() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "folder-voice-")));
  const folder = join(parent, "Lazurio");
  const profile = {
    os: executionOs(process.platform),
    access: "local",
    purpose: "human",
    locale: "cs",
    detail: "concise",
    coordination: "direct",
  } as const;
  await initializeFolder(folder, profile);
  const state = async () =>
    parseFolderPreferences(
      JSON.parse(
        await readFile(join(folder, ".lazurio/preferences.json"), "utf8"),
      ),
    );
  const agents = () => readFile(join(folder, "AGENTS.md"), "utf8");
  const change = async (locale: "cs" | "en", text?: string | null) => {
    const current = await state();
    return updateProfile(folder, current.revision, {
      profile: { ...current.profile, locale },
      ...(text === undefined ? {} : { voice: { locale, text } }),
    });
  };
  return {
    folder,
    profile,
    state,
    agents,
    change,
    dispose: () => rm(parent, { recursive: true, force: true }),
  };
}

test("Folder voice follows locale, preserves exact custom variants and resets only the active language", async () => {
  const f = await fixture();
  try {
    expect(await f.agents()).toContain(defaultVoices.cs);
    const cs = "  Piš jasně.\n\nPřidej konkrétní příklad.  ";
    expect((await f.change("cs", cs)).kind).toBe("updated");
    expect((await f.state()).schemaVersion).toBe(3);
    expect(await f.agents()).toContain(cs);
    expect(await f.agents()).not.toContain(defaultVoices.cs);
    await f.change("en");
    expect(await f.agents()).toContain(defaultVoices.en);
    expect(await f.agents()).not.toContain(cs);
    await f.change("en", "Use short paragraphs.");
    await f.change("cs");
    expect(await f.agents()).toContain(cs);
    const current = await f.state();
    await updateTools(f.folder, current.revision, ["wacli"]);
    expect((await f.state()).agentVoice?.overrides).toEqual({
      cs,
      en: "Use short paragraphs.",
    });
    await f.change("cs", null);
    expect(await f.agents()).toContain(defaultVoices.cs);
    expect((await f.state()).agentVoice?.overrides).toEqual({
      en: "Use short paragraphs.",
    });
    await f.change("en");
    expect(await f.agents()).toContain("Use short paragraphs.");
    await f.change("en", null);
    expect((await f.state()).agentVoice).toBeUndefined();
    expect((await f.state()).schemaVersion).toBe(3);
  } finally {
    await f.dispose();
  }
}, 30_000);

test("stale, mismatched, empty, oversized and drifted voice changes leave the saved state intact", async () => {
  const f = await fixture();
  try {
    const before = await f.state();
    for (const voice of [
      { locale: "fr", text: "bonjour" },
      { locale: "en", text: "Hello" },
      { locale: "cs", text: "  \n" },
      { locale: "cs", text: "ě".repeat(maxVoiceBytes / 2 + 1) },
    ]) {
      await expect(
        updateProfile(f.folder, before.revision, {
          profile: before.profile,
          voice,
        }),
      ).rejects.toThrow();
      expect(await f.state()).toEqual(before);
    }
    expect(
      await updateProfile(f.folder, before.revision + 1, {
        profile: before.profile,
        voice: { locale: "cs", text: "Věcně." },
      }),
    ).toEqual({ kind: "blocked", reason: "stale-revision" });
    await writeFile(join(f.folder, "AGENTS.md"), "Local edit\n");
    expect((await f.change("cs", "Věcně.")).kind).toBe("blocked");
    expect(await f.state()).toEqual(before);
    expect(await f.agents()).toBe("Local edit\n");
  } finally {
    await f.dispose();
  }
}, 30_000);

test("interrupted voice activation resumes the same staged preference and output", async () => {
  const f = await fixture();
  try {
    const before = await f.state();
    await expect(
      updateProfile(
        f.folder,
        before.revision,
        {
          profile: before.profile,
          voice: { locale: "cs", text: "Piš jasně.\n\nŽádné fráze." },
        },
        async (step) => {
          if (step === "prepared") throw new Error("simulated stop");
        },
      ),
    ).rejects.toThrow("simulated stop");
    await resumeProfileUpdate(f.folder, before.revision + 1);
    expect((await f.state()).agentVoice?.overrides.cs).toBe(
      "Piš jasně.\n\nŽádné fráze.",
    );
    expect(await f.agents()).toContain("Piš jasně.\n\nŽádné fráze.");
  } finally {
    await f.dispose();
  }
}, 30_000);

test("schema 2 remains readable but cannot smuggle voice into older products", async () => {
  const f = await fixture();
  try {
    const current = await f.state();
    expect(current.schemaVersion).toBe(2);
    expect(() =>
      parseFolderPreferences({
        ...current,
        agentVoice: { overrides: { cs: "Text" } },
      }),
    ).toThrow();
    expect(() =>
      parseFolderPreferences({
        ...current,
        schemaVersion: 3,
        agentVoice: { overrides: {} },
      }),
    ).toThrow();
  } finally {
    await f.dispose();
  }
}, 30_000);

test("saving the visible default pins it as custom; restore removes the pin even when generated bytes match", async () => {
  const f = await fixture();
  try {
    const bytes = await f.agents();
    expect((await f.change("cs", defaultVoices.cs)).kind).toBe("updated");
    expect((await f.state()).agentVoice?.overrides.cs).toBe(defaultVoices.cs);
    expect(await f.agents()).toBe(bytes);
    expect((await f.change("cs", null)).kind).toBe("updated");
    expect((await f.state()).agentVoice).toBeUndefined();
    expect(await f.agents()).toBe(bytes);
  } finally {
    await f.dispose();
  }
});

test("authored Markdown stays inside a bounded literal style block and malformed Unicode is refused", async () => {
  const f = await fixture();
  try {
    const text =
      "Piš věcně.\n```\n## Other rules\n@/private/example.txt\n~~~\n";
    await f.change("cs", text);
    expect(await f.agents()).toContain(`\`\`\`\`text\n${text}\n\`\`\`\``);
    // Worst fence expansion: both delimiter runs occupy the maximum text size.
    const large = "`".repeat(4096) + "~".repeat(4096);
    await f.change("cs", large);
    expect(Buffer.byteLength(await f.agents())).toBeLessThanOrEqual(32 * 1024);
    const saved = await f.state();
    await expect(f.change("cs", "Invalid: \ud800")).rejects.toThrow();
    expect(await f.state()).toEqual(saved);
  } finally {
    await f.dispose();
  }
});
