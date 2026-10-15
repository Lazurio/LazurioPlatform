import { expect, test } from "bun:test";
import {
  addRow,
  type CustomForm,
  customBody,
  customFormView,
  customRefusal,
  customSaved,
  editCustomForm,
  newCustomForm,
  parseCustomSettings,
  removeRow,
  withArg,
  withField,
  withKey,
  withoutStoredBearer,
  withType,
} from "../src/launchpad/custom-server-form";
import { messages } from "../src/launchpad/messages";
import {
  customServerPath,
  pageFrame,
  pageRoute,
  routePath,
  routeTitle,
} from "../src/launchpad/routes";

// The page of a custom MCP server (decision F42, addendum of 2026-10-11),
// Codex Desktop's "Connect to a custom MCP": its routes, the form as it
// opens, rows added and removed, the type switched without losing what was
// typed, Save enabled only when the server's own rules pass, the lines
// under the fields, and an edit that keeps its keys until one changes.

const cs = messages("cs");
const en = messages("en");

test("the routes: a new server under custom/new, an existing one under custom/server/<id>", () => {
  expect(pageRoute("/integrations/custom/new")).toEqual({
    view: "integrations",
    tab: "custom",
    form: { server: null },
  });
  expect(pageRoute("/integrations/custom/server/files_mcp")).toEqual({
    view: "integrations",
    tab: "custom",
    form: { server: "files_mcp" },
  });
  // A server may be called "new": its page is still its page.
  expect(pageRoute(customServerPath("new"))).toEqual({
    view: "integrations",
    tab: "custom",
    form: { server: "new" },
  });
  for (const path of [
    "/integrations/custom/server/",
    "/integrations/custom/server/a%2Fb",
    "/integrations/custom/new/extra",
    "/integrations/custom/elsewhere",
  ])
    expect([path, pageRoute(path)]).toEqual([
      path,
      { view: "integrations", tab: "custom" },
    ]);
  for (const route of [
    { view: "integrations", tab: "custom", form: { server: null } },
    { view: "integrations", tab: "custom", form: { server: "invoices" } },
  ] as const)
    expect(pageRoute(routePath(route))).toEqual(route);
  expect(pageFrame("/integrations/custom/new").frame).toBe("integrations");
  expect(
    routeTitle(
      { view: "integrations", tab: "custom", form: { server: null } },
      cs,
    ),
  ).toEqual({
    heading: "Integrace",
    document: "Připojit vlastní MCP server · Integrace — Lazurio",
  });
});

const type = (
  form: CustomForm,
  field: Parameters<typeof withField>[1],
  value: string,
) => withField(form, field, value);

test("a new server opens as Codex does: Streamable HTTP, one empty row in every list, Save disabled", () => {
  const form = newCustomForm();
  expect(form.type).toBe("http");
  expect(form.stdio.args).toEqual([""]);
  expect(form.stdio.env).toHaveLength(1);
  expect(form.http.headers).toHaveLength(1);
  const view = customFormView(form, cs);
  expect(view.title).toBe("Připojit vlastní MCP server");
  expect(view.canSave).toBe(false);
  // An empty required field says nothing; Save waits for it.
  expect([view.name, view.url, view.command]).toEqual([null, null, null]);
  expect(view.headers[0]).toEqual({
    name: null,
    value: null,
    placeholder: "Hodnota",
    stored: false,
  });
  // A name and an address are enough; the empty rows are not sent.
  const ready = type(
    type(form, "name", "Invoices"),
    "url",
    "https://mcp.example.com/mcp",
  );
  expect(customFormView(ready, cs).canSave).toBe(true);
  expect(customBody(ready)).toEqual({
    type: "http",
    name: "Invoices",
    url: "https://mcp.example.com/mcp",
    headers: [],
  });
});

