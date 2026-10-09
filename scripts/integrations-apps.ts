import type { Category } from "../src/integrations/catalog-schema";
import type { AppTool } from "../src/integrations/path";

// The curated input of the Integrace catalog (plan DEV-6626 task 683): which
// apps Lazurio offers, in this order (the most used first), with their names
// and one sentence in Czech and English, their category, Composio's toolkit
// and Executor's integration. `scripts/integrations-catalog.ts` checks every
// entry against both public catalogs, probes the official MCP endpoints and
// writes `src/integrations/catalog.json`; docs/integrations.md says how a
// maintainer adds an app. Names of companies and products identify the apps
// only; their logos come from simple-icons (CC0) where it has them.

export type CuratedApp = Readonly<{
  /** Lazurio's id, the deep link's segment: Composio's toolkit slug where
   * that is a plain name, otherwise the app's own short name. */
  id: string;
  name: Readonly<{ cs: string; en: string }>;
  about: Readonly<{ cs: string; en: string }>;
  category: Category;
  /** Composio's toolkit slug; `null` where Lazurio does not offer Composio
   * for the app (it connects only by its own tool or directly). Default: the
   * id. */
  composio?: string | null;
  /** Executor's catalog entry of the app's direct path. */
  executor?: Readonly<{ slug: string; kind: "mcp" | "openapi" }>;
  /** A direct path through the Organization's company app (Google
   * Workspace or Microsoft 365, set up by an Admin in the Dashboard). */
  companyApp?: "google" | "microsoft";
  tool?: AppTool;
  /** simple-icons slug, where it has the brand. */
  icon?: string;
}>;

const mcp = (slug: string) => ({ slug, kind: "mcp" as const });
const api = (slug: string) => ({ slug, kind: "openapi" as const });
const same = (text: string) => ({ cs: text, en: text });

