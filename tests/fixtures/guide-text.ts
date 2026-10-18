import {
  type GuideExplanation,
  maxGuideSteps,
} from "../../src/shell/guide-content";

// The rules every text of the shell's guide keeps (decision F56; the Lazurio
// prototype's guide and page-guide tests): the shell's principles
// (tests/shell-guide.test.ts) and the explanations a host hands over
// (tests/launchpad-guide.test.ts).

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** The rules every text of the guide keeps (the prototype's, page-guide and
 * guide tests): what a step says, its title and the quieter words under it. */
export function guideTextFindings(item: GuideExplanation): string[] {
  const found: string[] = [];
  const texts = [
    item.title,
    ...item.steps.flatMap((step) => [step.text, step.sub ?? ""]),
  ].filter(Boolean);
  for (const text of texts) {
    const say = (rule: string) => found.push(`${item.id}: ${rule}: ${text}`);
    if (/Launchpad|Dashboard|[Mm]ašin|\bVMs?\b/.test(text))
      say("Launchpad, Dashboard, Mašina or VM");
    // "MCP server" is the precise name of a thing, not where an
    // Environment runs (root AGENTS.md, "Prostředí").
    if (/SSH|tailnet|Tailscale|(?<!MCP\s)\bserver/i.test(text))
      say("SSH, tailnet or a server");
    if (/(?<!\p{L})jen\s+(?:vám|váš|vaš\p{L}*|pro\s+vás)(?!\p{L})/iu.test(text))
      say("jen vám, váš, vaše or pro vás");
    if (/=|totéž|stejn|tentýž|táž|\bsame\b|identical|\bequal/i.test(text))
      say("sameness");
    if (/nesm|zakáz|zákaz|must not|forbid|not allowed/i.test(text))
      say("forbidding");
    if (/[{}]/.test(text)) say("an unfilled token");
    // Three kinds of Environment (root decision 0207's addendum of
    // 2026-10-18): never another kind or a Buddy kind.
    if (
      /Prostředí Buddy|[Mm]ístní\p{L}* Prostředí|[Aa]utomatizovan\p{L}* Prostředí|[Vv]zdálen\p{L}* Prostředí|Remote Environment|Automated Environment|Local Environment/u.test(
        text,
      )
    )
      say("a fourth kind");
  }
  for (const step of item.steps) {
    if (words(step.text) > 9)
      found.push(`${item.id}: more than nine words: ${step.text}`);
    if (/[.]$/.test(step.text))
      found.push(`${item.id}: a full stop: ${step.text}`);
  }
  if (item.steps.length > (item.id === "vault" ? 5 : maxGuideSteps))
    found.push(`${item.id}: too many steps`);
  return found;
}
