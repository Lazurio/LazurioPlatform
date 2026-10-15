import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { messages } from "../src/launchpad/messages";
import { workspaceGroupsKey } from "../src/launchpad/workspace-groups";
import { accountDocument } from "../tests/fixtures/account-document";

// Real Launchpad against scripts/preview-launchpad.ts's synthetic Folder.
// External Playwright/Chromium, as in smoke-application-ui.ts. No live Folder.
const { chromium } = createRequire(import.meta.url)("playwright");
const url = process.argv[2];
assert.ok(url, "Pass the local preview URL, including its fragment credential");
const copy = messages(process.argv[3] === "en" ? "en" : "cs");
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await context.route(
    "**/*",
    (route: {
      request(): { url(): string };
      continue(): Promise<void>;
      abort(): Promise<void>;
    }) =>
      new URL(route.request().url()).origin === new URL(url).origin
        ? route.continue()
        : route.abort(),
  );
  let login: string | null = "ada";
  let releaseAccount: () => void = () => {};
  const firstAccount = new Promise<void>((resolve) => {
    releaseAccount = resolve;
  });
  await context.route(
    "**/.lazurio/account/environments",
    async (route: { fulfill(options: unknown): Promise<void> }) => {
      await firstAccount;
      return route.fulfill(
        login === null
          ? { status: 404, body: "" }
          : {
              contentType: "application/json",
              body: JSON.stringify(
                accountDocument({
                  operator: { login, initials: "A", avatar: null },
                  favourites: {
                    example: [{ kind: "module", id: "mission-control" }],
                  },
                }),
              ),
            },
      );
    },
  );
  const page = await context.newPage();
  const reload = async () => {
    // Local admission consumes the fragment on boot; reopen with the same
    // synthetic preview credential, as a new CLI-opened page does.
    await page.evaluate(
      (hash: string) =>
        history.replaceState(null, "", location.pathname + hash),
      new URL(url).hash,
    );
    await page.reload();
  };
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.goto(url);
  const work = page.getByRole("tab", { name: new RegExp(copy.appsGroupWork) });
  const admin = page.getByRole("tab", {
    name: new RegExp(copy.appsGroupAdministration),
  });
  const menu = (name: string) =>
    page.getByRole("button", {
      name: copy.appsMore.replace("{name}", name),
      exact: true,
    });
  const move = async (name: string, to: "work" | "administration") => {
    console.log("Move", name, to, login ?? "unavailable");
    await page.waitForFunction(
      (label: string) =>
        Array.from(
          document.querySelectorAll<HTMLButtonElement>(".tile-menu-item"),
        ).some(
          (button) => button.textContent?.includes(label) && !button.disabled,
        ),
      to === "work" ? copy.appsGroupMoveWork : copy.appsGroupMoveAdministration,
    );
    if ((await work.getAttribute("aria-selected")) === "true")
      await page.locator(".tile--new").waitFor();
    await menu(name).click();
    // Another tab clearing its browser preferences redraws the catalog.
    // The open menu must survive so the next action remains usable.
    await page.evaluate(() =>
      window.dispatchEvent(new StorageEvent("storage", { key: null })),
    );
    await page
      .getByRole("menuitem", {
        name:
          to === "work"
            ? copy.appsGroupMoveWork
            : copy.appsGroupMoveAdministration,
        exact: true,
      })
      .click();
  };
  await work.waitFor();
  await menu("Mission Control").waitFor();
  assert.equal(await work.getAttribute("aria-selected"), "true");
  assert.equal(
    await page
      .locator('[data-section="workspace"] .tile[data-kind="module"]')
      .count(),
    6,
  );
  assert.equal(
    await page.locator('[data-section="productionspace"] .tile').count(),
    2,
  );
  // A tab chosen while the account is still loading must remain chosen
  // once its saved assignments arrive.
  await admin.click();
  releaseAccount();
  await page.waitForFunction(
    () => !document.querySelector("#catalog-favorites .column-hint"),
  );
  assert.equal(await admin.getAttribute("aria-selected"), "true");
  await work.click();
  await move("Mission Control", "administration");
  assert.equal(await menu("Mission Control").count(), 0);
  assert.ok((await admin.textContent()).includes("1"));
  assert.equal(
    await page
      .locator("#catalog-favorites")
      .getByText("Mission Control", { exact: true })
      .count(),
    1,
  );
  await admin.click();
  await menu("Mission Control").waitFor();
  await reload();
  await work.waitFor();
  assert.equal(await work.getAttribute("aria-selected"), "true");
  assert.equal(await menu("Mission Control").count(), 0);
  await work.focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await admin.getAttribute("aria-selected"), "true");
  assert.equal(
    await admin.evaluate(
      (node: HTMLElement) => node === document.activeElement,
    ),
    true,
  );
  await page.keyboard.press("Home");
  assert.equal(await work.getAttribute("aria-selected"), "true");
  await page.keyboard.press("End");
  await move("Mission Control", "work");
  assert.ok(
    (await page.getByRole("tabpanel").textContent()).includes(
      copy.appsGroupAdministrationEmpty,
    ),
  );
  await work.click();
  await menu("Mission Control").waitFor();

  // A failed write must leave the tile and its persisted group intact.
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new Error("fixture quota");
    };
  });
  await move("Mission Control", "administration");
  assert.equal(await menu("Mission Control").count(), 1);
  assert.ok(
    (await page.locator("#toast").textContent()).includes(
      copy.appsGroupSaveFailed,
    ),
  );
  await reload();
  await work.waitFor();
  await move("Mission Control", "administration");
  login = "bob";
  await reload();
  await work.waitFor();
  await menu("Mission Control").waitFor();
  login = "ada";
  await reload();
  await work.waitFor();
  await page.waitForFunction(() =>
    document
      .querySelector('[role="tab"][aria-selected="true"]')
      ?.textContent?.includes("5"),
  );
  assert.equal(await menu("Mission Control").count(), 0);
  const original = new URL(url);
  await page.goto(new URL("/o/northwind", url).href + original.hash);
  await work.waitFor();
  assert.ok((await admin.textContent()).includes("0"));
  await page.goto(url);
  await work.waitFor();
  await admin.click();
  await menu("Mission Control").waitFor();

  // Removing account availability must not load the previous person's groups.
  login = null;
  await reload();
  await work.waitFor();
  await menu("Mission Control").waitFor();
  await move("Mission Control", "administration");
  assert.ok(
    (await page.locator("#toast").textContent()).includes(
      copy.appsGroupsTemporary,
    ),
  );
  await reload();
  await work.waitFor();
  await menu("Mission Control").waitFor();

  // Storage corruption defaults to a complete Work list, never an empty home.
  login = "ada";
  await page.evaluate(
    (key: string) => localStorage.setItem(key, "broken"),
    workspaceGroupsKey("ada", { kind: "organization", id: "example" }),
  );
  await reload();
  await work.waitFor();
  await menu("Mission Control").waitFor();

  // No-app/broken modules remain visible and reversible too.
  await move("brainstorm", "administration");
  await admin.click();
  await menu("brainstorm").waitFor();
  await page.setViewportSize({ width: 375, height: 812 });
  assert.equal(await admin.isVisible(), true);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await move("brainstorm", "work");
  await work.click();
  await menu("brainstorm").waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: tabs, keyboard, counts, move/reverse/reload, favorites, person/Organization isolation, unavailable account, failed storage, malformed storage, no-app module and narrow layout",
  );
} catch (error) {
  const failedPage = browser.contexts()[0]?.pages()[0];
  if (failedPage)
    console.error(
      "Page at failure:",
      new URL(failedPage.url()).pathname,
      (await failedPage.locator("body").innerText()).slice(0, 1800),
    );
  throw error;
} finally {
  await browser.close();
}
