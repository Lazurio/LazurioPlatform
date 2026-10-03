// The Lazurio stones of modules (decision F36): the design system's module
// icons (`content/brand/icons/*-96.png`, vendored in `vendor/stones/`),
// chosen ONLY by a generic semantic key: the app declaration's `icon`, or an
// org-agnostic fallback from the module id, the app id and the tags. Never by
// an Organization or a specific module name. A port of the root Launchpad's
// `semanticAppIconKey` (`launchpad/public/app-icon-key.js`) and its
// `LAZURIO_APP_ICON_FILES` and `LAZURIO_APP_ICON_ACCENTS`
// (`launchpad/public/app.js`), with the same keys and the same token order.
// Pure: shared by the Launchpad page, and later the Dashboard and the forks.

export const stoneKeys = [
  "control",
  "book",
  "pen",
  "palette",
  "deal",
  "warehouse",
  "product",
  "datasheet",
  "pricebook",
  "invoice",
  "installation",
  "dashboard",
  "profitability",
  "marketing",
  "website",
  "examples",
  "database",
  "system",
  "app",
] as const;
export type StoneKey = (typeof stoneKeys)[number];

/** What an app says that decides its stone. */
export type StoneSource = Readonly<{
  module?: string | null;
  id?: string | null;
  tags?: readonly string[] | null;
  icon?: string | null;
}>;

const isKey = (value: unknown): value is StoneKey =>
  typeof value === "string" && (stoneKeys as readonly string[]).includes(value);

function tokens(app: StoneSource): ReadonlySet<string> {
  return new Set(
    [app.module, app.id, ...(Array.isArray(app.tags) ? app.tags : [])]
      .filter((value): value is string => typeof value === "string")
      .join(" ")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
}

// The fallback, in the root's order: the first group with a token wins.
const fallback: readonly (readonly [StoneKey, readonly string[]])[] = [
  ["datasheet", ["datasheet", "datasheets", "spreadsheet", "spreadsheets"]],
  ["warehouse", ["warehouse", "inventory", "stock"]],
  ["product", ["product", "products", "catalog", "catalogue"]],
  ["pricebook", ["pricebook", "pricing", "prices"]],
  ["invoice", ["invoice", "invoices", "billing"]],
  [
    "installation",
    ["installation", "installations", "maintenance", "repair", "service"],
  ],
  ["dashboard", ["dashboard", "analytics", "metrics", "reporting"]],
  ["profitability", ["profitability", "profit", "margin", "forecast"]],
  [
    "deal",
    ["deal", "deals", "sales", "crm", "quote", "quotes", "offer", "offers"],
  ],
  ["control", ["mission", "control", "admin", "automation", "automations"]],
  [
    "book",
    [
      "knowledge",
      "knowledgebase",
      "guide",
      "doc",
      "docs",
      "document",
      "documents",
      "documentation",
      "wiki",
      "manual",
    ],
  ],
  ["pen", ["content", "editor", "blog", "news", "copy"]],
  [
    "marketing",
    ["marketing", "campaign", "campaigns", "promotion", "promotions"],
  ],
  ["website", ["website", "websites", "web", "portal", "site"]],
  ["examples", ["example", "examples", "sample", "samples", "demo", "demos"]],
  ["palette", ["design", "brand", "theme", "palette"]],
  ["database", ["database", "db", "repository", "storage", "ledger", "mint"]],
  ["system", ["system", "server", "infrastructure", "infra"]],
];

/** The stone's semantic key: the declared `icon` when it is a known key,
 * otherwise the first fallback group any token of the module id, app id or
 * tags falls in, otherwise `app`. */
export function semanticAppIconKey(app: StoneSource): StoneKey {
  if (isKey(app.icon)) return app.icon;
  const found = tokens(app);
  for (const [key, words] of fallback)
    if (words.some((word) => found.has(word))) return key;
  return "app";
}

/** The stone file of each key; several keys share a drawing. */
export const stoneFiles: Readonly<Record<StoneKey, string>> = {
  control: "mission-control-96.png",
  dashboard: "presentation-96.png",
  system: "settings-96.png",
  app: "clients-96.png",
  database: "knowledgebase-96.png",
  examples: "presentation-96.png",
  book: "guide-96.png",
  pen: "content-96.png",
  palette: "lazurio-design-system-96.png",
  datasheet: "presentation-96.png",
  website: "website-lazurio-96.png",
  warehouse: "clients-96.png",
  product: "brainstorm-96.png",
  installation: "settings-96.png",
  deal: "deals-96.png",
  pricebook: "pricebook-96.png",
  invoice: "invoices-96.png",
  profitability: "pricebook-96.png",
  marketing: "content-96.png",
};

/** The colour of each drawing (a design-system token): two keys that share a
 * file share its colour. */
export const stoneAccents: Readonly<Record<string, string>> = {
  "mission-control-96.png": "var(--lz-blue-500)",
  "presentation-96.png": "var(--lz-expressive-orchid)",
  "settings-96.png": "var(--lz-blue-500)",
  "clients-96.png": "var(--lz-expressive-mint)",
  "knowledgebase-96.png": "var(--lz-expressive-mint)",
  "guide-96.png": "var(--lz-expressive-yellow)",
  "content-96.png": "var(--lz-expressive-orange)",
  "lazurio-design-system-96.png": "var(--lz-expressive-orchid)",
  "website-lazurio-96.png": "var(--lz-blue-500)",
  "brainstorm-96.png": "var(--lz-expressive-yellow)",
  "deals-96.png": "var(--lz-expressive-vermilion)",
  "pricebook-96.png": "var(--lz-expressive-vermilion)",
  "invoices-96.png": "var(--lz-expressive-orange)",
};

/** Where the Launchpad serves the stones, on every origin of the
 * Environment. */
export const stoneBase = "/.lazurio/stones/";

/** The stone of a key: its file's address and its colour. */
export const stoneOf = (
  key: StoneKey,
): Readonly<{ key: StoneKey; src: string; accent: string }> => {
  const file = stoneFiles[key];
  return {
    key,
    src: `${stoneBase}${file}`,
    accent: stoneAccents[file] ?? "var(--lz-accent)",
  };
};

/** An app's title without its trailing version (`Mission Control v3` is
 * `Mission Control`), as the root Launchpad's `appBaseTitle`. */
export const appBaseTitle = (title: string): string =>
  title.replace(/\s+v\d+$/i, "").trim() || title;
