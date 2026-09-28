import { expect, test } from "bun:test";
import {
  createSanitizer,
  journalLimits,
  type PrivateKind,
  type PrivateValue,
  privateKinds,
  withheldLine,
} from "../src/recover/sanitize";
import { safeTail } from "../src/tools/redact";

// The sanitizer of the recovery evidence: what may leave the Machine in a
// public issue. Generated private values of every kind are planted in many
// line shapes; none may survive and the gate must pass what is left, while
// the commits and digests the product prints survive. Deterministic: a seeded
// generator, so a failure names a reproducible case.

function generator(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    // xorshift32
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
  const int = (min: number, max: number) =>
    min + Math.floor(next() * (max - min + 1));
  const pick = <T>(values: readonly T[]) =>
    values[int(0, values.length - 1)] as T;
  const word = (length: number, alphabet = "abcdefghijklmnopqrstuvwxyz") =>
    Array.from({ length }, () => pick([...alphabet])).join("");
  const hex = (length: number) => word(length, "0123456789abcdef");
  return { next, int, pick, word, hex };
}
type Random = ReturnType<typeof generator>;

// A value of each kind as the Machine would have it: slugs, mixed-case
// Organization names, numeric ids, paths and hostnames.
function privateValue(random: Random, kind: PrivateKind): string {
  const slug = () =>
    Array.from({ length: random.int(1, 3) }, () =>
      random.word(random.int(3, 9)),
    ).join("-");
  switch (kind) {
    case "folder":
      return `/srv/${slug()}/Lazurio`;
    case "install-base":
      return `/opt/${slug()}/lazurio-base`;
    case "home":
      return `/home/${slug()}`;
    case "organization":
      return random.next() < 0.5
        ? slug()
        : `${random.word(1).toUpperCase()}${random.word(random.int(4, 10))}`;
    case "github-id":
      return String(random.int(100_000, 99_999_999));
    case "hostname":
      return `${slug()}.${random.word(5)}.example`;
    default:
      return slug();
  }
}

// Sentences of a journal the values are planted in.
const shapes: readonly ((value: string) => string)[] = [
  (value) => value,
  (value) => `error: cannot read ${value}/organizations`,
  (value) => `Started Lazurio Launchpad for ${value}.`,
  (value) => `{"folder":"${value}","code":"state-invalid"}`,
  (value) => `ssh ${value}@peer failed`,
  (value) => `https://launchpad.${value}.lazurio.io/health 502`,
  (value) => `path=${value.toUpperCase()}/x`,
  (value) => `[${value}] restarting`,
  (value) => `'${value}' "${value}" (${value})`,
];

test("no generated private value survives, and the gate passes what is left", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const random = generator(seed);
    const values: PrivateValue[] = privateKinds.flatMap((kind) =>
      Array.from({ length: random.int(1, 3) }, () => ({
        kind,
        value: privateValue(random, kind),
      })),
    );
    const sanitizer = createSanitizer({ values });
    const lines = values.map(({ value }) => random.pick(shapes)(value));
    const output = sanitizer.sanitize(lines.join("\n"));
    for (const { value } of values)
      expect([
        seed,
        output.toLowerCase().includes(value.toLowerCase()),
      ]).toEqual([seed, false]);
    expect([seed, sanitizer.gate(output).kind]).toEqual([seed, "clean"]);
  }
});

test("the gate refuses a surviving value, naming its kind and never the value", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const random = generator(seed * 7919);
    const kind = random.pick(privateKinds);
    const value = privateValue(random, kind);
    const sanitizer = createSanitizer({ values: [{ kind, value }] });
    const text = `the report\n${random.pick(shapes)(value)}\nend`;
    const verdict = sanitizer.gate(text);
    expect(verdict.kind).toBe("refused");
    if (verdict.kind !== "refused") continue;
    expect(verdict.found).toContain(kind);
    expect(JSON.stringify(verdict).toLowerCase()).not.toContain(
      value.toLowerCase(),
    );
  }
});

