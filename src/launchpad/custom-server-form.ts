import {
  type CustomKey,
  type CustomProblem,
  type CustomServerInput,
  type CustomServerSettings,
  type CustomStored,
  type CustomType,
  customProblems,
  keysChange,
  storedOf,
} from "../integrations/custom-server";
import type { MessageKey } from "./messages";
import { fill } from "./update-view";

type Copy = Readonly<Record<MessageKey, string>>;

// The page of a custom MCP server (decision F42, addendum of 2026-10-11):
// Codex Desktop's "Connect to a custom MCP" in the Lazurio look. Pure, so
// it is tested without a DOM; integrations-panel.ts draws it. The form
// keeps the fields of both types, so switching the type and back loses
// nothing; it checks with the server's own rules (custom-server.ts) and
// enables Save only when they pass. A key typed here lives only in this
// form until it is sent once; an edited server's keys are never sent to
// the page: their fields start empty, marked as stored, and an empty field
// keeps the stored value.

/** A key of the form. `stored` is the name of the key Executor keeps that
 * this row shows, or null for a new one; renamed, it is a new key. */
export type KeyRow = Readonly<{
  name: string;
  value: string;
  stored: string | null;
}>;

export type KeyList = "env" | "headers";
export type RowList = "args" | KeyList;

export type CustomForm = Readonly<{
  /** The edited server's id, null for a new one. */
  id: string | null;
  type: CustomType;
  name: string;
  stdio: Readonly<{
    command: string;
    args: readonly string[];
    env: readonly KeyRow[];
    cwd: string;
  }>;
  http: Readonly<{
    url: string;
    bearer: string;
    /** The edited server has a Bearer token stored. */
    bearerStored: boolean;
    headers: readonly KeyRow[];
  }>;
  /** What the edited server stores; null for a new one. */
  stored: CustomStored | null;
}>;

const emptyKey: KeyRow = { name: "", value: "", stored: null };

/** A new server: Streamable HTTP first, one empty row in every list, as
 * Codex opens it. */
export function newCustomForm(): CustomForm {
  return {
    id: null,
    type: "http",
    name: "",
    stdio: { command: "", args: [""], env: [emptyKey], cwd: "" },
    http: { url: "", bearer: "", bearerStored: false, headers: [emptyKey] },
    stored: null,
  };
}

/** An existing server, as the server answers its settings: the keys by
 * name, their values empty and kept. */
export function editCustomForm(settings: CustomServerSettings): CustomForm {
  const rows = (names: readonly string[]) =>
    names.length === 0
      ? [emptyKey]
      : names.map((name) => ({ name, value: "", stored: name }));
  const base = newCustomForm();
  return settings.type === "stdio"
    ? {
        ...base,
        id: settings.id,
        type: "stdio",
        name: settings.name,
        stdio: {
          command: settings.command,
          args: settings.args.length === 0 ? [""] : [...settings.args],
          env: rows(settings.env),
          cwd: settings.cwd ?? "",
        },
        stored: storedOf(settings),
      }
    : {
        ...base,
        id: settings.id,
        type: "http",
        name: settings.name,
        http: {
          url: settings.url,
          bearer: "",
          bearerStored: settings.bearer,
          headers: rows(settings.headers),
        },
        stored: storedOf(settings),
      };
}

/** Switches the type of a new server; each type keeps what was typed. An
 * existing server keeps its type. */
export function withType(form: CustomForm, type: CustomType): CustomForm {
  return form.id === null ? { ...form, type } : form;
}

export type FieldName = "name" | "command" | "cwd" | "url" | "bearer";

export function withField(
  form: CustomForm,
  field: FieldName,
  value: string,
): CustomForm {
  if (field === "name") return { ...form, name: value };
  if (field === "command")
    return { ...form, stdio: { ...form.stdio, command: value } };
  if (field === "cwd") return { ...form, stdio: { ...form.stdio, cwd: value } };
  if (field === "url") return { ...form, http: { ...form.http, url: value } };
  return { ...form, http: { ...form.http, bearer: value } };
}

/** Forgets a stored Bearer token: the server then has none. */
export function withoutStoredBearer(form: CustomForm): CustomForm {
  return { ...form, http: { ...form.http, bearer: "", bearerStored: false } };
}

const listOf = (form: CustomForm, list: KeyList): readonly KeyRow[] =>
  list === "env" ? form.stdio.env : form.http.headers;

const withList = (
  form: CustomForm,
  list: KeyList,
  rows: readonly KeyRow[],
): CustomForm =>
  list === "env"
    ? { ...form, stdio: { ...form.stdio, env: rows } }
    : { ...form, http: { ...form.http, headers: rows } };

export function withArg(
  form: CustomForm,
  index: number,
  value: string,
): CustomForm {
  return {
    ...form,
    stdio: {
      ...form.stdio,
      args: form.stdio.args.map((arg, at) => (at === index ? value : arg)),
    },
  };
}

export function withKey(
  form: CustomForm,
  list: KeyList,
  index: number,
  part: "name" | "value",
  value: string,
): CustomForm {
  return withList(
    form,
    list,
    listOf(form, list).map((row, at) =>
      at === index ? { ...row, [part]: value } : row,
    ),
  );
}

