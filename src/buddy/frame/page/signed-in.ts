import { browserLang, copyOf } from "./copy";

// The popup's landing after the gateway's sign-in: the session cookie is set
// now. It tells the frame through a channel of this origin and through its
// opener (if the issuer kept the tie), and closes. The frame also asks for
// its session itself, so a message lost here costs only a moment.

const message = Object.freeze({ type: "lazurio.buddy.signed-in", v: 1 });
const lang = browserLang(navigator.languages ?? [navigator.language]);
document.documentElement.lang = lang;
const line = document.getElementById("signed-in");
if (line !== null) line.textContent = copyOf(lang).signedIn;
try {
  const channel = new BroadcastChannel("lazurio-buddy");
  channel.postMessage(message);
  channel.close();
} catch {
  // No channel: the opener or the frame's own check remains.
}
try {
  window.opener?.postMessage(message, location.origin);
} catch {
  // The opener is gone.
}
setTimeout(() => window.close(), 400);
