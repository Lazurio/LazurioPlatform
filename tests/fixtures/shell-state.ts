import { readAccountJson } from "../../src/shell/account";
import { createLastReport } from "../../src/shell/last";
import { createShellState } from "../../src/shell/state";
import { accountDocument } from "./account-document";

// The shell elements' state (src/shell/state.ts) with every effect observed,
// for the host-page suites (F36's addenda of 2026-10-05 and 2026-10-06).

/** A browser memory that records every call: `get <key>`, `set <key>`,
 * `remove <key>`. */
export const spyStore = () => {
  const calls: string[] = [];
  const values = new Map<string, string>();
  return {
    calls,
    values,
    getItem: (key: string) => {
      calls.push(`get ${key}`);
      return values.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      calls.push(`set ${key}`);
      values.set(key, value);
    },
    removeItem: (key: string) => {
      calls.push(`remove ${key}`);
      values.delete(key);
    },
  };
};

const answer = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
const quiet = () => {};

/** A state of the elements with every effect observed: the account read
 * through a fetcher spy (which answers `accountDocument()`), the browser's
 * memory, the report's transport and the debug lines; `asked` counts how
 * often the document's marker was read. */
export const observedState = (source: "host" | "origin") => {
  const requests: string[] = [];
  const sent: string[] = [];
  const lines: string[] = [];
  const store = spyStore();
  let asked = 0;
  const state = createShellState({
    source: () => {
      asked += 1;
      return source;
    },
    read: () =>
      readAccountJson(
        async (path) => {
          requests.push(path);
          return answer(accountDocument());
        },
        1_000,
        quiet,
        store,
      ),
    report: createLastReport(async (body) => {
      sent.push(body);
    }),
    store,
    log: (line) => lines.push(line),
  });
  return { state, requests, sent, lines, store, asked: () => asked };
};
