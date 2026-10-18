import type { VoiceLocale } from "../folder/voice";
import type { MessageKey } from "./messages";

export type VoiceView = Readonly<{
  locale: VoiceLocale;
  mode: "default" | "custom";
  text: string;
  defaultText: string;
  maxBytes: number;
}>;
export type VoiceDraft = {
  saved: VoiceView;
  text: string;
  mode: VoiceView["mode"];
};
export const voiceDirty = (draft: VoiceDraft) =>
  draft.text !== draft.saved.text || draft.mode !== draft.saved.mode;

// A profile reload updates the saved baseline, retaining a draft in each
// language. This is page memory, scoped to the one Environment this page serves.
export function reconcileVoice(
  saved: VoiceView,
  draft?: VoiceDraft,
): VoiceDraft {
  return draft !== undefined && voiceDirty(draft)
    ? { ...draft, saved }
    : { saved, text: saved.text, mode: saved.mode };
}

type ProfileView = {
  revision: number;
  profile: Record<string, string>;
  preset: { name: string };
  voice: VoiceView;
};

export function voicePanel(options: {
  post: (
    path: string,
    body: unknown,
  ) => Promise<{ ok: boolean; value: unknown }>;
  copy: () => Readonly<Record<MessageKey, string>>;
  changed: () => Promise<void>;
}) {
  function element<T extends HTMLElement>(id: string): T {
    const node = document.getElementById(id);
    if (!node) throw new Error(`Missing voice control: ${id}`);
    return node as T;
  }
  const form = element<HTMLFormElement>("voice-form");
  const fields = element<HTMLFieldSetElement>("voice-fields");
  const text = element<HTMLTextAreaElement>("voice-text");
  const save = element<HTMLButtonElement>("voice-save");
  const cancel = element<HTMLButtonElement>("voice-cancel");
  const restore = element<HTMLButtonElement>("voice-default");
  const refresh = element<HTMLButtonElement>("voice-refresh");
  const status = element<HTMLParagraphElement>("voice-status");
  const meta = element<HTMLSpanElement>("voice-meta");
  const drafts: Partial<Record<VoiceLocale, VoiceDraft>> = {};
  let current: ProfileView | null = null;
  let active: VoiceDraft | null = null;
  let busy = false;
  let notice: MessageKey | null = null;
  let needsRefresh = false;
  function render() {
    if (!active || !current) return;
    const copy = options.copy();
    if (text.value !== active.text) text.value = active.text;
    text.lang = current.voice.locale;
    fields.disabled = busy;
    save.disabled = busy || !voiceDirty(active) || needsRefresh;
    cancel.disabled = busy || !voiceDirty(active);
    restore.disabled =
      busy ||
      (active.mode === "default" && active.text === active.saved.defaultText);
    meta.textContent = `${current.voice.locale === "cs" ? "Čeština" : "English"} · ${active.mode === "default" ? copy.voiceDefault : copy.voiceCustom}`;
    status.textContent = notice
      ? copy[notice]
      : voiceDirty(active)
        ? copy.voiceDirty
        : "";
    refresh.hidden = !needsRefresh;
    refresh.disabled = busy;
  }
  text.addEventListener("input", () => {
    if (!active) return;
    active.text = text.value;
    active.mode = "custom";
    notice = needsRefresh ? notice : null;
    render();
  });
  cancel.addEventListener("click", () => {
    if (!active) return;
    active.text = active.saved.text;
    active.mode = active.saved.mode;
    notice = null;
    render();
  });
  restore.addEventListener("click", () => {
    if (!active) return;
    active.text = active.saved.defaultText;
    active.mode = "default";
    notice = null;
    render();
  });
  refresh.addEventListener("click", async () => {
    busy = true;
    render();
    try {
      await options.changed();
      needsRefresh = false;
      notice = null;
    } catch {
      notice = "voiceFailed";
    } finally {
      busy = false;
      render();
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!current || !active || busy || needsRefresh || !voiceDirty(active))
      return;
    if (
      !active.text.trim() ||
      new TextEncoder().encode(active.text).length > active.saved.maxBytes ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: same text validation as the Folder writer
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(active.text)
    ) {
      notice = "voiceInvalid";
      render();
      return;
    }
    const draft = active;
    const request = {
      expectedRevision: current.revision,
      profile: current.profile,
      voice: {
        locale: current.voice.locale,
        text: draft.mode === "default" ? null : draft.text,
      },
    };
    busy = true;
    render();
    try {
      const { ok, value } = await options.post("/api/update", request);
      const result = value as { kind?: string; reason?: string };
      if (!ok || (result.kind !== "updated" && result.kind !== "unchanged")) {
        needsRefresh = true;
        notice =
          result.reason === "stale-revision"
            ? "voiceStale"
            : result.reason === "voice-context-too-large"
              ? "voiceContextLarge"
              : "voiceFailed";
      } else {
        // The exact submitted draft is now saved. A following read failure
        // leaves it visible and asks for a refresh, without retrying the write.
        draft.saved = { ...draft.saved, text: draft.text, mode: draft.mode };
        await options.changed();
        notice = "voiceSaved";
      }
    } catch {
      needsRefresh = true;
      notice = "voiceFailed";
    } finally {
      busy = false;
      render();
    }
  });
  return {
    load(profile: ProfileView) {
      current = profile;
      active = reconcileVoice(profile.voice, drafts[profile.voice.locale]);
      drafts[profile.voice.locale] = active;
      notice = null;
      render();
    },
  };
}
