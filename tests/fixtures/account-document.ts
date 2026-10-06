// A `lazurio.account.v1` document exactly as the Dashboard emits it at
// `GET /api/environment/v1/account/environments` (its account API test of
// the document, HumanAndMachine-ai/Dashboard#198), with example names only:
// the person `ada`, her personal Remote Environment, a Team and a work
// Environment of the example Organization, and another Organization she is
// a member of without any Environment. Members in the Dashboard's order.

export const accountDocument = (
  extra: Readonly<Record<string, unknown>> = {},
) => ({
  schema: "lazurio.account.v1",
  locale: "en",
  operator: {
    initials: "A",
    login: "ada",
    avatar: "https://avatars.githubusercontent.com/u/9301?v=4",
  },
  environments: [
    {
      id: "ada",
      kind: "personal",
      label: null,
      name: "Ada personal",
      who: "only yours",
      offline: false,
      organizations: [],
      assignee: null,
      apps: {
        apps: "https://launchpad.ada.lazurio.io/",
        chat: null,
        automate: null,
      },
    },
    {
      id: "vm-01.example",
      kind: "team",
      label: "Sales",
      name: "Team Sales",
      who: "shared by the Team",
      offline: false,
      organizations: ["example"],
      assignee: null,
      apps: {
        apps: "https://launchpad.vm-01.example.lazurio.io/",
        chat: "https://t3code.vm-01.example.lazurio.io/",
        automate: null,
      },
    },
    {
      id: "vm-03.example",
      kind: "work",
      label: null,
      name: "Work",
      who: "only yours",
      offline: false,
      organizations: ["example"],
      assignee: "ada",
      apps: {
        apps: "https://launchpad.vm-03.example.lazurio.io/",
        chat: "https://t3code.vm-03.example.lazurio.io/",
        automate: null,
      },
    },
  ],
  organizations: [
    {
      slug: "example",
      name: "Example Works",
      avatar: "https://avatars.githubusercontent.com/u/710101?v=4",
      dashboard: "https://dashboard.lazurio.ai/orgs/example",
    },
    {
      slug: "other-example",
      name: "Other Example",
      avatar: "https://avatars.githubusercontent.com/u/720202?v=4",
      dashboard: "https://dashboard.lazurio.ai/orgs/other-example",
    },
  ],
  last: null,
  lastBySpace: {},
  favourites: { example: [] },
  preferences: { openApps: "tab" },
  ...extra,
});