test("switching the type keeps what each type has; STDIO needs a name and a command", () => {
  let form = type(newCustomForm(), "name", "Files");
  form = type(form, "url", "https://mcp.example.com/mcp");
  form = withKey(form, "headers", 0, "name", "X-Team");
  form = withKey(form, "headers", 0, "value", "a");
  form = withType(form, "stdio");
  expect(customFormView(form, en).canSave).toBe(false);
  form = type(form, "command", "npx");
  expect(customFormView(form, en).canSave).toBe(true);
  form = withArg(form, 0, "-y");
  form = addRow(form, "args");
  form = withArg(form, 1, "@example/files mcp");
  form = withKey(form, "env", 0, "name", "TOKEN");
  form = withKey(form, "env", 0, "value", "secret");
  form = type(form, "cwd", "~/code");
  expect(customBody(form)).toEqual({
    type: "stdio",
    name: "Files",
    command: "npx",
    // One argument per row, never split.
    args: ["-y", "@example/files mcp"],
    env: [{ name: "TOKEN", value: "secret" }],
    cwd: "~/code",
  });
  // Back to Streamable HTTP: its address and header are as they were.
  const back = withType(form, "http");
  expect(back.http.url).toBe("https://mcp.example.com/mcp");
  expect(customBody(back)).toEqual({
    type: "http",
    name: "Files",
    url: "https://mcp.example.com/mcp",
    headers: [{ name: "X-Team", value: "a" }],
  });
  // And STDIO's fields survive the trip.
  expect(withType(back, "stdio").stdio).toEqual(form.stdio);
});

test("rows are added at the end and removed where they are; a list may end empty", () => {
  let form = withType(type(newCustomForm(), "name", "Files"), "stdio");
  form = type(form, "command", "uvx");
  form = addRow(addRow(form, "args"), "args");
  form = withArg(withArg(withArg(form, 0, "a"), 1, "b"), 2, "c");
  form = removeRow(form, "args", 1);
  expect(form.stdio.args).toEqual(["a", "c"]);
  form = removeRow(removeRow(form, "args", 0), "args", 0);
  expect(form.stdio.args).toEqual([]);
  expect(customBody(form).args).toEqual([]);
  form = addRow(form, "env");
  expect(form.stdio.env).toHaveLength(2);
  form = withKey(form, "env", 1, "name", "B");
  form = removeRow(form, "env", 0);
  expect(form.stdio.env).toEqual([{ name: "B", value: "", stored: null }]);
  form = addRow(form, "headers");
  expect(form.http.headers).toHaveLength(2);
});

test("lines under the fields: plain words for what is wrong, quiet hints for what is missing", () => {
  let form = type(newCustomForm(), "name", "Remote");
  form = type(form, "url", "http://mcp.example.com/mcp");
  let view = customFormView(form, cs);
  expect(view.url).toEqual({
    text: "Adresa musí začínat https://. http:// jde jen v tomto Prostředí (localhost).",
    kind: "error",
  });
  expect(view.canSave).toBe(false);
  form = type(form, "url", "http://localhost:8931/mcp");
  expect(customFormView(form, cs).url).toBeNull();
  form = withKey(form, "headers", 0, "name", "X-Team");
  view = customFormView(form, cs);
  expect(view.headers[0]?.value).toEqual({
    text: "Doplňte hodnotu.",
    kind: "hint",
  });
  expect(view.canSave).toBe(false);
  form = withKey(form, "headers", 0, "value", "a");
  form = addRow(form, "headers");
  form = withKey(form, "headers", 1, "name", "x-team");
  form = withKey(form, "headers", 1, "value", "b");
  view = customFormView(form, cs);
  expect(view.headers[1]?.name).toEqual({
    text: "Tento klíč je tu dvakrát.",
    kind: "error",
  });
  form = withKey(form, "headers", 1, "name", "Authorization");
  form = type(form, "bearer", "token");
  expect(customFormView(form, cs).headers[1]?.name).toEqual({
    text: "Tuto hlavičku už posílá Bearer token.",
    kind: "error",
  });
  let local = withType(type(newCustomForm(), "name", "Local"), "stdio");
  local = type(local, "command", "server");
  local = withKey(local, "env", 0, "name", "1BAD");
  local = withKey(local, "env", 0, "value", "v");
  local = type(local, "cwd", "code");
  view = customFormView(local, en);
  expect(view.env[0]?.name?.kind).toBe("error");
  expect(view.cwd).toEqual({
    text: "Enter a full path, such as ~/code or /srv/mcp.",
    kind: "error",
  });
  // Lines of the other type are not shown.
  expect(view.headers.every((row) => row.name === null)).toBe(true);
});

