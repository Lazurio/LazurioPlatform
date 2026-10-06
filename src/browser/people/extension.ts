import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeDurableFile } from "../../update/durable-file";

/** The Lazurio extension of the Environment browser (decision F39 point 7),
 * loaded with `--load-extension` from a directory next to the profile, never
 * inside it. Three jobs, no permissions:
 * - a tab a page opens in a window that already has one moves into a window
 *   of its own, because Chrome paints only visible windows and the people's
 *   view shows one tab per person's tab (point 2);
 * - until the Environment's Bitwarden holds its passkeys (0191 point 17), a
 *   WebAuthn request is declined at once, so Chrome's own passkey window,
 *   which the view cannot show and which blocks the page, never opens;
 * - Chrome's own context menu never opens either: it would sit outside the
 *   page, where nobody sees it. A page's own menu still works. */

export const browserExtensionDirectory = (home: string) =>
  join(home, ".local", "share", "lazurio-browser", "extension");

const manifest = `${JSON.stringify(
  {
    manifest_version: 3,
    name: "Lazurio Environment browser",
    version: "1.0.0",
    description:
      "Keeps every tab of the Environment browser in a window of its own and declines passkey requests until the Environment's Bitwarden holds its passkeys.",
    background: { service_worker: "background.js" },
    content_scripts: [
      {
        matches: ["<all_urls>"],
        js: ["webauthn.js"],
        run_at: "document_start",
        all_frames: true,
        match_about_blank: true,
        world: "MAIN",
      },
      {
        matches: ["<all_urls>"],
        js: ["menu.js"],
        run_at: "document_start",
        all_frames: true,
        match_about_blank: true,
      },
    ],
  },
  null,
  2,
)}\n`;

const background = `// Lazurio (decision F39): a tab opened in a window that already has a tab
// moves into a window of its own. Chrome paints only visible windows, and the
// people's view shows exactly one tab per person's tab. The tab keeps its
// opener, so a page and the tab it opened still talk to each other.
chrome.tabs.onCreated.addListener(async (tab) => {
  try {
    if (tab.id === undefined || tab.windowId === undefined) return;
    const window = await chrome.windows.get(tab.windowId);
    if (window.type !== "normal") return;
    const tabs = await chrome.tabs.query({ windowId: tab.windowId });
    if (tabs.length < 2) return;
    await chrome.windows.create({ tabId: tab.id, focused: false });
  } catch {}
});
`;

const webauthn = `// Lazurio (decision F39, root decision 0191 point 17): until the
// Environment's Bitwarden holds its passkeys, a passkey request is declined at
// once. Chrome's own passkey window opens outside the page, where the people's
// view cannot show it, and the page takes no input until it is closed. A
// declined request lets the site offer another way to sign in.
(() => {
  const Container = globalThis.CredentialsContainer;
  if (!Container) return;
  const decline = () =>
    Promise.reject(
      new DOMException(
        "Passkeys are not available in the Environment browser yet.",
        "NotAllowedError",
      ),
    );
  const get = Container.prototype.get;
  const create = Container.prototype.create;
  Container.prototype.get = function (options) {
    return options && options.publicKey ? decline() : get.call(this, options);
  };
  Container.prototype.create = function (options) {
    return options && options.publicKey ? decline() : create.call(this, options);
  };
  const Credential = globalThis.PublicKeyCredential;
  if (!Credential) return;
  Credential.isUserVerifyingPlatformAuthenticatorAvailable = () =>
    Promise.resolve(false);
  if (Credential.isConditionalMediationAvailable)
    Credential.isConditionalMediationAvailable = () => Promise.resolve(false);
  if (Credential.getClientCapabilities)
    Credential.getClientCapabilities = () =>
      Promise.resolve({
        conditionalCreate: false,
        conditionalGet: false,
        hybridTransport: false,
        passkeyPlatformAuthenticator: false,
        userVerifyingPlatformAuthenticator: false,
      });
})();
`;

const menu = `// Lazurio (decision F39 point 7): Chrome's own context menu would open
// outside the page, where the people's view cannot show it. It is turned off
// for every page: in the capture phase on the window, before any handler of
// the page can stop the event. The page's own handlers still run, so a menu
// the page draws itself still opens.
window.addEventListener("contextmenu", (event) => event.preventDefault(), true);
`;

export const browserExtensionFiles: Readonly<Record<string, string>> =
  Object.freeze({
    "manifest.json": manifest,
    "background.js": background,
    "webauthn.js": webauthn,
    "menu.js": menu,
  });

/** One digest of every file, carried in the browser unit's text, so a new
 * extension changes the unit and restarts the browser (Chrome reads an
 * unpacked extension when it starts). */
export const browserExtensionDigest = createHash("sha256")
  .update(
    Object.entries(browserExtensionFiles)
      .map(([name, text]) => `${name}\0${text}`)
      .join("\0"),
  )
  .digest("hex")
  .slice(0, 16);

/** Writes the files that differ. True when anything was written. */
export async function writeBrowserExtension(home: string): Promise<boolean> {
  const directory = browserExtensionDirectory(home);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let changed = false;
  for (const [name, text] of Object.entries(browserExtensionFiles)) {
    const existing = await readFile(join(directory, name), "utf8").catch(
      () => undefined,
    );
    if (existing === text) continue;
    await writeDurableFile(directory, name, Buffer.from(text));
    changed = true;
  }
  return changed;
}