test("values are replaced by stable placeholders, the longest first", () => {
  const sanitizer = createSanitizer({
    values: [
      { kind: "home", value: "/home/canary" },
      { kind: "folder", value: "/home/canary/Lazurio" },
      { kind: "user", value: "canary" },
      { kind: "host", value: "canary-box" },
      { kind: "organization", value: "Acme" },
      { kind: "organization", value: "globex" },
      { kind: "repository", value: "moon-plans" },
      { kind: "github-login", value: "canary-login" },
    ],
  });
  expect(
    sanitizer.sanitize(
      [
        "/home/canary/Lazurio/organizations/acme/workspace/moon-plans failed",
        "/home/canary/.local/share/lazurio is the base on canary-box",
        "GLOBEX and Acme; canary-login signed canary in",
        "canaryx and xcanary stay: they are other names",
      ].join("\n"),
    ),
  ).toBe(
    [
      "<folder>/organizations/<org-1>/workspace/<repo-1> failed",
      "~/.local/share/lazurio is the base on <host>",
      "<org-2> and <org-1>; <login-1> signed <user> in",
      "canaryx and xcanary stay: they are other names",
    ].join("\n"),
  );
  // The same value under two kinds is named by the first kind.
  const both = createSanitizer({
    values: [
      { kind: "github-login", value: "operator" },
      { kind: "user", value: "operator" },
    ],
  });
  expect(both.sanitize("operator")).toBe("<user>");
  // A value that is also a placeholder's name is not found inside it.
  const named = createSanitizer({ values: [{ kind: "user", value: "user" }] });
  expect(named.sanitize("user logged in")).toBe("<user> logged in");
  expect(named.gate("<user> logged in").kind).toBe("clean");
  // Too short or the same on every Machine: not a value.
  const generic = createSanitizer({
    values: [
      { kind: "user", value: "a" },
      { kind: "host", value: "localhost" },
    ],
  });
  expect(generic.sanitize("a localhost")).toBe("a localhost");
});

test("credential shapes and unknown long runs withhold the whole line", () => {
  const sanitizer = createSanitizer({ values: [] });
  const token = "0123456789abcdef".repeat(4);
  for (const line of [
    // The Launchpad's session URL: 64 hex characters after `#`, no label.
    `{"url":"http://127.0.0.1:41234/#${token}","scope":"x"}`,
    ["-----BEGIN OPENSSH", "PRIVATE KEY-----"].join(" "),
    `gh auth: ghp_${"A1b2".repeat(9)}`,
    `github_pat_${"x".repeat(40)}`,
    "composio: uak_abcdefghijkl",
    "Authorization: Bearer abc",
    "Set-Cookie: s=1",
    "GET /callback?code=abc",
    "pairing code ABCD-1234",
    `base64 ${"QUJD".repeat(12)}`,
    `base64 with slashes ${"ab+/".repeat(12)}`,
  ])
    expect([line, sanitizer.sanitize(line)]).toEqual([line, withheldLine]);
});

test("commits and digests the product prints survive; redact.ts withholds them", () => {
  const commit = "a".repeat(40);
  const digest = "b".repeat(64);
  const other = "c".repeat(64);
  const sanitizer = createSanitizer({ values: [], publicDigests: [commit] });
  for (const line of [
    `lazurio 1.0.0 (commit ${commit}, target linux-arm64)`,
    `artifact sha256:${digest} verified`,
    `{"commit": "${other}"}`,
    `"sourceCommit":"${other}"`,
    `running ${commit}`,
  ]) {
    expect(sanitizer.sanitize(line)).toBe(line);
    expect(sanitizer.gate(line).kind).toBe("clean");
    // The tools screen stays as strict as it was.
    expect(safeTail(line)).toBe("[line withheld]");
  }
  // Unknown and unlabelled, or not exactly a digest: withheld.
  for (const line of [
    `running ${other}`,
    `sha256:${digest}ff`,
    `commit ${"A".repeat(40)}`,
  ])
    expect(sanitizer.sanitize(line)).toBe(withheldLine);
});