/** Adds an empty row at the end of a list. */
export function addRow(form: CustomForm, list: RowList): CustomForm {
  if (list === "args")
    return {
      ...form,
      stdio: { ...form.stdio, args: [...form.stdio.args, ""] },
    };
  return withList(form, list, [...listOf(form, list), emptyKey]);
}

/** Removes a row; a list may end empty, with its "+ Přidat" left. */
export function removeRow(
  form: CustomForm,
  list: RowList,
  index: number,
): CustomForm {
  if (list === "args")
    return {
      ...form,
      stdio: {
        ...form.stdio,
        args: form.stdio.args.filter((_, at) => at !== index),
      },
    };
  return withList(
    form,
    list,
    listOf(form, list).filter((_, at) => at !== index),
  );
}

const fold = (type: CustomType, name: string) =>
  type === "http" ? name.trim().toLowerCase() : name.trim();

/** Whether a row shows a stored key under its own name: then an empty
 * field keeps the stored value. */
const keeps = (type: CustomType, row: KeyRow) =>
  row.stored !== null && fold(type, row.stored) === fold(type, row.name);

const blank = (row: KeyRow) =>
  row.name.trim() === "" && row.value === "" && row.stored === null;

/** The rows the form sends, with the index each has on the page. */
function sentKeys(
  type: CustomType,
  rows: readonly KeyRow[],
): Readonly<{ keys: CustomKey[]; at: number[] }> {
  const keys: CustomKey[] = [];
  const at: number[] = [];
  rows.forEach((row, index) => {
    // A row left empty is unfinished, not a key; a stored key whose name
    // was cleared is removed.
    if (
      blank(row) ||
      (row.stored !== null && row.name.trim() === "" && row.value === "")
    )
      return;
    keys.push({
      name: row.name,
      value: row.value === "" && keeps(type, row) ? null : row.value,
    });
    at.push(index);
  });
  return { keys, at };
}

/** The server the form sends: what the routes take, its empty rows left
 * out, a stored key with an empty field kept (null). */
export function customInput(form: CustomForm): CustomServerInput {
  if (form.type === "stdio")
    return {
      type: "stdio",
      name: form.name,
      command: form.stdio.command,
      args: form.stdio.args.filter((arg) => arg.trim() !== ""),
      env: sentKeys("stdio", form.stdio.env).keys,
      cwd: form.stdio.cwd.trim() === "" ? null : form.stdio.cwd,
    };
  return {
    type: "http",
    name: form.name,
    url: form.http.url,
    bearer:
      form.http.bearer !== ""
        ? { value: form.http.bearer }
        : form.http.bearerStored
          ? { value: null }
          : null,
    headers: sentKeys("http", form.http.headers).keys,
  };
}

/** The body of the save: the add's, or the update's with the server's id. */
export function customBody(form: CustomForm): Record<string, unknown> {
  const input = customInput(form);
  const id = form.id === null ? {} : { id: form.id };
  if (input.type === "stdio")
    return {
      ...id,
      type: "stdio",
      name: input.name,
      command: input.command,
      args: input.args,
      env: input.env,
      ...(input.cwd === null ? {} : { cwd: input.cwd }),
    };
  return {
    ...id,
    type: "http",
    name: input.name,
    url: input.url,
    // Absent: no token; null: keep the stored one.
    ...(input.bearer === null ? {} : { bearer: input.bearer.value }),
    headers: input.headers,
  };
}

/** A line under a field: a problem in the danger colour, a hint quietly. */
export type FieldLine = Readonly<{ text: string; kind: "error" | "hint" }>;

export type KeyView = Readonly<{
  name: FieldLine | null;
  value: FieldLine | null;
  /** The value field's placeholder: "Hodnota", "Uloženo", "Zadej znovu". */
  placeholder: string;
  stored: boolean;
}>;

export type CustomFormView = Readonly<{
  title: string;
  canSave: boolean;
  name: FieldLine | null;
  command: FieldLine | null;
  cwd: FieldLine | null;
  url: FieldLine | null;
  bearer: FieldLine | null;
  bearerPlaceholder: string;
  args: readonly (FieldLine | null)[];
  env: readonly KeyView[];
  headers: readonly KeyView[];
}>;

