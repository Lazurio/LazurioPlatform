import { lstat, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

// Narrow publication guard, not a general secret scanner. Never print matching content.
export function forbiddenPath(path: string): boolean {
  return (
    /(^|\/)(\.env(?:\..*)?|id_(rsa|ed25519)|private|secrets|personalspace)(\/|$)/i.test(
      path,
    ) ||
    /\.(pem|p12|pfx|key)$/i.test(path) ||
    /^(dist|node_modules)\//.test(path)
  );
}
export function recognizableCredential(contents: string): boolean {
  return (
    /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(contents) ||
    /\bgh[pousr]_[A-Za-z0-9]{36,}\b/.test(contents) ||
    /\bgithub_pat_[A-Za-z0-9_]{60,}\b/.test(contents)
  );
}
export function allowedProofImport(specifier: string): boolean {
  return [
    "node:util",
    "./core",
    "./core.ts",
    "./index.html",
    "./ui.ts",
  ].includes(specifier);
}

// Use Bun's parser for static module forms; do not approximate JavaScript grammar.
export async function proofInputViolations(
  path: string,
  contents: string,
): Promise<string[]> {
  const failures: string[] = [];
  if (path.endsWith(".ts")) {
    try {
      const scan = new Bun.Transpiler({ loader: "ts" }).scan(contents);
      for (const dependency of scan.imports) {
        if (
          dependency.kind !== "import-statement" ||
          !allowedProofImport(dependency.path)
        )
          failures.push("Unreviewed module input");
      }
    } catch {
      failures.push("Invalid TypeScript input");
    }
    // This proof permits no dynamic loading; computed/runtime IO remains a review boundary.
    if (
      /\bimport\s*\(|\brequire\s*(?:\.\s*resolve\s*)?\(|\bBun\.file\s*\(/.test(
        contents,
      )
    )
      failures.push("Dynamic input");
  } else if (path.endsWith(".html")) {
    // The proof needs only this tiny HTML vocabulary. Additional asset-bearing forms
    // (CSS, srcset, inline scripts, import maps, etc.) require a reviewed expansion.
    const attributes: Record<string, readonly string[]> = {
      html: ["lang"],
      head: [],
      body: [],
      meta: ["charset"],
      title: [],
      h1: [],
      p: [],
      pre: ["id"],
      script: ["src", "type"],
    };
    await new HTMLRewriter()
      .on("*", {
        element(element) {
          const permitted = attributes[element.tagName];
          if (!permitted) {
            failures.push("Unreviewed HTML element");
            return;
          }
          for (const [name] of element.attributes)
            if (!permitted.includes(name))
              failures.push("Unreviewed HTML attribute");
          if (
            element.tagName === "script" &&
            (element.getAttribute("src") !== "./ui.ts" ||
              element.getAttribute("type") !== "module")
          )
            failures.push("Unreviewed HTML script");
        },
      })
      .on("script", {
        text(text) {
          if (text.text.trim())
            failures.push("Inline script is not a reviewed input");
        },
      })
      .transform(new Response(contents))
      .text();
  } else failures.push("Unreviewed input type");
  return failures;
}

if (import.meta.main) {
  const listing = Bun.spawnSync(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (listing.exitCode !== 0)
    throw new Error("Cannot inspect repository publication inputs");
  const files = [
    ...new Set(
      new TextDecoder().decode(listing.stdout).split("\0").filter(Boolean),
    ),
  ];
  // The index is the next commit input; a safe unstaged edit must not hide its bytes.
  const stagedListing = Bun.spawnSync(["git", "ls-files", "--stage", "-z"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stagedListing.exitCode !== 0)
    throw new Error("Cannot inspect index inputs");
  const staged = new Map<string, string>();
  for (const entry of new TextDecoder()
    .decode(stagedListing.stdout)
    .split("\0")
    .filter(Boolean)) {
    const separator = entry.indexOf("\t");
    if (separator < 0) throw new Error("Invalid index metadata");
    const metadata = entry.slice(0, separator).split(" ");
    if (metadata[2] !== "0") throw new Error("Unmerged index input");
    staged.set(entry.slice(separator + 1), metadata[0] ?? "");
  }
  const failures: string[] = [];
  for (const path of files) {
    if (forbiddenPath(path)) {
      failures.push(`Forbidden publication path: ${path}`);
      continue;
    }
    if (relative(process.cwd(), resolve(path)).startsWith("..")) {
      failures.push("Path outside repository");
      continue;
    }
    if (!(await lstat(path)).isFile()) {
      failures.push(`Non-regular publication input: ${path}`);
      continue;
    }
    const inputs = [
      { label: "worktree", contents: await readFile(path, "utf8") },
    ];
    if (staged.has(path)) {
      if (!["100644", "100755"].includes(staged.get(path) ?? "")) {
        failures.push(`Non-regular index input: ${path}`);
        continue;
      }
      const blob = Bun.spawnSync(["git", "show", `:${path}`], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (blob.exitCode !== 0) throw new Error("Cannot read index input");
      inputs.push({
        label: "index",
        contents: new TextDecoder().decode(blob.stdout),
      });
    }
    for (const { label, contents } of inputs) {
      if (recognizableCredential(contents))
        failures.push(`Credential pattern in ${label}: ${path}`);
      if (path.startsWith("proof/")) {
        const known = [
          "proof/core.ts",
          "proof/main.ts",
          "proof/ui.ts",
          "proof/index.html",
        ];
        if (!known.includes(path))
          failures.push(`Unreviewed proof input: ${path}`);
        for (const violation of await proofInputViolations(path, contents))
          failures.push(`${violation} in ${label}: ${path}`);
      }
    }
  }
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  } else
    console.log(
      `PASS: narrow publication and proof-input guard (${files.length} files)`,
    );
}
