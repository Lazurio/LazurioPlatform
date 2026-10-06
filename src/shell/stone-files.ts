import brainstorm from "./vendor/stones/brainstorm-96.png" with {
  type: "file",
};
import clients from "./vendor/stones/clients-96.png" with { type: "file" };
import content from "./vendor/stones/content-96.png" with { type: "file" };
import deals from "./vendor/stones/deals-96.png" with { type: "file" };
import guide from "./vendor/stones/guide-96.png" with { type: "file" };
import invoices from "./vendor/stones/invoices-96.png" with { type: "file" };
import knowledgebase from "./vendor/stones/knowledgebase-96.png" with {
  type: "file",
};
import lazurioDesignSystem from "./vendor/stones/lazurio-design-system-96.png" with {
  type: "file",
};
import missionControl from "./vendor/stones/mission-control-96.png" with {
  type: "file",
};
import presentation from "./vendor/stones/presentation-96.png" with {
  type: "file",
};
import pricebook from "./vendor/stones/pricebook-96.png" with { type: "file" };
import settings from "./vendor/stones/settings-96.png" with { type: "file" };
import websiteLazurio from "./vendor/stones/website-lazurio-96.png" with {
  type: "file",
};

// The server's side of the stones (decision F36): each vendored file,
// embedded in the compiled executable like the fonts, by its file name.
export const stoneFilePaths: Readonly<Record<string, string>> = {
  "brainstorm-96.png": brainstorm,
  "clients-96.png": clients,
  "content-96.png": content,
  "deals-96.png": deals,
  "guide-96.png": guide,
  "invoices-96.png": invoices,
  "knowledgebase-96.png": knowledgebase,
  "lazurio-design-system-96.png": lazurioDesignSystem,
  "mission-control-96.png": missionControl,
  "presentation-96.png": presentation,
  "pricebook-96.png": pricebook,
  "settings-96.png": settings,
  "website-lazurio-96.png": websiteLazurio,
};
