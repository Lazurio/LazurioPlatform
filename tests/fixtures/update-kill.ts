import {
  type ActivationStep,
  activate,
  withUpdateLock,
} from "../../src/update/activation";

// Runs one activation and dies by SIGKILL right after the named durable step:
// no `finally`, no handler, exactly what a power loss leaves on disk.
const [base, to, supervised, step] = process.argv.slice(2) as [
  string,
  string,
  string,
  ActivationStep,
];
await withUpdateLock(base, 0, () =>
  activate({
    base,
    to,
    service:
      supervised === "supervised"
        ? {
            folder: undefined,
            async restartLaunchpad() {},
            launchpadVersion: async () => to,
          }
        : null,
    afterStep(reached) {
      if (reached === step) process.kill(process.pid, "SIGKILL");
    },
  }),
);
console.log("survived");
