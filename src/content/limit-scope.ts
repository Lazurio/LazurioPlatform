import { AsyncLocalStorage } from "node:async_hooks";
import { onLimitRefusal } from "./github";

// The operations of a content run whose failure GitHub's rate limit may
// cause (#1223, Pablo's reviews of #1224): each runs in its own async scope
// and knows whether GitHub refused one of its own requests for the limit.
// Server only: the page's bundle never imports this module (it holds an
// async context the browser does not have).

type LimitScope = { limited: boolean; parent: LimitScope | undefined };
const limitScopes = new AsyncLocalStorage<LimitScope>();

/** Notes that GitHub refused the request under way for its rate limit:
 * every `observeLimit` operation it belongs to sees it. The gh adapter
 * reports it from GitHub's own answer (`onLimitRefusal`); any other adapter
 * may call it too. */
export function refusedForLimit(): void {
  for (let scope = limitScopes.getStore(); scope; scope = scope.parent)
    scope.limited = true;
}

onLimitRefusal(refusedForLimit);

/** Runs one GitHub operation and says whether GitHub refused one of its
 * own requests for its rate limit: the cause a failure of that operation
 * carries, never a refusal of another operation of the run. Nested
 * operations each see their own requests, and an enclosing one sees them
 * too. */
export async function observeLimit<T>(
  operation: () => Promise<T>,
): Promise<Readonly<{ value: T; limited: boolean }>> {
  const scope: LimitScope = { limited: false, parent: limitScopes.getStore() };
  const value = await limitScopes.run(scope, operation);
  return { value, limited: scope.limited };
}
