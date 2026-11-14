import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeDurableFile } from "../../update/durable-file";

/** The Lazurio extension of the Environment browser (decision F39 point 7),
 * loaded with `--load-extension` from a directory next to the profile, never
 * inside it. Five jobs, no permissions:
 * - a tab a page opens in a window that already has one moves into a window
 *   of its own, because Chrome paints only visible windows and the people's
 *   view shows one tab per person's tab (point 2);
 * - until the Environment's Bitwarden holds its passkeys (0191 point 17), a
 *   WebAuthn request is declined at once, so Chrome's own passkey window,
 *   which the view cannot show and which blocks the page, never opens;
 * - a payment through the browser (`PaymentRequest`: Google Pay and the
 *   other payment apps Chrome opens a window for) is declined: the page hears
 *   that no payment app is ready and `show()` is refused. What the page
 *   offers then is the site's (F39's addendum of 2026-11-14);
 * - Chrome's other windows over the page never open either: the print
 *   preview, the picker of a screen to share, a sign-in through an identity
 *   provider's button (FedCM's active mode), a digital wallet, the chooser of
 *   a device and the eyedropper. Each is answered as when a person closes it
 *   (the same addendum);
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
      "Keeps every tab of the Environment browser in a window of its own, declines passkey requests until the Environment's Bitwarden holds its passkeys, and declines payments and the other Chrome windows the people's view cannot show.",
    background: { service_worker: "background.js" },
    content_scripts: [
      {
        matches: ["<all_urls>"],
        js: ["webauthn.js", "payment.js", "sheets.js"],
        run_at: "document_start",
        all_frames: true,
        match_about_blank: true,
        match_origin_as_fallback: true,
        world: "MAIN",
      },
      {
        matches: ["<all_urls>"],
        js: ["menu.js"],
        run_at: "document_start",
        all_frames: true,
        match_about_blank: true,
        match_origin_as_fallback: true,
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

const payment = `// Lazurio (decision F39 point 7, addendum of 2026-11-14): a payment through
// the browser (PaymentRequest) is declined. Chrome's own payment window (Google
// Pay, a card Chrome keeps, Secure Payment Confirmation) opens outside the page,
// where the people's view cannot show it, and the page takes no input until it
// is closed. A payment is also a Publication the person makes, and this
// browser belongs to the Environment, not to the person's own wallet. This
// script only answers the page's questions; what the page offers then is the
// site's own: it may offer a card form or PayPal's pop-up, which the view
// shows, or nothing.
(() => {
  const Request = globalThis.PaymentRequest;
  if (!Request) return;
  const prototype = Request.prototype;
  prototype.canMakePayment = function canMakePayment() {
    return Promise.resolve(false);
  };
  if (prototype.hasEnrolledInstrument)
    prototype.hasEnrolledInstrument = function hasEnrolledInstrument() {
      return Promise.resolve(false);
    };
  prototype.show = function show() {
    return Promise.reject(
      new DOMException(
        "Payments through the browser are not available in the Environment browser. Choose another way to pay.",
        "NotSupportedError",
      ),
    );
  };
  if (typeof Request.securePaymentConfirmationAvailability === "function")
    Request.securePaymentConfirmationAvailability = () =>
      Promise.resolve("unavailable-feature-not-enabled");
})();
`;

const sheets = `// Lazurio (decision F39 point 7, addendum of 2026-11-14): Chrome's own
// windows over a page never open. The people's view cannot show them, and the
// page takes no input until someone closes them on the screen. Each is
// answered as when a person closes it, so the page goes on.
(() => {
  // The print preview. A browser may let print() do nothing, as it does in a
  // sandboxed frame. Ctrl+P (the view sends Cmd+P as Ctrl+P) is kept from
  // Chrome in the capture phase on the window, before the page's handlers,
  // which still run: a page that prints in its own way still can.
  try {
    window.print = function print() {};
  } catch {}
  window.addEventListener(
    "keydown",
    (event) => {
      if (
        event.ctrlKey &&
        !event.altKey &&
        (event.code === "KeyP" || event.keyCode === 80)
      )
        event.preventDefault();
    },
    true,
  );
  // The picker of a screen, a window or a tab to share.
  const Devices = globalThis.MediaDevices;
  if (Devices && Devices.prototype.getDisplayMedia)
    Devices.prototype.getDisplayMedia = function getDisplayMedia() {
      return Promise.reject(
        new DOMException(
          "Sharing a screen is not available in the Environment browser.",
          "NotAllowedError",
        ),
      );
    };
  // A sign-in through an identity provider's button (FedCM's active mode,
  // once called "button") and a digital wallet open a dialog over the page.
  // FedCM's passive mode only shows a corner that leaves the page usable.
  const Container = globalThis.CredentialsContainer;
  if (Container) {
    const get = Container.prototype.get;
    const create = Container.prototype.create;
    const wallet = () =>
      Promise.reject(
        new DOMException(
          "Digital credentials are not available in the Environment browser.",
          "NotAllowedError",
        ),
      );
    Container.prototype.get = function (options) {
      if (options && options.digital) return wallet();
      const identity = options && options.identity;
      if (identity && (identity.mode === "active" || identity.mode === "button"))
        return Promise.reject(
          new DOMException("Error retrieving a token.", "NetworkError"),
        );
      return get.call(this, options);
    };
    Container.prototype.create = function (options) {
      return options && options.digital ? wallet() : create.call(this, options);
    };
  }
  const Digital = globalThis.DigitalCredential;
  if (Digital && typeof Digital.userAgentAllowsProtocol === "function")
    Digital.userAgentAllowsProtocol = () => false;
  // A device to choose (USB, serial port, HID, Bluetooth). The Environment
  // runs on a server with no such device, and the chooser is a bubble outside
  // the page that nobody sees; it is answered as an empty choice.
  const none = (message) =>
    Promise.reject(new DOMException(message, "NotFoundError"));
  const Usb = globalThis.USB;
  if (Usb && Usb.prototype.requestDevice)
    Usb.prototype.requestDevice = function requestDevice() {
      return none("No device selected.");
    };
  const Serial = globalThis.Serial;
  if (Serial && Serial.prototype.requestPort)
    Serial.prototype.requestPort = function requestPort() {
      return none("No port selected by the user.");
    };
  const Hid = globalThis.HID;
  if (Hid && Hid.prototype.requestDevice)
    Hid.prototype.requestDevice = function requestDevice() {
      return Promise.resolve([]);
    };
  const Bluetooth = globalThis.Bluetooth;
  if (Bluetooth && Bluetooth.prototype.requestDevice)
    Bluetooth.prototype.requestDevice = function requestDevice() {
      return none("User cancelled the requestDevice() chooser.");
    };
  // The eyedropper draws its loupe outside the page, and the view's clicks
  // reach the page, never the loupe, so it could never pick a colour.
  const Dropper = globalThis.EyeDropper;
  if (Dropper && Dropper.prototype.open)
    Dropper.prototype.open = function open() {
      return Promise.reject(
        new DOMException("The user canceled the selection.", "AbortError"),
      );
    };
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
    "payment.js": payment,
    "sheets.js": sheets,
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
