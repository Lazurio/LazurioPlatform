import type { ModuleAnswer, ModuleBlocked } from "../modules/module-operations";

// The lifecycle of the module the page shows: its last status, the sentence
// after the last action, and whether a request is under way. Nothing of it is
// kept beyond the page; the service manager is the truth.
export type LifecycleState = {
  key: string;
  status: ModuleAnswer | ModuleBlocked | null;
  message: string | null;
  busy: boolean;
  // After Start or Stop the keyboard focus returns to the primary action once
  // it can take it again (it is disabled while the request runs).
  focus: boolean;
  // The last start was refused because the app could not be built: its
  // development version is offered explicitly (decision F58).
  development?: boolean;
};

// Why an Open was refused (a start answered `blocked`), keyed like the
// lifecycle, and whether its development version is offered.
export type RefusedOpen = {
  key: string;
  message: string;
  development?: boolean;
};

// The lifecycle an overview renders with. Another module's overview starts a
// fresh one; a refused Open of this module puts its reason into it, whether
// the Open came from a tile on the way here or from this very overview (its
// Open button or its favourite), so "its overview says why" always holds.
// The refusal is taken once; one of another module stays for that module.
export function lifecycleShown(
  lifecycle: LifecycleState | null,
  refusedOpen: RefusedOpen | null,
  key: string,
): {
  lifecycle: LifecycleState;
  refusedOpen: RefusedOpen | null;
  fresh: boolean;
} {
  const ours = refusedOpen?.key === key ? refusedOpen : null;
  const kept = ours === null ? refusedOpen : null;
  if (lifecycle?.key === key) {
    if (ours !== null) {
      lifecycle.message = ours.message;
      if (ours.development === true) lifecycle.development = true;
      else delete lifecycle.development;
    }
    return { lifecycle, refusedOpen: kept, fresh: false };
  }
  return {
    lifecycle: {
      key,
      status: null,
      message: ours?.message ?? null,
      busy: false,
      focus: false,
      ...(ours?.development === true ? { development: true } : {}),
    },
    refusedOpen: kept,
    fresh: true,
  };
}
