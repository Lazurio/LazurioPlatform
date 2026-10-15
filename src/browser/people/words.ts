// The words of the people's view of the Environment browser (decision F39)
// in the person's language: Czech where the browser's language is Czech,
// English otherwise (the contract's `browserLanguage`, F50 C17). The view
// page's script (`client.ts`) shows them; they
// live here, apart from its DOM, so the tests read both languages. Czech
// addresses the person formally where it speaks to them (root decision
// 0199); the bar's controls and its menu's items are nouns or infinitives.

export const en = {
  connecting: "Connecting…",
  loading: "Loading the page…",
  reconnecting: "The Environment browser is reconnecting…",
  closed: "This tab no longer exists.",
  openNewTab: "Open a new tab",
  startFailed: "The new tab could not be opened.",
  retry: "Try again",
  newTab: "The page opened a new tab",
  open: "Open",
  dismiss: "Dismiss",
  back: "Back",
  forward: "Forward",
  reload: "Reload",
  stop: "Stop",
  address: "Search or enter an address",
  page: "Page in the Environment browser",
  closeWindow: "Close the window",
  ok: "OK",
  cancel: "Cancel",
  leaveTitle: "Leave this page?",
  leaveText: "Changes you made may not be saved.",
  stay: "Stay",
  leave: "Leave",
  file: "The page wants to upload a file",
  files: "The page wants to upload files",
  upload: "Upload",
  uploading: "Uploading…",
  uploadFailed: "The files could not be uploaded.",
  picture: "Picture quality",
  pictureStandard: "Standard",
  pictureSaver: "Data saver",
  pictureSaverHint: "lower resolution for a slow connection",
  openAlone: "Open in a new tab",
  foreignView: "This address is another Environment's browser",
  addressRefused:
    "This address is on the view of an Environment browser but links to no tab, so it does not open here.",
  addressRefusedScheme:
    "The Environment browser opens only http and https addresses here.",
};
export type Words = { readonly [K in keyof typeof en]: string };
export const cs: Words = {
  connecting: "Připojuji…",
  loading: "Stránka se načítá…",
  reconnecting: "Prohlížeč Prostředí se znovu připojuje…",
  closed: "Tato záložka už neexistuje.",
  openNewTab: "Otevřít novou záložku",
  startFailed: "Novou záložku se nepodařilo otevřít.",
  retry: "Zkusit znovu",
  newTab: "Stránka otevřela novou záložku",
  open: "Otevřít",
  dismiss: "Zavřít",
  back: "Zpět",
  forward: "Vpřed",
  reload: "Obnovit",
  stop: "Zastavit",
  address: "Hledat nebo zadat adresu",
  page: "Stránka v prohlížeči Prostředí",
  closeWindow: "Zavřít okno",
  ok: "OK",
  cancel: "Zrušit",
  leaveTitle: "Opustit stránku?",
  leaveText: "Provedené změny nemusí být uložené.",
  stay: "Zůstat",
  leave: "Opustit",
  file: "Stránka chce nahrát soubor",
  files: "Stránka chce nahrát soubory",
  upload: "Nahrát",
  uploading: "Nahrávám…",
  uploadFailed: "Soubory se nepodařilo nahrát.",
  picture: "Kvalita obrazu",
  pictureStandard: "Standardní",
  pictureSaver: "Úsporná",
  pictureSaverHint: "nižší rozlišení pro pomalé připojení",
  openAlone: "Otevřít samostatně",
  foreignView: "Tato adresa je prohlížeč jiného Prostředí",
  addressRefused:
    "Tato adresa patří pohledu prohlížeče Prostředí, ale neodkazuje na žádnou záložku, takže se tu neotevře.",
  addressRefusedScheme:
    "Prohlížeč Prostředí tu otevírá jen adresy http a https.",
};

export const words: Readonly<Record<"cs" | "en", Words>> = Object.freeze({
  cs,
  en,
});
