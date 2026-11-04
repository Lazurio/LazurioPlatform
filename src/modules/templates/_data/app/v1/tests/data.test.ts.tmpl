import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { validateDataDirectory } from "../src/validate-data";

const specs = {
  notes: { schemaVersion: "note.v1", record: z.object({ title: z.string().min(1) }) },
};

function withData(documents: Record<string, string>, run: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "data-"));
  try {
    for (const [path, content] of Object.entries(documents)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the records in seed/ match the schemas of src/domain/collections.ts", () => {
  expect(validateDataDirectory("seed").problems).toEqual([]);
});

test("a record that matches its collection's schema passes", () => {
  withData({ "notes/a.yaml": "schemaVersion: note.v1\nid: a\nrecord:\n  title: First\n" }, (root) =>
    expect(validateDataDirectory(root, specs)).toEqual({ documents: 1, problems: [] }),
  );
});

test("a record whose id starts with a dot is checked too; only .gitkeep is left out", () => {
  withData(
    {
      ".gitkeep": "",
      "notes/.gitkeep": "",
      "notes/.hidden.yaml": "schemaVersion: note.v1\nid: .hidden\nrecord:\n  title: ''\n",
      ".drafts/x.yaml": "schemaVersion: note.v1\nid: x\nrecord: {}\n",
    },
    (root) => {
      const { documents, problems } = validateDataDirectory(root, specs);
      expect(documents).toBe(1);
      expect(problems).toHaveLength(2);
      expect(problems.join("\n")).toContain(".hidden.yaml");
      expect(problems.join("\n")).toContain(".drafts: the collection has no schema");
    },
  );
});

test("a wrong record, envelope or collection fails", () => {
  withData(
    {
      "notes/a.yaml": "schemaVersion: note.v1\nid: a\nrecord:\n  title: ''\n",
      "notes/b.yaml": "schemaVersion: note.v2\nid: c\nrecord:\n  title: Second\n",
      "tasks/x.yaml": "schemaVersion: task.v1\nid: x\nrecord: {}\n",
    },
    (root) => {
      const { problems } = validateDataDirectory(root, specs);
      expect(problems).toHaveLength(4);
      expect(problems.join("\n")).toContain("tasks: the collection has no schema");
    },
  );
});