test("addresses, hostnames and other accounts' homes are replaced by pattern", () => {
  const sanitizer = createSanitizer({ values: [] });
  expect(
    sanitizer.sanitize(
      [
        "peer 100.64.0.7 and 192.168.1.20:22; loopback 127.0.0.1 stays",
        "v6 fd7a:115c:a1e0::5 and 2001:db8:0:0:0:0:0:1; ::1 stays; 12:34:56 stays",
        "mail someone@example.org; git@github.com stays",
        "https://t3.work-vm.acme.lazurio.io and https://lazurio.io stay?",
        "launchpad.<machine-1>.<org-1>.lazurio.io stays",
        "/home/someone/x and /Users/other/y",
        "versions 1.2.3 and 10.0.0-rc.1 stay",
      ].join("\n"),
    ),
  ).toBe(
    [
      "peer <ip> and <ip>:22; loopback 127.0.0.1 stays",
      "v6 <ip> and <ip>; ::1 stays; 12:34:56 stays",
      "mail <email>; git@github.com stays",
      "https://<lazurio-host> and https://lazurio.io stay?",
      "launchpad.<machine-1>.<org-1>.lazurio.io stays",
      "/home/<account>/x and /Users/<account>/y",
      "versions 1.2.3 and 10.0.0-rc.1 stay",
    ].join("\n"),
  );
  // The gate finds each pattern kind in text that did not pass the sanitizer.
  const verdict = sanitizer.gate(
    `100.64.0.9 a@b.example x.y.lazurio.io /home/z ghp_${"A".repeat(30)}`,
  );
  expect(verdict).toEqual({
    kind: "refused",
    found: [
      "credential",
      "key-material",
      "ip-address",
      "email",
      "lazurio-hostname",
      "account-path",
    ],
  });
});

test("an IPv6 address right after a key and a colon is still an address", () => {
  const sanitizer = createSanitizer({ values: [] });
  for (const [line, expected] of [
    ["addr:fd7a:115c:a1e0::1", "addr:<ip>"],
    ["{Addr:fd7a:115c:a1e0::5 Port:22}", "{Addr:<ip> Port:22}"],
    ["tailscale0:fd7a:115c:a1e0:ab12:4843:cd96:625c:1a2b", "tailscale0:<ip>"],
    ["peer=cafe:fd7a:115c::7:", "peer=<ip>:"],
    ["dst:::1 stays", "dst:::1 stays"],
    ["Result::Add and std::io and 12:34:56 stay", null],
    [`sha256:${"ab".repeat(32)}`, null],
  ] as const) {
    expect(sanitizer.sanitize(line)).toBe(expected ?? line);
    if (expected === null || expected === line)
      expect(sanitizer.gate(line).kind).toBe("clean");
    else
      expect(sanitizer.gate(line)).toEqual({
        kind: "refused",
        found: ["ip-address"],
      });
  }
});

test("a journal tail is plain and bounded to its lines and bytes", () => {
  const sanitizer = createSanitizer({
    values: [{ kind: "user", value: "canary" }],
  });
  const many = Array.from({ length: 200 }, (_, n) => `line ${n} canary`);
  const tail = sanitizer.journalTail(`\u001b[31m${many.join("\r\n")}\u0007`);
  const lines = tail.split("\n");
  expect(lines.length).toBe(journalLimits.lines);
  expect(lines.at(-1)).toBe("line 199 <user>");
  expect(tail).not.toContain("\u001b");
  const wide = Array.from({ length: 80 }, (_, n) => `${n} ${"w ".repeat(400)}`);
  const bounded = sanitizer.journalTail(wide.join("\n"));
  expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(journalLimits.bytes);
  expect(bounded.split("\n").at(-1)?.startsWith("79 ")).toBe(true);
  for (const line of bounded.split("\n"))
    expect(line.length).toBeLessThanOrEqual(journalLimits.lineCharacters + 1);
});

test("control characters are not plain text for the gate", () => {
  const sanitizer = createSanitizer({ values: [] });
  expect(sanitizer.gate("a‮b")).toEqual({
    kind: "refused",
    found: ["control-character"],
  });
});
