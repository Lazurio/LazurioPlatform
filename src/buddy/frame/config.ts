import { isAbsolute } from "node:path";
import { isFrameOrigin } from "./hosts";

/** Buddy's frame on an Osobní Prostředí (buddy-web-v1 CONTRACT section 4):
 * where the gateway reaches it and where it reaches the Hermes `lazurio_web`
 * adapter. Trusted composition, never HTTP input. */
export type BuddyFrameConfig = Readonly<{
  /** `https://buddy.<slug>.lazurio.io`: the frame's origin on the gateway. */
  origin: string;
  /** The loopback port the gateway proxies the frame's route to. */
  listenPort: number;
  /** The loopback port of the adapter (`gateway.platforms.lazurio_web`). */
  adapterPort: number;
  /** The adapter's secret: a file of mode 0600 that Machines create. */
  secretFile: string;
}>;

/** The variables Machines set for the Launchpad's unit, in a drop-in of
 * their own, until the handover's entry carries Buddy (`entry.buddy`): the
 * same values, one source at a time. */
export const buddyFrameVariables = Object.freeze({
  origin: "LAZURIO_BUDDY_FRAME_ORIGIN",
  listenPort: "LAZURIO_BUDDY_FRAME_PORT",
  adapterPort: "LAZURIO_BUDDY_ADAPTER_PORT",
  secretFile: "LAZURIO_BUDDY_ADAPTER_SECRET_FILE",
});

const port = (value: string | undefined): number | null =>
  value !== undefined &&
  /^[1-9][0-9]{3,4}$/.test(value) &&
  Number(value) <= 65535
    ? Number(value)
    : null;

/** The frame's configuration from the process environment: null where none
 * of the variables is set (no Buddy here), the configuration where all four
 * are valid, and a refusal naming the first defective one otherwise. In
 * production the origin is https without a port. */
export function buddyFrameConfigOf(
  env: Readonly<Record<string, string | undefined>>,
):
  | BuddyFrameConfig
  | null
  | Readonly<{ refused: keyof typeof buddyFrameVariables }> {
  const given = Object.values(buddyFrameVariables).some(
    (name) => (env[name] ?? "") !== "",
  );
  if (!given) return null;
  const origin = env[buddyFrameVariables.origin];
  if (
    !isFrameOrigin(origin) ||
    !origin.startsWith("https://") ||
    new URL(origin).port !== ""
  )
    return { refused: "origin" };
  const listenPort = port(env[buddyFrameVariables.listenPort]);
  if (listenPort === null) return { refused: "listenPort" };
  const adapterPort = port(env[buddyFrameVariables.adapterPort]);
  if (adapterPort === null || adapterPort === listenPort)
    return { refused: "adapterPort" };
  const secretFile = env[buddyFrameVariables.secretFile];
  if (secretFile === undefined || !isAbsolute(secretFile))
    return { refused: "secretFile" };
  return Object.freeze({ origin, listenPort, adapterPort, secretFile });
}