test("an edit opens with the names of its keys, their fields empty and stored; empty keeps them", () => {
  const settings = parseCustomSettings({
    kind: "custom-server",
    id: "invoices",
    type: "http",
    name: "Invoices",
    url: "https://mcp.example.com/mcp",
    bearer: true,
    headers: ["X-Team"],
  });
  expect(settings).not.toBeNull();
  let form = editCustomForm(settings as NonNullable<typeof settings>);
  let view = customFormView(form, cs);
  expect(view.title).toBe("Upravit vlastní MCP server");
  expect(view.bearerPlaceholder).toBe("Uloženo");
  expect(view.headers[0]).toMatchObject({
    placeholder: "Uloženo",
    stored: true,
  });
  expect(view.canSave).toBe(true);
  // Saved as it is: every key kept (null), the token too.
  expect(customBody(form)).toEqual({
    id: "invoices",
    type: "http",
    name: "Invoices",
    url: "https://mcp.example.com/mcp",
    bearer: null,
    headers: [{ name: "X-Team", value: null }],
  });
  // The type of a stored server stays.
  expect(withType(form, "stdio").type).toBe("http");
  // A new token: the stored header must come again, and Save waits for it.
  // The field says so by its state alone: no line under it, no note.
  form = type(form, "bearer", "new-token");
  view = customFormView(form, cs);
  expect(view.headers[0]).toEqual({
    name: null,
    value: null,
    placeholder: "Zadejte znovu",
    stored: true,
  });
  expect(view.canSave).toBe(false);
  form = withKey(form, "headers", 0, "value", "a");
  expect(customFormView(form, cs).canSave).toBe(true);
  expect(customBody(form)).toMatchObject({
    bearer: "new-token",
    headers: [{ name: "X-Team", value: "a" }],
  });
  // Removing the stored token: the server then has none, and the header
  // must come again.
  let removed = editCustomForm(settings as NonNullable<typeof settings>);
  removed = withoutStoredBearer(removed);
  expect(customBody(removed)).not.toHaveProperty("bearer");
  expect(customFormView(removed, cs).canSave).toBe(false);
  // A stored key renamed is a new key: it needs a value.
  let renamed = editCustomForm(settings as NonNullable<typeof settings>);
  renamed = withKey(renamed, "headers", 0, "name", "X-Group");
  expect(customFormView(renamed, cs).headers[0]?.value).toEqual({
    text: "Doplňte hodnotu.",
    kind: "hint",
  });
  // A stored key whose name is cleared, value left empty, is removed.
  let cleared = editCustomForm(settings as NonNullable<typeof settings>);
  cleared = withKey(cleared, "headers", 0, "name", "");
  expect(customBody(cleared)).toMatchObject({ headers: [] });
});