export const curatedApps: readonly CuratedApp[] = [
  {
    id: "gmail",
    name: same("Gmail"),
    about: {
      cs: "Pošta od Googlu: čtení, třídění a odesílání e-mailů.",
      en: "Google's mail: read, sort and send e-mail.",
    },
    category: "mail",
    executor: api("google-gmail"),
    companyApp: "google",
    tool: "gogcli",
    icon: "gmail",
  },
  {
    id: "googlecalendar",
    name: { cs: "Google Kalendář", en: "Google Calendar" },
    about: {
      cs: "Události, pozvánky a volné termíny v kalendáři Googlu.",
      en: "Events, invitations and free slots in Google's calendar.",
    },
    category: "mail",
    executor: api("google-calendar"),
    companyApp: "google",
    tool: "gogcli",
    icon: "googlecalendar",
  },
  {
    id: "googledrive",
    name: same("Google Drive"),
    about: {
      cs: "Soubory a složky v úložišti Googlu, sdílení s ostatními.",
      en: "Files and folders in Google's storage, shared with others.",
    },
    category: "docs",
    executor: api("google-drive"),
    companyApp: "google",
    tool: "gogcli",
    icon: "googledrive",
  },
  {
    id: "slack",
    name: same("Slack"),
    about: {
      cs: "Firemní chat v kanálech a přímých zprávách.",
      en: "Team chat in channels and direct messages.",
    },
    category: "chat",
    executor: mcp("slack-com"),
  },
  {
    id: "outlook",
    name: same("Outlook"),
    about: {
      cs: "Pošta a kalendář od Microsoftu.",
      en: "Microsoft's mail and calendar.",
    },
    category: "mail",
    executor: api("outlook-mail"),
    companyApp: "microsoft",
  },
  {
    id: "microsoft_teams",
    name: same("Microsoft Teams"),
    about: {
      cs: "Chat, schůzky a týmy v Microsoft 365.",
      en: "Chat, meetings and teams in Microsoft 365.",
    },
    category: "chat",
    executor: api("teams-chats"),
    companyApp: "microsoft",
  },
  {
    id: "notion",
    name: same("Notion"),
    about: {
      cs: "Poznámky, dokumenty, wiki a úkoly na jednom místě.",
      en: "Notes, documents, wikis and tasks in one place.",
    },
    category: "docs",
    executor: mcp("notion-com"),
    icon: "notion",
  },
  {
    id: "googlesheets",
    name: same("Google Sheets"),
    about: {
      cs: "Tabulky Googlu: data, výpočty a sdílení.",
      en: "Google's spreadsheets: data, formulas and sharing.",
    },
    category: "docs",
    executor: api("google-sheets"),
    companyApp: "google",
    icon: "googlesheets",
  },
  {
    id: "googledocs",
    name: same("Google Docs"),
    about: {
      cs: "Dokumenty Googlu: psaní a společné úpravy.",
      en: "Google's documents: writing and editing together.",
    },
    category: "docs",
    executor: api("google-docs"),
    companyApp: "google",
    icon: "googledocs",
  },
  {
    id: "github",
    name: same("GitHub"),
    about: {
      cs: "Kód, issues a pull requesty.",
      en: "Code, issues and pull requests.",
    },
    category: "dev",
    executor: mcp("github-com"),
    tool: "gh",
    icon: "github",
  },
  {
    id: "hubspot",
    name: same("HubSpot"),
    about: {
      cs: "CRM: kontakty, firmy, obchody a marketing.",
      en: "CRM: contacts, companies, deals and marketing.",
    },
    category: "crm",
    executor: mcp("hubspot"),
    icon: "hubspot",
  },
  {
    id: "linear",
    name: same("Linear"),
    about: {
      cs: "Úkoly a projekty vývojových týmů.",
      en: "Issues and projects of product teams.",
    },
    category: "projects",
    executor: mcp("linear-app"),
    icon: "linear",
  },
  {
    id: "one_drive",
    name: same("OneDrive"),
    about: {
      cs: "Úložiště souborů v Microsoft 365.",
      en: "File storage in Microsoft 365.",
    },
    category: "docs",
    executor: api("onedrive"),
    companyApp: "microsoft",
  },
  {
    id: "share_point",
    name: same("SharePoint"),
    about: {
      cs: "Firemní weby a dokumenty v Microsoft 365.",
      en: "Team sites and documents in Microsoft 365.",
    },
    category: "docs",
    executor: api("sharepoint"),
    companyApp: "microsoft",
  },
  {
    id: "jira",
    name: same("Jira"),
    about: {
      cs: "Úkoly, sprinty a projekty od Atlassianu.",
      en: "Atlassian's issues, sprints and projects.",
    },
    category: "projects",
    executor: mcp("atlassian"),
    icon: "jira",
  },
  {
    id: "confluence",
    name: same("Confluence"),
    about: {
      cs: "Firemní wiki a dokumentace od Atlassianu.",
      en: "Atlassian's team wiki and documentation.",
    },
    category: "docs",
    icon: "confluence",
  },
  {
    id: "trello",
    name: same("Trello"),
    about: {
      cs: "Nástěnky s kartami pro úkoly a projekty.",
      en: "Boards of cards for tasks and projects.",
    },
    category: "projects",
    icon: "trello",
  },
  {
    id: "asana",
    name: same("Asana"),
    about: {
      cs: "Úkoly, projekty a termíny týmu.",
      en: "A team's tasks, projects and deadlines.",
    },
    category: "projects",
    executor: mcp("asana"),
    icon: "asana",
  },
  {
    id: "clickup",
    name: same("ClickUp"),
    about: {
      cs: "Úkoly, dokumenty a cíle v jedné aplikaci.",
      en: "Tasks, documents and goals in one app.",
    },
    category: "projects",
    executor: mcp("clickup"),
    icon: "clickup",
  },
  {
    id: "monday",
    name: same("monday.com"),
    about: {
      cs: "Nástěnky, úkoly a projekty týmu.",
      en: "A team's boards, tasks and projects.",
    },
    category: "projects",
    executor: mcp("monday-com-mcp"),
  },
  {
    id: "todoist",
    name: same("Todoist"),
    about: {
      cs: "Osobní a týmové seznamy úkolů.",
      en: "To-do lists for people and teams.",
    },
    category: "projects",
    executor: mcp("todoist-com"),
    icon: "todoist",
  },
  {
    id: "zoom",
    name: same("Zoom"),
    about: {
      cs: "Videohovory a webináře.",
      en: "Video meetings and webinars.",
    },
    category: "chat",
    icon: "zoom",
  },
  {
    id: "calendly",
    name: same("Calendly"),
    about: {
      cs: "Rezervace schůzek podle volných termínů.",
      en: "Meetings booked in free slots.",
    },
    category: "mail",
    executor: mcp("calendly"),
    icon: "calendly",
  },
  {
    id: "dropbox",
    name: same("Dropbox"),
    about: {
      cs: "Úložiště a sdílení souborů.",
      en: "File storage and sharing.",
    },
    category: "docs",
    executor: mcp("dropbox"),
    icon: "dropbox",
  },
  {
    id: "airtable",
    name: same("Airtable"),
    about: {
      cs: "Tabulky s databází pro týmová data.",
      en: "Spreadsheet databases for a team's data.",
    },
    category: "docs",
    executor: mcp("airtable"),
    icon: "airtable",
  },
  {
    id: "salesforce",
    name: same("Salesforce"),
    about: {
      cs: "CRM pro obchod, servis a marketing.",
      en: "A CRM for sales, service and marketing.",
    },
    category: "crm",
  },
  {
    id: "pipedrive",
    name: same("Pipedrive"),
    about: {
      cs: "CRM pro obchodní případy a pipeline.",
      en: "A CRM for deals and the sales pipeline.",
    },
    category: "crm",
  },
  {
    id: "figma",
    name: same("Figma"),
    about: {
      cs: "Návrhy rozhraní a společné prototypy.",
      en: "Interface designs and shared prototypes.",
    },
    category: "other",
    executor: mcp("figma-com-mcp"),
    icon: "figma",
  },
  {
    id: "canva",
    name: same("Canva"),
    about: {
      cs: "Grafika, prezentace a příspěvky ze šablon.",
      en: "Graphics, presentations and posts from templates.",
    },
    category: "marketing",
    executor: mcp("canva"),
  },
  {
    id: "miro",
    name: same("Miro"),
    about: {
      cs: "Online tabule pro týmovou spolupráci.",
      en: "An online whiteboard for teams.",
    },
    category: "projects",
    executor: mcp("miro"),
    icon: "miro",
  },
  {
    id: "discord",
    name: same("Discord"),
    about: {
      cs: "Komunity, kanály a hlasové místnosti.",
      en: "Communities, channels and voice rooms.",
    },
    category: "chat",
    icon: "discord",
  },
  {
    id: "linkedin",
    name: same("LinkedIn"),
    about: {
      cs: "Profesní síť: profily, příspěvky a firmy.",
      en: "A professional network: profiles, posts and companies.",
    },
    category: "marketing",
  },
  {
    id: "youtube",
    name: same("YouTube"),
    about: {
      cs: "Videa, kanály a playlisty.",
      en: "Videos, channels and playlists.",
    },
    category: "marketing",
    icon: "youtube",
  },
  {
    id: "instagram",
    name: same("Instagram"),
    about: {
      cs: "Fotky, příběhy a zprávy.",
      en: "Photos, stories and messages.",
    },
    category: "marketing",
    icon: "instagram",
  },
  {
    id: "mailchimp",
    name: same("Mailchimp"),
    about: {
      cs: "E-mailové kampaně a seznamy kontaktů.",
      en: "E-mail campaigns and contact lists.",
    },
    category: "marketing",
    icon: "mailchimp",
  },
  {
    id: "google_analytics",
    name: same("Google Analytics"),
    about: {
      cs: "Návštěvnost webu a chování uživatelů.",
      en: "Website traffic and visitor behaviour.",
    },
    category: "marketing",
    icon: "googleanalytics",
  },
  {
    id: "googleads",
    name: same("Google Ads"),
    about: {
      cs: "Reklamy ve vyhledávání Googlu a jejich výkon.",
      en: "Ads in Google Search and how they perform.",
    },
    category: "marketing",
    icon: "googleads",
  },
  {
    id: "intercom",
    name: same("Intercom"),
    about: {
      cs: "Zákaznický chat a podpora.",
      en: "Customer messaging and support.",
    },
    category: "crm",
    executor: mcp("intercom"),
    icon: "intercom",
  },
  {
    id: "zendesk",
    name: same("Zendesk"),
    about: {
      cs: "Zákaznická podpora a tikety.",
      en: "Customer support and tickets.",
    },
    category: "crm",
    icon: "zendesk",
  },
  {
    id: "shopify",
    name: same("Shopify"),
    about: {
      cs: "E-shop: produkty, objednávky a zákazníci.",
      en: "An online store: products, orders and customers.",
    },
    category: "crm",
    // Executor's Shopify entry is a setup helper without the store's data.
    icon: "shopify",
  },
  {
    id: "stripe",
    name: same("Stripe"),
    about: {
      cs: "Platby, předplatné a faktury.",
      en: "Payments, subscriptions and invoices.",
    },
    category: "finance",
    executor: mcp("stripe-com"),
    icon: "stripe",
  },
  {
    id: "xero",
    name: same("Xero"),
    about: {
      cs: "Účetnictví a fakturace.",
      en: "Accounting and invoicing.",
    },
    category: "finance",
    icon: "xero",
  },
  {
    id: "quickbooks",
    name: same("QuickBooks"),
    about: {
      cs: "Účetnictví, faktury a výdaje.",
      en: "Accounting, invoices and expenses.",
    },
    category: "finance",
    executor: mcp("quickbooks"),
    icon: "quickbooks",
  },
  {
    id: "box",
    name: same("Box"),
    about: {
      cs: "Firemní úložiště souborů.",
      en: "File storage for companies.",
    },
    category: "docs",
    executor: mcp("box"),
    icon: "box",
  },
  {
    id: "webflow",
    name: same("Webflow"),
    about: {
      cs: "Weby a CMS bez programování.",
      en: "Websites and a CMS without code.",
    },
    category: "marketing",
    executor: mcp("webflow"),
    icon: "webflow",
  },
  {
    id: "wordpress_com",
    name: same("WordPress.com"),
    about: {
      cs: "Weby a blogy na WordPress.com.",
      en: "Sites and blogs on WordPress.com.",
    },
    category: "marketing",
    executor: mcp("wordpress-com"),
    icon: "wordpress",
  },
  {
    id: "gitlab",
    name: same("GitLab"),
    about: {
      cs: "Kód, CI/CD a issues.",
      en: "Code, CI/CD and issues.",
    },
    category: "dev",
    icon: "gitlab",
  },
  {
    id: "sentry",
    name: same("Sentry"),
    about: {
      cs: "Chyby a výkon aplikací.",
      en: "Application errors and performance.",
    },
    category: "dev",
    executor: mcp("sentry-io"),
    icon: "sentry",
  },
  {
    id: "supabase",
    name: same("Supabase"),
    about: {
      cs: "Databáze Postgres, přihlašování a úložiště.",
      en: "A Postgres database, sign-in and storage.",
    },
    category: "dev",
    executor: mcp("supabase"),
    icon: "supabase",
  },
  {
    id: "vercel",
    name: same("Vercel"),
    about: {
      cs: "Nasazení webů a aplikací, jejich logy a domény.",
      en: "Deployments of websites and apps, their logs and domains.",
    },
    category: "dev",
    executor: mcp("vercel-com"),
    icon: "vercel",
  },
  {
    id: "cloudflare",
    name: same("Cloudflare"),
    about: {
      cs: "Workers, úložiště a další služby Cloudflare.",
      en: "Workers, storage and other Cloudflare services.",
    },
    category: "dev",
    executor: mcp("cloudflare"),
    icon: "cloudflare",
  },
  {
    id: "netlify",
    name: same("Netlify"),
    about: {
      cs: "Nasazení a správa webů na Netlify.",
      en: "Deploying and running websites on Netlify.",
    },
    category: "dev",
    composio: "netlify_mcp",
    executor: mcp("netlify"),
    icon: "netlify",
  },
  {
    id: "hugging_face",
    name: same("Hugging Face"),
    about: {
      cs: "Modely, datasety a aplikace pro AI.",
      en: "Models, datasets and apps for AI.",
    },
    category: "dev",
    executor: mcp("hugging-face"),
    icon: "huggingface",
  },
  {
    id: "deepwiki",
    name: same("DeepWiki"),
    about: {
      cs: "Dokumentace veřejných repozitářů na GitHubu.",
      en: "Documentation of public GitHub repositories.",
    },
    category: "dev",
    composio: "deepwiki_mcp",
    executor: mcp("deepwiki-com"),
  },
  {
    id: "neon",
    name: same("Neon"),
    about: {
      cs: "Databáze Postgres v cloudu, hlavně pro vývoj aplikací.",
      en: "Serverless Postgres, mainly for building apps.",
    },
    category: "dev",
    composio: null,
    executor: mcp("neon-com-mcp"),
    tool: "neon",
    icon: "neon",
  },
  {
    id: "paypal",
    name: same("PayPal"),
    about: {
      cs: "Platby, faktury a spory na PayPalu.",
      en: "Payments, invoices and disputes on PayPal.",
    },
    category: "finance",
    executor: mcp("paypal"),
    icon: "paypal",
  },
  {
    id: "square",
    name: same("Square"),
    about: {
      cs: "Platby, objednávky a zboží obchodu.",
      en: "A shop's payments, orders and items.",
    },
    category: "finance",
    executor: mcp("square"),
    icon: "square",
  },
  {
    id: "attio",
    name: same("Attio"),
    about: {
      cs: "CRM pro kontakty, firmy a obchody.",
      en: "A CRM for contacts, companies and deals.",
    },
    category: "crm",
    executor: mcp("attio"),
  },
  {
    id: "granola",
    name: same("Granola"),
    about: {
      cs: "Poznámky ze schůzek a jejich přepisy.",
      en: "Meeting notes and their transcripts.",
    },
    category: "other",
    composio: "granola_mcp",
    executor: mcp("granola"),
  },
  {
    id: "fathom",
    name: same("Fathom"),
    about: {
      cs: "Záznamy, přepisy a shrnutí schůzek.",
      en: "Meeting recordings, transcripts and summaries.",
    },
    category: "other",
    executor: mcp("fathom"),
  },
  {
    id: "docusign",
    name: same("Docusign"),
    about: {
      cs: "Elektronické podpisy a smlouvy.",
      en: "Electronic signatures and agreements.",
    },
    category: "other",
    executor: mcp("docusign"),
  },
  {
    id: "wix",
    name: same("Wix"),
    about: {
      cs: "Weby, e-shop a rezervace na Wixu.",
      en: "Websites, an online store and bookings on Wix.",
    },
    category: "marketing",
    executor: mcp("wix"),
    icon: "wix",
  },
  {
    id: "mixpanel",
    name: same("Mixpanel"),
    about: {
      cs: "Analytika produktu: události, trychtýře a uživatelé.",
      en: "Product analytics: events, funnels and users.",
    },
    category: "marketing",
    executor: mcp("mixpanel"),
    icon: "mixpanel",
  },
  {
    id: "firecrawl",
    name: same("Firecrawl"),
    about: {
      cs: "Čtení a procházení webů pro agenty.",
      en: "Reading and crawling websites for agents.",
    },
    category: "dev",
    // Its MCP endpoint answers without a key but needs one for every call.
  },
  {
    id: "perplexityai",
    name: same("Perplexity AI"),
    about: {
      cs: "Vyhledávání s odpověďmi od AI.",
      en: "Search that answers with AI.",
    },
    category: "other",
    icon: "perplexity",
  },
  {
    id: "tavily",
    name: same("Tavily"),
    about: {
      cs: "Vyhledávání na webu pro agenty.",
      en: "Web search for agents.",
    },
    category: "other",
    executor: mcp("tavily"),
  },
  {
    id: "whatsapp",
    name: same("WhatsApp"),
    about: {
      cs: "Tvoje zprávy a skupiny na WhatsAppu.",
      en: "Your WhatsApp messages and groups.",
    },
    category: "chat",
    composio: null,
    tool: "wacli",
    icon: "whatsapp",
  },
];
