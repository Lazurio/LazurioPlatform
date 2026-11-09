import { type ServiceRun, systemctl } from "../buddy/gateway-refresh";
import type { BuddyFacts } from "../buddy/status";
import { buddyStatus } from "../buddy/status";
import { buddyT3Unit } from "../buddy/t3-runtime";
import type { MachineEntry } from "../folder/machine-binding";
import { buddyMeetHref } from "../shell/view";

// When Buddy is open to the person (decision F60's addendum of 2026-11-09,
// Matěj's decision "Odkaz do Začínáme"): while Buddy does not run, or the
// person has no persona for him yet, his bubble is hidden and his own address
// `buddy.<login>` leads to Začínáme, where the person meets him. Before, the
// shell made his frame whenever the entry named his origin, and on an
// Osobní Prostředí whose Buddy was not started yet the frame showed the
// gateway's 502 inside Lazurio's own chrome.
//
// Open means all of it at once, read fresh, never stored:
// - his gateway runs and Hermes's card says he is signed in to the person's
//   own ChatGPT (`openai-codex`, decision F63);
// - the person confirmed his names (decision F64's persona, `confirmed`);
// - the unit of his T3 Code, the page his bubble frames, is active
//   (`lazurio-t3-buddy.service`, Machines' unit, which starts only once the
//   Platform wrote his settings).
// Anything not known counts as not open: the bubble shows only for a Buddy
// who answers.

/** Whether Buddy is open: his sign-in and his names, as the setup reads
 * them, and whether his T3 Code's unit is active. Pure. */
export function buddyOpenOf(
  facts: BuddyFacts,
  confirmed: boolean,
  t3Active: boolean,
): boolean {
  return (
    buddyStatus(facts).signIn.state === "connected" && confirmed && t3Active
  );
}

/** Whether the unit of Buddy's T3 Code is active (`systemctl --user
 * is-active`); false when it is not, systemd cannot say, or does not answer
 * in time. */
export const buddyT3Active = (service: ServiceRun): Promise<boolean> =>
  systemctl(service, 10_000, "is-active", "--quiet", buddyT3Unit);

/** Buddy's gate on every shell origin, his own included, which the gateway
 * forwards to this Launchpad under `/.lazurio/` after its admission. Machines
 * ask it before a top-level navigation of `buddy.<login>` reaches his T3 Code
 * (Caddy's `forward_auth`), and send it there when his T3 Code does not
 * answer. */
export const buddyGatePath = "/.lazurio/buddy/gate";

/** The gate's answer: `204` while Buddy is open, so the gateway lets the
 * navigation through to his T3 Code; otherwise `303` to Začínáme of this
 * Environment's own Launchpad with his dialog to open
 * (`#lazurio-start=meet-buddy`, F60's addendum of 2026-10-26), which the
 * gateway's `forward_auth` hands to the browser as it is. Where the entry
 * names no Buddy, `404`. Never stored by anyone. */
export function buddyGateAnswer(
  entry: MachineEntry | null,
  open: boolean,
): Response {
  const headers = { "Cache-Control": "no-store" };
  if (entry?.buddyOrigin === undefined)
    return Response.json({ error: "buddy-absent" }, { status: 404, headers });
  if (open) return new Response(null, { status: 204, headers });
  return new Response(null, {
    status: 303,
    headers: { ...headers, Location: buddyMeetHref(entry.externalOrigin) },
  });
}