function problemText(
  problem: CustomProblem,
  type: CustomType,
  copy: Copy,
): FieldLine | null {
  const error = (text: string): FieldLine => ({ text, kind: "error" });
  const hint = (text: string): FieldLine => ({ text, kind: "hint" });
  const kind = problem.problem;
  // A stored key to type again says so in its own field ("Zadej znovu"),
  // never in a line under it: the page explains nothing in text of its own.
  if (kind === "again") return null;
  if (kind === "duplicate") return error(copy.integrationsMcpDuplicate);
  if (kind === "taken") return error(copy.integrationsMcpBearerTaken);
  if (kind === "insecure") return error(copy.integrationsMcpUrlInsecure);
  if (problem.field === "env" || problem.field === "header") {
    if (kind === "required")
      return hint(
        problem.part === "name"
          ? copy.integrationsMcpKeyRequired
          : copy.integrationsMcpValueRequired,
      );
    return error(
      problem.part === "value"
        ? copy.integrationsMcpValueInvalid
        : type === "stdio"
          ? copy.integrationsMcpEnvNameInvalid
          : copy.integrationsMcpHeaderNameInvalid,
    );
  }
  // An empty required field says nothing: Save simply waits for it.
  if (kind === "required")
    return problem.field === "bearer"
      ? hint(copy.integrationsMcpValueRequired)
      : null;
  if (problem.field === "url") return error(copy.integrationsMcpUrlInvalid);
  if (problem.field === "cwd") return error(copy.integrationsMcpCwdInvalid);
  if (problem.field === "arg") return error(copy.integrationsMcpTextInvalid);
  if (problem.field === "name") return error(copy.integrationsMcpNameInvalid);
  return error(copy.integrationsMcpTextInvalid);
}

/** What the page shows for the form: a line under each field that needs
 * one, the placeholders of the key fields, and whether Save is enabled. */
export function customFormView(form: CustomForm, copy: Copy): CustomFormView {
  const input = customInput(form);
  const problems = customProblems(input, form.stored);
  const changed = form.stored !== null && keysChange(input, form.stored);
  const rows = form.type === "stdio" ? form.stdio.env : form.http.headers;
  const sent = sentKeys(form.type, rows);
  const line = (field: CustomProblem["field"]) => {
    const found = problems.find((item) => item.field === field);
    return found === undefined ? null : problemText(found, form.type, copy);
  };
  const keyViews = (list: KeyList): KeyView[] => {
    const own = listOf(form, list);
    const listed = list === "env" ? "stdio" : "http";
    return own.map((row, index) => {
      const at = form.type === listed ? sent.at.indexOf(index) : -1;
      const of = (part: "name" | "value") => {
        const found = problems.find(
          (item) =>
            (item.field === "env" || item.field === "header") &&
            item.index === at &&
            item.part === part,
        );
        return found === undefined || at < 0
          ? null
          : problemText(found, form.type, copy);
      };
      const stored = keeps(listed, row);
      return {
        name: of("name"),
        value: of("value"),
        placeholder: !stored
          ? copy.integrationsMcpValue
          : changed
            ? copy.integrationsMcpEnterAgain
            : copy.integrationsMcpStored,
        stored,
      };
    });
  };
  return {
    title:
      form.id === null
        ? copy.integrationsMcpPageTitle
        : copy.integrationsMcpEditTitle,
    canSave: problems.length === 0,
    name: line("name"),
    command: line("command"),
    cwd: line("cwd"),
    url: line("url"),
    bearer: line("bearer"),
    bearerPlaceholder: !form.http.bearerStored
      ? ""
      : changed
        ? copy.integrationsMcpEnterAgain
        : copy.integrationsMcpStored,
    args: form.stdio.args.map((arg, index) => {
      if (form.type !== "stdio" || arg.trim() === "") return null;
      const sentAt = form.stdio.args
        .slice(0, index)
        .filter((item) => item.trim() !== "").length;
      const found = problems.find(
        (item) => item.field === "arg" && item.index === sentAt,
      );
      return found === undefined ? null : problemText(found, "stdio", copy);
    }),
    env: keyViews("env"),
    headers: keyViews("headers"),
  };
}

/** The line the page says after a save that did not go through. */
export function customRefusal(reason: unknown, copy: Copy): string {
  if (reason === "name-taken") return copy.integrationsMcpNameTaken;
  if (reason === "executor-unavailable")
    return copy.integrationsExecutorUnavailable;
  if (reason === "account-unknown") return copy.integrationsMcpGone;
  if (reason === "invalid-server") return copy.integrationsMcpInvalid;
  if (reason === "browser-unavailable") return copy.integrationsBrowserMissing;
  return copy.integrationsMcpSaveFailed;
}

/** The line in Vlastní after a save went through. */
export function customSaved(form: CustomForm, copy: Copy): string {
  return fill(
    form.id === null ? copy.integrationsMcpAdded : copy.integrationsMcpSaved,
    { name: form.name.trim() },
  );
}

/** `GET /api/integrations/custom/server` as the page takes it, or null for
 * any other answer. */
export function parseCustomSettings(
  value: unknown,
): CustomServerSettings | null {
  if (typeof value !== "object" || value === null) return null;
  const settings = value as Record<string, unknown>;
  const strings = (list: unknown) =>
    Array.isArray(list) && list.every((item) => typeof item === "string");
  if (
    settings.kind !== "custom-server" ||
    typeof settings.id !== "string" ||
    typeof settings.name !== "string"
  )
    return null;
  if (
    settings.type === "stdio" &&
    typeof settings.command === "string" &&
    strings(settings.args) &&
    strings(settings.env) &&
    (settings.cwd === null || typeof settings.cwd === "string")
  )
    return settings as CustomServerSettings;
  if (
    settings.type === "http" &&
    typeof settings.url === "string" &&
    typeof settings.bearer === "boolean" &&
    strings(settings.headers)
  )
    return settings as CustomServerSettings;
  return null;
}