test("an edit's new address asks for every stored key again; without stored keys it saves as before", () => {
  const settings = parseCustomSettings({
    kind: "custom-server",
    id: "invoices",
    type: "http",
    name: "Invoices",
    url: "https://mcp.example.com/mcp",
    bearer: true,
    headers: ["X-Team"],
  });
  const stored = settings as NonNullable<typeof settings>;
  let form = type(
    editCustomForm(stored),
    "url",
    "https://mcp.moved.example.com/mcp",
  );
  let view = customFormView(form, cs);
  // The fields' states say it; no line under them, none for the address.
  expect([
    view.bearerPlaceholder,
    view.headers[0]?.placeholder,
    view.bearer,
    view.headers[0]?.value,
    view.url,
    view.canSave,
  ]).toEqual(["Zadejte znovu", "Zadejte znovu", null, null, null, false]);
  form = type(form, "bearer", "token");
  expect(customFormView(form, cs).canSave).toBe(false);
  form = withKey(form, "headers", 0, "value", "a");
  view = customFormView(form, cs);
  expect(view.canSave).toBe(true);
  expect(customBody(form)).toEqual({
    id: "invoices",
    type: "http",
    name: "Invoices",
    url: "https://mcp.moved.example.com/mcp",
    bearer: "token",
    headers: [{ name: "X-Team", value: "a" }],
  });
  // The address set back as it was shown: nothing to type again.
  const back = type(
    type(editCustomForm(stored), "url", "https://mcp.moved.example.com/mcp"),
    "url",
    "https://mcp.example.com/mcp",
  );
  expect(customFormView(back, cs).canSave).toBe(true);
  // A server without stored keys: a new address saves as it is.
  const open = parseCustomSettings({
    kind: "custom-server",
    id: "open",
    type: "http",
    name: "Open",
    url: "https://mcp.open.example.com/mcp",
    bearer: false,
    headers: [],
  });
  const moved = type(
    editCustomForm(open as NonNullable<typeof open>),
    "url",
    "https://mcp.open-moved.example.com/mcp",
  );
  expect(customFormView(moved, cs).canSave).toBe(true);
  expect(customBody(moved)).toEqual({
    id: "open",
    type: "http",
    name: "Open",
    url: "https://mcp.open-moved.example.com/mcp",
    headers: [],
  });
});

test("a command server's edit: configuration shown, variables by name only", () => {
  const settings = parseCustomSettings({
    kind: "custom-server",
    id: "files",
    type: "stdio",
    name: "Files",
    command: "npx",
    args: [],
    cwd: null,
    env: ["TOKEN", "REGION"],
  });
  let form = editCustomForm(settings as NonNullable<typeof settings>);
  expect(form.stdio.args).toEqual([""]);
  expect(form.stdio.env.map((row) => [row.name, row.value])).toEqual([
    ["TOKEN", ""],
    ["REGION", ""],
  ]);
  form = withArg(form, 0, "--readonly");
  expect(customBody(form)).toEqual({
    id: "files",
    type: "stdio",
    name: "Files",
    command: "npx",
    args: ["--readonly"],
    env: [
      { name: "TOKEN", value: null },
      { name: "REGION", value: null },
    ],
  });
  expect(customFormView(form, en).canSave).toBe(true);
  form = removeRow(form, "env", 1);
  const view = customFormView(form, en);
  // One variable gone: the other is typed again, its field marked so.
  expect(view.env[0]).toEqual({
    name: null,
    value: null,
    placeholder: "Enter again",
    stored: true,
  });
  expect(view.canSave).toBe(false);
  // A stored Bearer token to type again is marked the same way.
  const token = parseCustomSettings({
    kind: "custom-server",
    id: "inv",
    type: "http",
    name: "Inv",
    url: "https://mcp.example.com/mcp",
    bearer: true,
    headers: [],
  });
  const retyped = withKey(
    addRow(editCustomForm(token as NonNullable<typeof token>), "headers"),
    "headers",
    1,
    "name",
    "X-Team",
  );
  const marked = customFormView(
    withKey(retyped, "headers", 1, "value", "a"),
    en,
  );
  expect([marked.bearer, marked.bearerPlaceholder, marked.canSave]).toEqual([
    null,
    "Enter again",
    false,
  ]);
});

test("what the page says after a save, and answers it does not take", () => {
  expect(customRefusal("name-taken", cs)).toBe(
    "Integrace s tímto názvem už existuje.",
  );
  expect(customRefusal("account-unknown", en)).toBe(
    "This MCP server is no longer in Executor.",
  );
  expect(customRefusal("connect-failed", en)).toBe(
    "The MCP server could not be saved.",
  );
  expect(customSaved(type(newCustomForm(), "name", " Files "), cs)).toBe(
    "MCP server „Files“ je přidaný.",
  );
  for (const answer of [
    null,
    { kind: "blocked", reason: "account-unknown" },
    { kind: "custom-server", id: "x", name: "X", type: "http", url: 1 },
    {
      kind: "custom-server",
      id: "x",
      name: "X",
      type: "stdio",
      command: "c",
      args: [1],
      cwd: null,
      env: [],
    },
  ])
    expect(parseCustomSettings(answer)).toBeNull();
});
