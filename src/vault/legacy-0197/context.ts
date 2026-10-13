import type { MachineContext } from "../../machine/context";
import { environmentIdOf } from "../../shell/contract";
import type { VaultEnvironmentKind } from "../context";

// FROZEN (README.md here): where a 0197 pilot's account lives, derived as
// decision F43 derived it, so an Environment connected the 0197 way keeps
// reading its collection until its handover carries `vault` and DEV-6631
// task 649 has moved its items. Pure; nothing here reads a file.

export type PilotContext = Readonly<{
  kind: "pilot";
  /** `https://vaultwarden.<zone>` of the handover's
   * `https://headscale.<zone>`. */
  vault: string;
  host: string;
  /** `<machine>.<org>.lazurio.io` or `<slug>.lazurio.io`: the key of the
   * pilot's state directory. */
  address: string;
  /** `vaultwarden@<address>` */
  account: string;
  environment: VaultEnvironmentKind;
  /** The Organization that owns the Environment, null for a person's. */
  organization: string | null;
}>;

const hostedDomain = "lazurio.io";
const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The vault of a network from its tailnet control server: only
 * `https://headscale.<zone>` (an optional trailing slash, nothing else) gives
 * `https://vaultwarden.<zone>`; anything else is none. */
export function pilotVaultOf(controlServer: string): string | null {
  let url: URL;
  try {
    url = new URL(controlServer);
  } catch {
    return null;
  }
  const written = controlServer.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    (written !== url.origin && written !== `${url.origin}/`)
  )
    return null;
  const labels = url.hostname.split(".");
  if (
    labels.length < 3 ||
    labels[0] !== "headscale" ||
    !labels.every((label) => dnsLabel.test(label))
  )
    return null;
  return `https://${["vaultwarden", ...labels.slice(1)].join(".")}`;
}

/** Where a 0197 pilot account of this Environment would be, or null when
 * the handover gives no address or no vault the 0197 way. */
export function pilotContextOf(
  input: Readonly<{
    handover: MachineContext;
    environment: VaultEnvironmentKind;
  }>,
): PilotContext | null {
  const { handover } = input;
  const origin = handover.entry?.launchpad.external_origin;
  const id = origin === undefined ? null : environmentIdOf(origin);
  if (id === null) return null;
  // A personal Environment is one label, an Organization's two.
  if (
    id.split(".").length !== (handover.machine.kind === "personal-vm" ? 1 : 2)
  )
    return null;
  const controlServer = handover.network?.headscale_server_url;
  const vault =
    controlServer === undefined ? null : pilotVaultOf(controlServer);
  if (vault === null) return null;
  const address = `${id}.${hostedDomain}`;
  return Object.freeze({
    kind: "pilot",
    vault,
    host: new URL(vault).hostname,
    address,
    account: `vaultwarden@${address}`,
    environment: input.environment,
    organization:
      handover.owner.kind === "organization"
        ? handover.owner.organization
        : null,
  });
}
