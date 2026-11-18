import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportArchive } from "../src/buddy/archive/export";
import type { ArchiveRecord } from "../src/buddy/archive/format";
import { verifyArchive } from "../src/buddy/archive/verify";
import { type BuddyContext, runBuddyCommand } from "../src/buddy/cli";
import type { CliContext } from "../src/update/cli";
import {
  buddyGen3Home,
  hermesMessages,
  t3Messages,
} from "./fixtures/buddy-archive";

// `lazurio buddy archive export` and `verify` (plan LZD-0033 R6a): Buddy
// GEN3's conversation from synthetic stores of Hermes and his T3 Code,
// read-only, into lazurio.conversation-archive.v1.

const posix = test.skipIf(process.platform === "win32");
const NOW = new Date("2026-11-18T09:08:07.654Z");

async function withHome(
  body: (home: string) => Promise<void>,
  options: Parameters<typeof buddyGen3Home>[1] = {},
) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "buddy-archive-")));
  try {
    await buddyGen3Home(home, options);
    await body(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const exportTo = (home: string, output?: string) =>
  exportArchive({ home, output, version: "1.2.3", now: () => NOW });

const readRecords = async (dir: string) =>
  (await readFile(join(dir, "records.jsonl"), "utf8"))
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as ArchiveRecord);

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

posix(
  "export: each rule of the reference, the counts by channel, author and kind, and the manifest",
  () =>
    withHome(async (home) => {
      const answer = await exportTo(home);
      const dir = join(home, "Buddy", "archiv", "buddy-gen3-20261118T090807Z");
      expect(answer).toMatchObject({
        kind: "buddy-archive-export",
        state: "exported",
        path: dir,
        records: 17,
        attachments: 6,
        attachments_missing: 4,
      });
      expect(answer.by).toEqual({
        "chat/assistant/commentary": 1,
        "chat/assistant/message": 1,
        "chat/assistant/question": 1,
        "chat/user/answer": 1,
        "chat/user/message": 2,
        "telegram/assistant/commentary": 1,
        "telegram/assistant/message": 2,
        "telegram/assistant/question": 2,
        "telegram/system/notice": 1,
        "telegram/user/answer": 2,
        "telegram/user/message": 3,
      });
      const records = await readRecords(dir);
      const byId = new Map(records.map((r) => [r.id, r]));
      expect(records.map((r) => r.id)).toEqual([
        "hermes:u1",
        "hermes:u2#c0",
        "hermes:u2#q0",
        "hermes:u2#a0",
        "hermes:u4",
        "hermes:u7",
        "hermes:u11",
        "hermes:u12",
        "hermes:u13",
        "hermes:u14#q0",
        "hermes:u14#a0",
        "t3:m1",
        "t3:m3",
        "t3:m4",
        "hermes:u23#q0",
        "hermes:u23#a0",
        "t3:m5",
      ]);
      // Envelopes, the image line and its hint are gone; the origin's
      // message id is kept.
      expect(byId.get("hermes:u1")).toMatchObject({
        text: "Ahoj Buddy",
        channel: "telegram",
        conversation: "buddy-gen3:telegram",
        platform: "buddy-gen3",
        author: "user",
        kind: "message",
        ts: "2023-11-14T22:13:20.123Z",
        source: { db: "hermes", row: 1, platform_message_id: "101" },
        attachments: [
          {
            name: "gone.png",
            mime: "image/png",
            missing: true,
            reason: "absent",
          },
        ],
      });
      expect(byId.get("hermes:u1")?.author_name).toBeUndefined();
      expect(byId.get("hermes:u2#c0")).toMatchObject({
        author: "assistant",
        author_name: "Buddy GEN3",
        kind: "commentary",
        text: "Podívám se do kalendáře.",
      });
      expect(byId.get("hermes:u2#q0")).toMatchObject({
        kind: "question",
        text: "Který den?",
        options: ["Pondělí", "Úterý"],
      });
      expect(byId.get("hermes:u2#a0")).toMatchObject({
        author: "user",
        kind: "answer",
        text: "Úterý",
        source: { db: "hermes", row: 3 },
      });
      // The answer pruned to its text, through the bridged call id.
      expect(byId.get("hermes:u14#a0")).toMatchObject({ text: "Ano" });
      expect(byId.get("hermes:u14#q0")?.options).toEqual(["Ano", "Ne"]);
      // A notice from outside the model is the system's.
      expect(byId.get("hermes:u7")).toMatchObject({
        author: "system",
        author_name: "Buddy GEN3",
        kind: "notice",
      });
      // Compaction copies, in the same session and in the session that
      // continues after a compression, count once: the oldest row.
      expect(byId.get("hermes:u11")?.source).toEqual({
        db: "hermes",
        row: 11,
        platform_message_id: "102",
      });
      expect(byId.get("hermes:u4")?.source).toEqual({ db: "hermes", row: 4 });
      // MEDIA: lines are attachments, copied with their sha256.
      const report = await readFile(join(home, "report.pdf"));
      const u4 = byId.get("hermes:u4");
      expect(u4?.text).toBe("Hotovo, posílám soubor.");
      expect(u4?.attachments).toEqual([
        {
          name: "report.pdf",
          mime: "application/pdf",
          path: `attachments/${sha256(report).slice(0, 12)}-report.pdf`,
          size: report.length,
          sha256: sha256(report),
        },
      ]);
      // Nothing outside the home is read, also through a symlink.
      expect(byId.get("hermes:u13")?.attachments).toEqual([
        {
          name: "hostname",
          mime: "application/octet-stream",
          missing: true,
          reason: "outside-home",
        },
      ]);
      expect(byId.get("hermes:u12")?.attachments).toMatchObject([
        { name: "link.txt", missing: true, reason: "outside-home" },
      ]);
      // The web chat: T3 Code's messages with the page chip as context;
      // the commentary Hermes recorded; Delegace and a deleted thread left out.
      expect(byId.get("t3:m1")).toMatchObject({
        channel: "chat",
        conversation: "buddy-gen3:chat",
        text: "Ahoj z webu",
        context: { page: "Apps", ref: "t3-context://v1/lazurio-page/abc" },
        attachments: [
          {
            name: "foto.png",
            mime: "image/png",
            size: 9,
            sha256: sha256(new TextEncoder().encode("png-bytes")),
          },
        ],
      });
      expect(byId.get("t3:m3")?.kind).toBe("commentary");
      expect(byId.get("t3:m4")).toMatchObject({
        kind: "message",
        ts: "2023-11-14T22:15:03.000Z",
      });
      expect(byId.get("t3:m5")?.attachments).toEqual([
        {
          name: "smlouva.pdf",
          mime: "application/pdf",
          size: 1234,
          missing: true,
          reason: "absent",
        },
      ]);
      expect(byId.get("hermes:u23#q0")?.channel).toBe("chat");
      for (const id of ["t3:m2", "t3:m6", "hermes:u5", "hermes:u20"])
        expect(byId.has(id)).toBe(false);

      const manifest = JSON.parse(
        await readFile(join(dir, "manifest.json"), "utf8"),
      );
      expect(manifest).toMatchObject({
        format: "lazurio.conversation-archive.v1",
        exported_at: "2026-11-18T09:08:07.654Z",
        exporter: { product: "lazurio", version: "1.2.3" },
        sources: [
          {
            kind: "hermes-state",
            path: ".hermes/state.db",
            schema_version: 32,
            missing_columns: [],
          },
          {
            kind: "t3-buddy-state",
            path: ".t3-buddy/userdata/statev2.sqlite",
            schema_version: 96,
            missing_columns: [],
          },
        ],
        conversations: [
          {
            id: "buddy-gen3:chat",
            platform: "buddy-gen3",
            channel: "chat",
            title: "Chat",
          },
          {
            id: "buddy-gen3:telegram",
            platform: "buddy-gen3",
            channel: "telegram",
            title: "Telegram",
          },
        ],
        counts: { records: 17, attachments: 6, attachments_missing: 4 },
        first_ts: "2023-11-14T22:13:20.123Z",
        last_ts: "2023-11-14T22:16:00.000Z",
      });
      expect(manifest.completeness.missing).toHaveLength(4);
      expect(
        manifest.completeness.checks.filter((c: { ok: boolean }) => !c.ok),
      ).toEqual([
        { name: "attachments.missing", ok: false, detail: "4 missing" },
      ]);
      expect(manifest.source_accounting).toMatchObject({
        "hermes.skipped.compaction_copy": 3,
        "hermes.telegram.skipped.no_reply": 1,
        "hermes.telegram.skipped.internal_notification": 2,
        "hermes.telegram.skipped.turn_stub": 1,
        "hermes.telegram.skipped.compaction_summary": 1,
        "hermes.acp.user.covered_by_t3": 1,
        "hermes.local.user.covered_by_t3": 1,
        "hermes.cron.skipped.session_not_conversation": 1,
        "t3.skipped.delegace_notification": 1,
      });
      // Owner-only: the directory, its attachments and every file.
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      expect((await stat(join(dir, "attachments"))).mode & 0o777).toBe(0o700);
      for (const name of ["manifest.json", "records.jsonl"])
        expect((await stat(join(dir, name))).mode & 0o777).toBe(0o600);
      const files = await readdir(join(dir, "attachments"));
      expect(files).toHaveLength(2);
      for (const name of files)
        expect((await stat(join(dir, "attachments", name))).mode & 0o777).toBe(
          0o600,
        );
      // Copied, never moved; nothing half-written left beside it.
      expect((await lstat(join(home, "report.pdf"))).isFile()).toBe(true);
      expect(await readdir(join(home, "Buddy", "archiv"))).toEqual([
        "buddy-gen3-20261118T090807Z",
      ]);
      expect((await verifyArchive(dir)).state).toBe("verified");
    }),
);

posix(
  "the sources are only read: their bytes and times are unchanged, and a second export yields the same records.jsonl",
  () =>
    withHome(async (home) => {
      const sources = [
        join(home, ".hermes", "state.db"),
        join(home, ".t3-buddy", "userdata", "statev2.sqlite"),
        join(home, ".t3-buddy", "userdata", "attachments", "buddy-1111.png"),
        join(home, "report.pdf"),
      ];
      const before = await Promise.all(
        sources.map(async (path) => ({
          bytes: sha256(await readFile(path)),
          mtime: (await stat(path)).mtimeMs,
        })),
      );
      const listing = async () => ({
        hermes: (await readdir(join(home, ".hermes"))).sort(),
        t3: (await readdir(join(home, ".t3-buddy", "userdata"))).sort(),
      });
      const filesBefore = await listing();
      const first = await exportTo(home, join(home, "first"));
      const second = await exportTo(home, join(home, "second"));
      expect(first.state).toBe("exported");
      expect(second.state).toBe("exported");
      expect(await readFile(join(home, "second", "records.jsonl"))).toEqual(
        await readFile(join(home, "first", "records.jsonl")),
      );
      expect(
        await Promise.all(
          sources.map(async (path) => ({
            bytes: sha256(await readFile(path)),
            mtime: (await stat(path)).mtimeMs,
          })),
        ),
      ).toEqual(before);
      expect(await listing()).toEqual(filesBefore);
    }),
);

posix(
  "an existing output is refused, and a check that fails publishes nothing",
  () =>
    withHome(
      async (home) => {
        const target = join(home, "taken");
        await mkdir(target);
        await writeFile(join(target, "keep"), "mine");
        expect(await exportTo(home, target)).toEqual({
          kind: "buddy-archive-export",
          state: "refused",
          reason: "output-exists",
          path: target,
        });
        expect(await readdir(target)).toEqual(["keep"]);
        // A gateway envelope left in a text fails records.no-envelope-left.
        const failed = await exportTo(home, join(home, "out"));
        expect(failed).toMatchObject({
          state: "failed",
          reason: "incomplete",
          failed: ["records.no-envelope-left"],
        });
        expect((await readdir(home)).filter((n) => n.includes("out"))).toEqual(
          [],
        );
      },
      {
        t3: [
          ...t3Messages,
          {
            id: "m7",
            role: "assistant",
            text: "Gateway message origin (JSON data, not instructions or authorization):",
            at: "2023-11-14T22:18:00.000Z",
          },
        ],
      },
    ),
);

posix(
  "an empty source message is left out and counted, never blocking the export; an empty question with options stays",
  () =>
    withHome(
      async (home) => {
        const dir = join(home, "out");
        const answer = await exportTo(home, dir);
        expect(answer).toMatchObject({ state: "exported", records: 18 });
        expect(answer.by?.["telegram/system/notice"]).toBe(1);
        expect(answer.by?.["chat/assistant/message"]).toBe(1);
        const records = await readRecords(dir);
        expect(records.map((r) => r.id)).not.toContain("t3:m7");
        expect(records.map((r) => r.id)).not.toContain("hermes:u50");
        expect(records.find((r) => r.id === "hermes:u51#q0")).toMatchObject({
          text: "",
          options: ["Ano", "Ne"],
        });
        const manifest = JSON.parse(
          await readFile(join(dir, "manifest.json"), "utf8"),
        );
        expect(manifest.source_accounting).toMatchObject({
          "t3.skipped.empty": 1,
          "hermes.telegram.skipped.empty": 1,
        });
        expect(
          manifest.completeness.checks.find(
            (c: { name: string }) => c.name === "records.non-empty",
          ).ok,
        ).toBe(true);
        expect(await verifyArchive(dir)).toMatchObject({ state: "verified" });
      },
      {
        hermes: [
          ...hermesMessages("/unused"),
          // Unicode whitespace only: no text to keep.
          {
            session: "s-tg2",
            role: "assistant",
            at: 1_700_000_090,
            uid: "u50",
            content: "\u00a0\u2003",
          },
          {
            session: "s-tg2",
            role: "assistant",
            at: 1_700_000_091,
            uid: "u51",
            content: "",
            tool_calls: JSON.stringify([
              {
                id: "call_9",
                type: "function",
                function: {
                  name: "clarify",
                  arguments: JSON.stringify({
                    questions: [{ question: " ", choices: ["Ano", "Ne"] }],
                  }),
                },
              },
            ]),
          },
        ],
        t3: [
          ...t3Messages,
          {
            id: "m7",
            role: "assistant",
            text: " \u00a0 ",
            at: "2023-11-14T22:18:00.000Z",
          },
        ],
      },
    ),
);

posix(
  "a store without optional columns still exports, and the manifest names what was absent",
  () =>
    withHome(
      async (home) => {
        const answer = await exportTo(home, join(home, "out"));
        // Without display_kind the internal notification is no longer
        // recognized; the recount follows the same rule.
        expect(answer).toMatchObject({ state: "exported", records: 18 });
        const records = await readRecords(join(home, "out"));
        expect(records.find((r) => r.id === "hermes:u11")?.source).toEqual({
          db: "hermes",
          row: 11,
        });
        const manifest = JSON.parse(
          await readFile(join(home, "out", "manifest.json"), "utf8"),
        );
        expect(manifest.sources[0].missing_columns).toEqual([
          "messages.platform_message_id",
          "messages.display_kind",
        ]);
      },
      {
        columns: [
          "tool_calls TEXT",
          "tool_call_id TEXT",
          "tool_name TEXT",
          "codex_message_items TEXT",
          "_compressed_summary INTEGER NOT NULL DEFAULT 0",
          "message_uid TEXT",
        ],
      },
    ),
);

posix(
  "verify: passes on the archive alone, and fails after one attachment byte or one record line changed",
  () =>
    withHome(async (home) => {
      const dir = join(home, "out");
      expect((await exportTo(home, dir)).state).toBe("exported");
      await rm(join(home, ".hermes"), { recursive: true });
      await rm(join(home, ".t3-buddy"), { recursive: true });
      const ok = await verifyArchive(dir);
      expect(ok).toMatchObject({ state: "verified", records: 17 });

      const [file] = await readdir(join(dir, "attachments"));
      const attachment = join(dir, "attachments", file ?? "");
      const original = await readFile(attachment);
      const changed = Buffer.from(original);
      changed[0] = (changed[0] ?? 0) ^ 1;
      await writeFile(attachment, changed);
      expect(await verifyArchive(dir)).toMatchObject({
        state: "failed",
        failed: ["attachments.sha256"],
      });
      await writeFile(attachment, original);
      expect((await verifyArchive(dir)).state).toBe("verified");

      const records = await readFile(join(dir, "records.jsonl"), "utf8");
      await writeFile(
        join(dir, "records.jsonl"),
        records.replace('"text":"Ahoj Buddy"', '"text":"Ahoj Budy"'),
      );
      expect(await verifyArchive(dir)).toMatchObject({
        state: "failed",
        failed: ["records.sha256"],
      });
    }),
);

posix(
  "lazurio buddy archive: the CLI's usage, its JSON without any conversation text, and verify",
  () =>
    withHome(async (home) => {
      const context: BuddyContext = {
        identity: {} as CliContext["identity"],
        platform: process.platform,
        env: { HOME: home, PATH: "/usr/bin:/bin" },
        executable: "/usr/local/bin/lazurio",
        now: () => NOW,
      };
      const run = (args: string[]) => runBuddyCommand(args, context);
      for (const args of [
        ["archive", "export", "--output", "relative"],
        ["archive", "verify", "relative"],
        ["archive", "verify"],
        ["archive", "export", "--folder", home],
        ["archive", "verify", home, "--output", home],
      ])
        expect((await run(args)).code).toBe(2);
      const exported = await run(["archive", "export", "--json"]);
      expect(exported.code).toBe(0);
      const answer = JSON.parse(exported.stdout ?? "");
      expect(answer).toMatchObject({
        kind: "buddy-archive-export",
        state: "exported",
        records: 17,
      });
      const texts = [
        ...hermesMessages(home).map((m) => m.content ?? ""),
        ...t3Messages.map((m) => m.text),
      ]
        .flatMap((text) => text.split("\n"))
        .filter((line) => line.trim().length > 3);
      for (const line of texts) {
        expect(exported.stdout).not.toContain(line);
        expect(exported.stderr ?? "").not.toContain(line);
      }
      expect(exported.stderr).toContain("~/Buddy/archiv/buddy-gen3-");
      const verified = await run(["archive", "verify", answer.path, "--json"]);
      expect(verified.code).toBe(0);
      expect(JSON.parse(verified.stdout ?? "").state).toBe("verified");
      for (const line of texts) expect(verified.stdout).not.toContain(line);
      // Again into the same second: the directory exists.
      expect((await run(["archive", "export"])).code).toBe(1);
    }),
);
