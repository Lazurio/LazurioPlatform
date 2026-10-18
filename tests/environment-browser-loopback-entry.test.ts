import { expect, test } from "bun:test";
import { browserEntryOfContext } from "../src/browser/entry";
import {
  browserFlags,
  browserLaunchFlags,
  browserLocalEntry,
  browserResolverRule,
  environmentBaseOf,
  renderBrowserUnit,
  renderBrowserUnits,
} from "../src/browser/units";
import { parseMachineContext } from "../src/machine/context";
import { handoverEntry, withBrowser } from "./fixtures/machine-bindings";
import organization from "./fixtures/machine-context.json";

// LazurioPlatform#504 (F39's addendum of 2026-10-18): a Lazurio session never
// lives in the Environment browser. Its own apps and modules open through the
// gateway's loopback entry for the browser (`entry.browser.local_port`,
// Machines), to which Chrome resolves every name of this Environment; the
// Dashboard, the sign-in service and other Environments stay blocked by the
// browser's policy (Machines) and go to the person's own browser.

const host = "workspace.example.lazurio.io";
const local = Object.freeze({ port: 4443, base: host });
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const withLocal = (localPort: unknown, entry = handoverEntry(host)) => {
  const routed = withBrowser(entry, host);
  return {
    ...organization,
    entry: {
      ...routed,
      browser: { ...routed.browser, local_port: localPort },
    },
  };
};

test("the Environment's name comes from its module origins and always has three labels or more", () => {
  expect(environmentBaseOf(`https://{module}.${host}`)).toBe(host);
  expect(environmentBaseOf("https://{module}.example.lazurio.io")).toBe(
    "example.lazurio.io",
  );
  for (const refused of [
    "https://{module}.lazurio.io",
    "https://{module}.io",
    "http://{module}.workspace.example.lazurio.io",
    "https://{module}.Workspace.example.lazurio.io",
    "https://{module}.workspace.example.lazurio.io/",
    "https://x.{module}.example.lazurio.io",
    'https://{module}.a".example.lazurio.io',
    "https://{module}.a b.example.lazurio.io",
    "https://{module}.$(id).example.lazurio.io",
    null,
    42,
  ])
    expect(environmentBaseOf(refused), String(refused)).toBeNull();
  expect(browserLocalEntry(4443, `https://{module}.${host}`)).toEqual(local);
  for (const port of [1023, 65536, 4443.5, "4443", null])
    expect(
      browserLocalEntry(port, `https://{module}.${host}`),
      String(port),
    ).toBeUndefined();
  expect(
    browserLocalEntry(4443, "https://{module}.lazurio.io"),
  ).toBeUndefined();
});

test("with the loopback entry, Chrome resolves this Environment's names, the bare one too, to it; without it the flags are unchanged", () => {
  expect(browserResolverRule(local)).toBe(
    `MAP *.${host} 127.0.0.1:4443,MAP ${host} 127.0.0.1:4443`,
  );
  expect(browserLaunchFlags()).toEqual(browserFlags);
  expect(browserLaunchFlags(local)).toEqual([
    ...browserFlags,
    `--host-resolver-rules=MAP *.${host} 127.0.0.1:4443,MAP ${host} 127.0.0.1:4443`,
  ]);
  // No proxy flags: Chrome reads --proxy-bypass-list only with
  // --proxy-server, and a guest that forces a proxy already bypasses it for
  // its own names in no_proxy (Machines#586).
  expect(browserLaunchFlags(local).join(" ")).not.toContain("proxy");
  // The unit: the rule is one double-quoted word of the shell's command, so
  // neither its spaces nor its `*` split or expand it.
  const without = renderBrowserUnit();
  const withEntry = renderBrowserUnit(local);
  const exec = (unit: string) =>
    unit.split("\n").find((line) => line.startsWith("ExecStart=")) ?? "";
  expect(exec(withEntry)).toBe(
    exec(without).replace(
      " about:blank'",
      ` "--host-resolver-rules=MAP *.${host} 127.0.0.1:4443,MAP ${host} 127.0.0.1:4443" about:blank'`,
    ),
  );
  expect(
    withEntry.split("\n").filter((line) => !line.startsWith("ExecStart=")),
  ).toEqual(
    without.split("\n").filter((line) => !line.startsWith("ExecStart=")),
  );
  // The three units of an entry with and without it differ only in the
  // browser's, so adding the entry restarts the browser and nothing else.
  const entry = { origin: `https://browser.${host}`, listenPort: 4848 };
  const selector = "/home/operator/.local/share/lazurio/bin/lazurio";
  const before = renderBrowserUnits(entry, selector);
  const after = renderBrowserUnits({ ...entry, local }, selector);
  expect(after["lazurio-display.service"]).toBe(
    before["lazurio-display.service"],
  );
  expect(after["lazurio-browser-view.service"]).toBe(
    before["lazurio-browser-view.service"],
  );
  expect(after["lazurio-browser.service"]).toBe(withEntry);
});

test("the handover's local_port is the loopback entry; absent or out of range, nothing changes or the handover is refused", () => {
  const plain = parseMachineContext(
    bytes({ ...organization, entry: withBrowser(handoverEntry(host), host) }),
  );
  expect(browserEntryOfContext(plain)).toEqual({
    origin: `https://browser.${host}`,
    listenPort: 4848,
  });
  expect(
    browserEntryOfContext(parseMachineContext(bytes(withLocal(4443)))),
  ).toEqual({
    origin: `https://browser.${host}`,
    listenPort: 4848,
    local,
  });
  // The schema's range, as for every other port of the entry.
  for (const port of [80, 70000, "4443", 4443.5])
    expect(
      () => parseMachineContext(bytes(withLocal(port))),
      String(port),
    ).toThrow();
  // Module origins whose name is too short for a rule: no loopback entry.
  const short = withLocal(4443, handoverEntry("lazurio.io"));
  expect(
    browserEntryOfContext(parseMachineContext(bytes(short))),
  ).not.toHaveProperty("local");
  // No browser, no entry.
  expect(
    browserEntryOfContext(
      parseMachineContext(
        bytes({ ...organization, entry: handoverEntry(host) }),
      ),
    ),
  ).toBeUndefined();
});
