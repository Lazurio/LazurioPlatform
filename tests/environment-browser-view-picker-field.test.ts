import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  browserSocketUrl,
  type CdpConnection,
  connectCdp,
} from "../src/browser/people/cdp";

// The view's own field for a page's date (#970, the step base of the review
// of #972), in a real browser: the view's picker module is built for the
// browser, opened on a page's `<input type=date min=invalid value=2026-11-11
// step=7>` whose person moved it to 2026-11-18, and the browser decides what
// is valid and what the view sends. Run in headless Chrome over DevTools with
// this repository's own client, as tests/launchpad-app-click.test.ts does;
// skipped where no Chrome is installed. `LAZURIO_TEST_CHROME` names one.

const chrome: string | null = (() => {
  const named = process.env.LAZURIO_TEST_CHROME;
  if (named !== undefined && named !== "") return named;
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (process.platform === "darwin" && existsSync(mac)) return mac;
  for (const name of [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
  ]) {
    const found = Bun.which(name);
    if (found !== null) return found;
  }
  return null;
})();

type Page = Readonly<{
  evaluate: (expression: string) => Promise<unknown>;
  close: () => Promise<void>;
}>;

/** A headless Chrome of its own profile with one blank tab. */
async function headlessChrome(executable: string): Promise<Page> {
  const profile = await realpath(
    await mkdtemp(join(tmpdir(), "view-picker-field-chrome-")),
  );
  const child = Bun.spawn(
    [
      executable,
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      // The runners' Linux user namespaces refuse Chrome's own sandbox; the
      // tab only runs this test's own script on about:blank.
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  const portFile = join(profile, "DevToolsActivePort");
  const started = Date.now();
  // A cold Chrome on a Linux runner that runs four test files at once can
  // take longer than 15 s to write its port (#1065's shards); 45 s, as in
  // public-vault.test.ts and launchpad-app-click.test.ts.
  while (!existsSync(portFile)) {
    if (Date.now() - started > 45_000) throw new Error("Chrome did not start");
    await Bun.sleep(100);
  }
  const port = Number((await readFile(portFile, "utf8")).split("\n")[0]);
  const cdp: CdpConnection = await connectCdp(await browserSocketUrl(port));
  const { targetId } = (await cdp.send("Target.createTarget", {
    url: "about:blank",
  })) as { targetId: string };
  const { sessionId } = (await cdp.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  })) as { sessionId: string };
  return {
    async evaluate(expression) {
      const answer = (await cdp.send(
        "Runtime.evaluate",
        { returnByValue: true, awaitPromise: true, expression },
        sessionId,
      )) as {
        result: { value?: unknown };
        exceptionDetails?: { exception?: { description?: string } };
      };
      if (answer.exceptionDetails !== undefined)
        throw new Error(
          answer.exceptionDetails.exception?.description ?? "page error",
        );
      return answer.result.value;
    },
    async close() {
      cdp.close();
      child.kill();
      await child.exited;
      await rm(profile, { recursive: true, force: true });
    },
  };
}

/** The view's picker module and its words, built for the browser and put on
 * `globalThis.lazurioPicker`. */
async function pickerBundle(): Promise<string> {
  const folder = await realpath(
    await mkdtemp(join(tmpdir(), "view-picker-field-build-")),
  );
  const source = join(import.meta.dir, "..", "src", "browser", "people");
  const entry = join(folder, "entry.ts");
  await writeFile(
    entry,
    [
      `import { PickerView } from ${JSON.stringify(join(source, "picker-view"))};`,
      `import { en } from ${JSON.stringify(join(source, "words"))};`,
      "(globalThis as Record<string, unknown>).lazurioPicker = { PickerView, en };",
    ].join("\n"),
  );
  try {
    const built = await Bun.build({
      entrypoints: [entry],
      target: "browser",
      format: "iife",
    });
    if (!built.success || built.outputs[0] === undefined)
      throw new Error(built.logs.map(String).join("\n"));
    return await built.outputs[0].text();
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

let page: Page | null = null;

beforeAll(async () => {
  if (chrome === null) return;
  page = await headlessChrome(chrome);
  await page.evaluate(await pickerBundle());
}, 90_000);

afterAll(async () => {
  await page?.close();
});

/** Opens the view's field for the page's date and returns what the browser
 * says of the copy and what the view sends on Apply after `edit`. */
async function openField(edit: string | null): Promise<{
  shown: string;
  valueAttribute: string | null;
  valid: boolean;
  applyDisabled: boolean;
  sent: unknown[];
}> {
  const answer = await (page as Page).evaluate(`(() => {
    document.body.replaceChildren();
    const box = document.createElement("div");
    box.style.cssText = "position: fixed; inset: 0;";
    document.body.append(box);
    const sent = [];
    new globalThis.lazurioPicker.PickerView({
      message: {
        t: "picker",
        token: "t1",
        kind: "date",
        rect: { x: 10, y: 10, width: 140, height: 24 },
        name: "",
        // The page: <input type=date min=invalid value=2026-11-11 step=7>,
        // moved by its person a week on.
        value: "2026-11-18",
        min: "invalid",
        max: "",
        step: "7",
        base: "2026-11-11",
      },
      box,
      control: { x: 10, y: 10, width: 140, height: 24 },
      say: globalThis.lazurioPicker.en,
      send: (message) => sent.push(message),
      closed: () => {},
    });
    const input = document.querySelector(".picker-field");
    const shown = input.value;
    const edit = ${JSON.stringify(edit)};
    if (edit !== null) {
      input.value = edit;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const apply = document.querySelector(".picker-form .button.primary");
    const result = {
      shown,
      valueAttribute: input.getAttribute("value"),
      valid: input.checkValidity(),
      applyDisabled: apply.disabled,
    };
    document.querySelector(".picker-form").requestSubmit();
    return JSON.stringify({ ...result, sent });
  })()`);
  return JSON.parse(String(answer));
}

test.skipIf(chrome === null)(
  "beside an invalid min, the page's own week is valid in the view's field and Apply sends it",
  async () => {
    const opened = await openField(null);
    expect(opened.shown).toBe("2026-11-18");
    // The copy counts its weeks from the page's value attribute, as Chrome
    // does on the page when min is invalid.
    expect(opened.valueAttribute).toBe("2026-11-11");
    expect(opened.valid).toBe(true);
    expect(opened.applyDisabled).toBe(false);
    expect(opened.sent).toEqual([
      { t: "pick", token: "t1", value: "2026-11-18" },
    ]);
  },
);

test.skipIf(chrome === null)(
  "a person who moves the field to another valid week applies it; a day off the steps is refused",
  async () => {
    const twoWeeks = await openField("2026-11-25");
    expect(twoWeeks.valid).toBe(true);
    expect(twoWeeks.sent).toEqual([
      { t: "pick", token: "t1", value: "2026-11-25" },
    ]);
    const dayOff = await openField("2026-11-19");
    expect(dayOff.valid).toBe(false);
    expect(dayOff.applyDisabled).toBe(true);
    expect(dayOff.sent).toEqual([]);
  },
);
