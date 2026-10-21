import {
  type BuddyFrameConfig,
  buddyFrameConfigOf,
  buddyFrameVariables,
} from "./config";
import {
  type BuddyFrame,
  type BuddyFrameSeams,
  startBuddyFrame,
} from "./server";

/** What the Launchpad's start passes on: a configuration, none, or the
 * refusal of a defective one (`buddyFrameConfigOf`). */
export type BuddyFrameDeclaration = ReturnType<typeof buddyFrameConfigOf>;

/** The declaration of the Launchpad's own process: the variables Machines
 * set for its unit. */
export const processBuddyFrame = (): BuddyFrameDeclaration =>
  buddyFrameConfigOf(process.env);

/** Buddy's frame beside the Launchpad, in its process, where the Osobní
 * Prostředí declares one; never a reason for the Launchpad's start to fail.
 * A defective declaration or a busy port is one line on the Launchpad's
 * output, naming the variable or the port, never a value. */
export async function startDeclaredBuddyFrame(
  declared: BuddyFrameDeclaration | BuddyFrameConfig,
  seams: BuddyFrameSeams = {},
  log: (line: string) => void = (line) => console.error(line),
): Promise<BuddyFrame | null> {
  if (declared === null) return null;
  if ("refused" in declared) {
    log(
      JSON.stringify({
        buddyFrame: "refused",
        variable: buddyFrameVariables[declared.refused],
      }),
    );
    return null;
  }
  try {
    return await startBuddyFrame(declared, seams);
  } catch {
    log(
      JSON.stringify({ buddyFrame: "not-started", port: declared.listenPort }),
    );
    return null;
  }
}
