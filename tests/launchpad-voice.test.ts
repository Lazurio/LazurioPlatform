import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { defaultVoices } from "../src/folder/voice";
import { startLaunchpad } from "../src/launchpad/server";
import {
  reconcileVoice,
  type VoiceDraft,
  type VoiceView,
  voiceDirty,
} from "../src/launchpad/voice-panel";

test("Launchpad saves an active voice through the Folder transaction and rejects another tab's stale locale", async () => {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "launchpad-voice-")),
  );
  const folder = join(parent, "Lazurio");
  await initializeFolder(folder, {
    os: executionOs(process.platform),
    access: "local",
    purpose: "human",
    locale: "cs",
    detail: "concise",
    coordination: "direct",
  });
  const app = await startLaunchpad(folder);
  const url = new URL(app.url);
  const call = (path: string, body: unknown) =>
    fetch(new URL(path, url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: url.origin,
        Authorization: `Bearer ${url.hash.slice(1)}`,
      },
      body: JSON.stringify(body),
    });
  try {
    const current = await (await call("/api/profile", {})).json();
    expect(current.voice).toMatchObject({
      locale: "cs",
      mode: "default",
      text: defaultVoices.cs,
    });
    const edit = {
      expectedRevision: current.revision,
      profile: current.profile,
      voice: { locale: "cs", text: "Piš konkrétně.\n\nVysvětli další krok." },
    };
    expect((await (await call("/api/preview", edit)).json()).kind).toBe(
      "profile-change",
    );
    expect((await (await call("/api/profile", {})).json()).revision).toBe(
      current.revision,
    );
    expect((await call("/api/update", edit)).status).toBe(200);
    expect(await readFile(join(folder, "AGENTS.md"), "utf8")).toContain(
      edit.voice.text,
    );
    const saved = await (await call("/api/profile", {})).json();
    expect(saved.voice).toMatchObject({
      mode: "custom",
      text: edit.voice.text,
    });
    expect(
      (
        await call("/api/update", {
          expectedRevision: saved.revision,
          profile: { ...saved.profile, locale: "en" },
        })
      ).status,
    ).toBe(200);
    expect(
      (await call("/api/update", { ...edit, expectedRevision: saved.revision }))
        .status,
    ).toBe(409);
    const english = await (await call("/api/profile", {})).json();
    expect(english.voice).toMatchObject({
      locale: "en",
      mode: "default",
      text: defaultVoices.en,
    });
    expect(
      (
        await call("/api/update", {
          expectedRevision: english.revision,
          profile: english.profile,
          voice: { locale: "cs", text: "Wrong locale" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("/api/update", {
          expectedRevision: english.revision,
          profile: english.profile,
          voice: { locale: "en", text: "  " },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("/api/update", {
          expectedRevision: english.revision,
          profile: { ...english.profile, locale: "cs" },
        })
      ).status,
    ).toBe(200);
    expect((await (await call("/api/profile", {})).json()).voice.text).toBe(
      edit.voice.text,
    );
  } finally {
    await app.server.stop(true);
    await rm(parent, { recursive: true, force: true });
  }
}, 30_000);

test("language changes and refresh retain dirty drafts but refresh an untouched default", () => {
  const cs: VoiceView = {
    locale: "cs",
    mode: "default",
    text: "Výchozí",
    defaultText: "Výchozí",
    maxBytes: 8192,
  };
  const draft: VoiceDraft = { saved: cs, mode: "custom", text: "Rozepsaný" };
  const en = reconcileVoice({
    ...cs,
    locale: "en",
    text: "Default",
    defaultText: "Default",
  });
  expect(en.text).toBe("Default");
  expect(voiceDirty(en)).toBe(false);
  const returned = reconcileVoice(
    { ...cs, text: "Nový výchozí", defaultText: "Nový výchozí" },
    draft,
  );
  expect(returned.text).toBe("Rozepsaný");
  expect(voiceDirty(returned)).toBe(true);
  expect(
    reconcileVoice({ ...cs, text: "Nový výchozí" }, reconcileVoice(cs)).text,
  ).toBe("Nový výchozí");
  const restored: VoiceDraft = {
    saved: { ...cs, mode: "custom", text: "Uložený" },
    text: cs.defaultText,
    mode: "default",
  };
  expect(reconcileVoice(restored.saved, restored)).toEqual(restored);
  expect(voiceDirty(restored)).toBe(true);
});
