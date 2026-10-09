import generated from "./catalog.json";
import {
  type CatalogApp,
  type IntegrationsCatalog,
  parseCatalog,
} from "./catalog-schema";
import type { PathApp } from "./path";

// The Integrace catalog of this release (decision F42): `catalog.json`,
// written by `scripts/integrations-catalog.ts` and checked when it loads.

/** The catalog of this release. */
export const integrationsCatalog: IntegrationsCatalog = parseCatalog(generated);

export function catalogApp(id: string): CatalogApp | undefined {
  return integrationsCatalog.apps.find((app) => app.id === id);
}

/** What the path rule reads of a catalog app. */
export const pathApp = (app: CatalogApp): PathApp =>
  Object.freeze({
    id: app.id,
    ...(app.direct === undefined ? {} : { direct: { auth: app.direct.auth } }),
    composio: app.composio !== undefined,
    ...(app.tool === undefined ? {} : { tool: app.tool }),
  });
