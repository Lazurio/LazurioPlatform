import { type MessageKey, messages } from "../launchpad/messages";

/** Czech labels the Folder keeps in their old words: the Czech names of the
 * prototype (decision F36, addendum of 2026-11-06) renamed Apps to Aplikace
 * and the page Integrace to Napojení in the Launchpad, but the Folder's
 * generated instructions, manual and skills still teach agents the old words
 * until their own update (Lazurio/LazurioPlatform#890). */
export const heldCzechLabels: Readonly<Partial<Record<MessageKey, string>>> =
  Object.freeze({ appsTitle: "Apps", integrationsTitle: "Integrace" });

/** The Launchpad's Czech catalog as the Folder quotes it. */
export const folderCzechLabels = (): ReturnType<typeof messages> => ({
  ...messages("cs"),
  ...heldCzechLabels,
});
