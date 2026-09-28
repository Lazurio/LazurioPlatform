import {
  teamGithubLogoutText,
  teamGithubPhrase,
  teamGithubText,
  teamGithubWorksAs,
} from "../tools/team-github";

// A phrase that follows " · " on a status line starts a new part.
const capitalized = (text: string) =>
  `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

const en = {
  appDiscover: "Read declared applications",
  appDiscovered: "Observed application",
  appDiscoveryNotice:
    "Local declarations only, not access or readiness. Conflicts and unavailable modules are shown below.",
  appDiscoveryUnavailable:
    "Application discovery is unavailable. Configure a permitted canonical Organization in the CLI; no legacy fallback is used.",
  appPrepare: "Prepare dependencies",
  appCleanPrepare: "Reinstall dependencies (remove node_modules)",
  appPrepared:
    "Module preparation completed. Start the app and verify its function separately.",
  appPreparationUnavailable:
    "Module preparation is not configured in this development session.",
  appPrerequisitesNotReady:
    "The module prerequisite check did not complete successfully, so the application was not started. Check the module's dependencies and setup requirements before explicitly preparing dependencies or retrying.",
  appPreparationPreflightFailed:
    "Preparation checks failed before any application was stopped. Check the module declarations, lockfile and required toolchain.",
  appPreparationCleanupRequired:
    "Previous process cleanup could not be confirmed. Further preparation and starts are blocked; resolve cleanup through the existing lifecycle owner before retrying.",
  appOtherAppManaged:
    "Another application of this Organization is running or awaits cleanup. Explicitly stop it before preparing dependencies; preparation will not stop it for you.",
  appDeclarationChanged:
    "The application declaration or its location changed. Refresh the selection and verify the intended module before retrying.",
  appCoordinationBusy:
    "Another Lazurio process is operating this Organization's applications right now. Nothing was changed; retry when it finishes.",
  appPreparationRecoveryRequired:
    "An earlier dependency preparation of this module did not finish or its cleanup is unconfirmed. Preparing and starting stay blocked until that is explicitly recovered; stopping and status are unaffected.",
  appApplicationRunning:
    "This application is running under the operating system's service manager and may be in use. Dependencies are not changed beneath a running application; explicitly stop it first.",
  appServiceUnrecognized:
    "A service with this application's name exists but was not created by Lazurio in its expected form. It was not started, stopped or changed; inspect it with the operating system's service manager.",
  appHealthyPersistent:
    "Declared health checks passed. This application keeps running when the Launchpad restarts; it does not survive a reboot. Verify the application's function after opening it.",
  appEnded:
    "The application is no longer running; its owner reports it ended. Inspect the result, then start it again or stop it to clear the record.",
  appsTitle: "Application",
  appsNotice:
    "Explicit development selection. The server must authorize the declared application.",
  appSelection: "Declared application",
  appCompany: "Organization",
  appModule: "Module",
  appPackage: "Package",
  appStart: "Start",
  appStatus: "Status",
  appOpen: "Get application link",
  appStop: "Stop",
  appVisit: "Open application on this machine",
  appBusy: "Operation in progress…",
  appStarted:
    "Process started. Check readiness before opening the application.",
  appHealthy:
    "Declared health checks passed. Verify the application's function after opening it.",
  appStopped: "Owned application processes stopped.",
  appNotManaged: "No application process is managed for this selection.",
  appNotReady:
    "The application is not ready, or its process ownership could not be confirmed.",
  appDenied: "Access denied for this application operation.",
  appUnavailable:
    "Application bindings are not configured in this development session.",
  appFailure:
    "Operation did not complete. Inspect the result; no automatic repair was performed.",
  appResultUnknown:
    "The operation result could not be confirmed. It may still be running; a lost response does not cancel it. Check the existing lifecycle owner before retrying a change.",
  appLinkReady:
    "Local application link available. Opening it does not prove functional acceptance.",
  appRemoteLink:
    "This address belongs to the execution machine. Remote browser access needs a qualified route.",
  updateTitle: "Product update",
  updateNotes: "Release notes",
  updateUnknown: "Lazurio {running}.",
  updateIdle: "Lazurio {running} is up to date.",
  updateChecking: "Checking for a new version…",
  updateAvailable: "Lazurio {latest} is available (running {running}).",
  updateDownloading: "Downloading and verifying Lazurio {latest}…",
  updateActivating:
    "Activating Lazurio {latest}. The Launchpad restarts; applications keep running.",
  updateRestart:
    "Lazurio {active} is installed. Restart the Launchpad to finish the update.",
  updateAction: "Update",
  updateRetry: "Retry",
  updateChecked: "Last verified check: {age} ago.",
  updateNeverChecked: "No verified check yet.",
  updateStale:
    "Last verified check: {age} ago. A newer release may be withheld from this machine.",
  updateFailed:
    "The update did not complete: {code}. The installed version keeps working; the same click retries.",
  updateStateInvalid:
    "Update state needs a person: {path}. Nothing is changed automatically.",
  updateStarted: "Update started…",
  updateRefused: "The update was not started; the state shown was refreshed.",
  updateFolderRefresh:
    "Folder refresh needed: this Folder was rendered by {recorded}, Lazurio renders {product}. Run: {command}",
  toolsTitle: "Tools",
  toolsIntro:
    "Tools are command-line programs that agents use to work with outside services. “Used by agents” guides the agents on this Environment to use a tool. Installing, uninstalling, signing in and signing out are separate acts.",
  toolsSwitchLabel: "Used by agents",
  toolsSwitchNamed: "Used by agents: {name}",
  // One wording with the CLI and the server's rule (src/tools/team-github.ts).
  toolsTeamGithub: teamGithubText.en,
  toolsTeamGithubLogout: teamGithubLogoutText.en,
  toolsShared:
    "This Environment is shared. Accounts signed in to a tool apply to the whole Environment and are used by all its operators.",
  toolsRefresh: "Refresh status",
  toolsLoading: "Reading tools…",
  toolsLoadFailed:
    "The tools could not be read. Try Refresh status; if it keeps failing, run lazurio tools list in the CLI.",
  toolsChecked: "Folder revision {revision} · checked at {time}",
  toolsTierRequired: "Required",
  toolsTierRequiredNote: "Always part of the agent instructions.",
  toolsTierRecommended: "Recommended",
  toolsTierRecommendedNote:
    "The recommended way to connect this Environment to external apps.",
  toolsTierOptional: "Optional",
  toolsTierOptionalNote:
    "Further tools for single services. Enable what you use.",
  toolsInstalled: "Installed, version {version}",
  toolsInstalledNoVersion: "Installed, version unknown",
  toolsNotInstalled: "Not installed",
  toolsVersionError: "The version check failed: {error}.",
  toolsOutsideStandard:
    "Found outside ~/.local/bin, the standard place for tools. It works; it is only reported.",
  toolsSetupLaunchpad: "Set up in Launchpad",
  toolsSetupAgent: "Set up with an agent",
  toolsEnabled: "Enabled",
  toolsDisabled: "Not enabled",
  toolsAlwaysOn: "Always on",
  toolsEnable: "Enable",
  toolsDisable: "Disable",
  toolsEnableNamed: "Enable {name}",
  toolsDisableNamed: "Disable {name}",
  toolsUsage: "What agents are told",
  toolsSource: "Official source",
  toolsBusy: "Working…",
  toolsEnabledDone:
    "{name} is enabled; the agent instructions of this Folder were rewritten. Folder revision {revision}.",
  toolsDisabledDone:
    "{name} is no longer enabled; the agent instructions of this Folder were rewritten. Folder revision {revision}.",
  toolsEnabledNotInstalled:
    "{name} is not installed yet; agents will report that until it is set up.",
  toolsNoteSaved:
    "Your note on {name} is saved; the agent instructions of this Folder were rewritten. Folder revision {revision}.",
  toolsNoteCleared:
    "Your note on {name} is removed; the agent instructions of this Folder were rewritten. Folder revision {revision}.",
  toolsUndone:
    "The change of {name} is undone; the agent instructions of this Folder were rewritten. Folder revision {revision}.",
  toolsUndo: "Undo",
  toolsUndoNamed: "Undo the change of {name}",
  toolsUnchanged:
    "Nothing changed: the Folder already records this. Reload to see its current state.",
  toolsBlockedStale:
    "The Folder changed in the meantime. Reload and try again; nothing was written.",
  toolsBlockedDrift:
    "The file {path} was edited by hand, so Lazurio does not overwrite it. Keep your edit elsewhere and restore the file, then reload. Nothing was written.",
  toolsBlockedIncomplete:
    "An earlier change of this Folder did not finish. Complete it with lazurio profile-resume in the CLI, then reload. Nothing was written.",
  toolsBlockedOther: "The change was refused ({reason}). Nothing was written.",
  toolsFailed:
    "The change could not be confirmed. Reload the state; CLI recovery may be required.",
  toolsReload: "Reload",
  toolsAgentAction: "Set up with an agent",
  toolsAgentActionNamed: "Set up {name} with an agent",
  toolsInstallAction: "Install and sign in",
  toolsInstallOnlyAction: "Install",
  toolsSignInAction: "Sign in",
  toolsSignedInAs: "Signed in as {account}",
  toolsSignedInAsOrganization: "Signed in as {account} ({organization})",
  toolsSignedIn: "Signed in",
  toolsSignedOut: "Not signed in",
  toolsSignInUnknown: "Sign-in unknown",
  toolsSignInUnchecked: "Sign-in not checked",
  toolsUsageCatalog: "What Lazurio tells agents about this tool:",
  toolsNoteLabel: "Your note for agents",
  toolsNoteHint:
    "Write the intent with which you use this tool here. Agents read it in manual/this-machine.md of this Folder; it grants no access.",
  toolsNoteCount: "{count} / {max} characters",
  toolsNoteTooLong: "The note is longer than {max} characters.",
  toolsNoteTooManyLines: "The note has more than {max} lines.",
  toolsNoteControl:
    "The note contains characters that are not allowed (control or text-direction characters).",
  toolsNoteSave: "Save note",
  toolsNoteSaveNamed: "Save the note on {name}",
  toolsNoteClear: "Clear note",
  toolsNoteClearNamed: "Clear the note on {name}",
  toolsNoteAfterEnable:
    "After you enable this tool you can add a note for agents here.",
  toolsInstallActionNamed: "Install {name} and sign in",
  toolsInstallOnlyNamed: "Install {name}",
  toolsSignInActionNamed: "Sign in to {name}",
  toolsSignOutAction: "Sign out",
  toolsSignOutNamed: "Sign out of {name}",
  toolsSignedOutLocal:
    "{name}: signed out on this Machine. The provider still lists this sign-in until you revoke it in your account settings there.",
  toolsSignedOutRemote:
    "{name}: signed out; the linked device was removed from your account.",
  toolsSignOutFailed:
    "{name}: signing out did not finish ({reason}). Refresh the status to see where it stands.",
  toolsLoginTitleInstall: "Install and sign in: {name}",
  toolsLoginTitle: "Sign in: {name}",
  toolsLoginContinue: "Continue",
  toolsStepInstalling: "Installing",
  toolsStepWaiting: "Waiting for you",
  toolsStepSignedIn: "Signed in",
  toolsStepDone: "{step}: done",
  toolsStepCurrent: "{step}: in progress",
  toolsStepTodo: "{step}: next",
  toolsStepFailed: "{step}: did not finish",
  toolsInstalling:
    "Installing {name} from its official source. This can take a minute.",
  toolsInstalledNow: "{name} {version} is installed.",
  toolsAlreadyInstalled:
    "{name} already works on this Machine; nothing was changed.",
  toolsInstallFailed:
    "The installation did not finish (step {stage}: {reason}). Nothing that already worked was changed.",
  toolsInstallUnsupported:
    "The installer built into Lazurio does not cover this Machine ({platform} {arch}).",
  toolsInstallNotOnPath:
    "~/.local/bin is not on the PATH of this Launchpad, so agents may not find the tool until it is added to the shell profile.",
  toolsInstallBusy:
    "This tool is being installed already. Wait for it to finish, then refresh the status.",
  toolsFinishWithAgent: "Finish with an agent",
  toolsAgentFallback:
    "An agent can finish the setup by the written target state of this tool.",
  toolsLoginStarting: "Starting the sign-in…",
  toolsLoginGhText:
    "Open the GitHub device page on any device (this computer, another one or your phone) and enter this code:",
  toolsLoginGhLink: "Open github.com/login/device in a new tab",
  toolsLoginCodeLabel: "One-time code",
  toolsLoginComposioText:
    "Open the Composio sign-in page in a new tab on any device and sign in with your account. The page is valid for 10 minutes. You do not copy any key.",
  toolsLoginComposioLink: "Open the Composio sign-in page",
  toolsLoginQrText:
    "On your phone open WhatsApp, then Settings, Linked devices, Link a device, and point the camera at this code. It changes every few seconds; the newest one is always shown here.",
  toolsLoginQrAlt:
    "QR code that links WhatsApp to this Environment. Scan it in WhatsApp on your phone under Settings, Linked devices, Link a device. If you cannot scan it, pair with a phone number below.",
  toolsLoginPhoneTitle: "Pair with a phone number instead",
  toolsLoginPhoneLabel: "Your WhatsApp phone number with the country code",
  toolsLoginPhoneAction: "Get a pairing code",
  toolsLoginPhoneInvalid:
    "Enter the number with its country code, for example +420 123 456 789.",
  toolsLoginPairText:
    "On your phone open WhatsApp, then Settings, Linked devices, Link a device, then Link with phone number instead, and enter this code:",
  toolsLoginPairLabel: "Pairing code for {phone}",
  toolsLoginQrAgain: "Show the QR code instead",
  toolsLoginWaiting:
    "Waiting for you to finish. This window checks every 2 seconds.",
  toolsLoginSignedIn: "You are signed in to {name}.",
  toolsLoginSignedInAs: "You are signed in to {name} as {account}.",
  toolsLoginWacliSync:
    "WhatsApp now copies your recent messages to this Environment in the background. You can close this window.",
  toolsLoginFailureNotInstalled: "The tool is not installed on this Machine.",
  toolsLoginFailureUrl:
    "The tool offered an address that is not its official sign-in page, so it was not shown.",
  toolsLoginFailureOutput: "The tool answered in a form Lazurio does not know.",
  toolsLoginFailureExit: "The tool ended without completing the sign-in.",
  toolsLoginFailureNotConfirmed:
    "The tool ended, but its status does not say signed in.",
  toolsLoginFailureSpawn: "The tool could not be started.",
  toolsLoginExpired:
    "The sign-in expired before it was finished. Start it again when you are ready.",
  toolsLoginEnded:
    "The sign-in is no longer running. Start it again if you still need it.",
  toolsLoginUnreadable:
    "The answer of the Launchpad could not be read. Close this window and try again.",
  toolsLoginTryAgain: "Try again",
  toolsSshLinked: "SSH key linked",
  toolsSshNotLinked: "SSH key not linked",
  toolsSshUnknown: "SSH key not verified",
  toolsSshTeam: capitalized(teamGithubPhrase.en),
  toolsWorksAs: capitalized(teamGithubWorksAs.en),
  toolsLinkSshAction: "Link SSH key",
  toolsLinkSshNamed: "Link the SSH key of this Machine to the {name} account",
  toolsLoginTitleSsh: "Link SSH key: {name}",
  toolsStepLinking: "Linking the SSH key",
  toolsStepLinked: "SSH key linked",
  toolsLoginLinking:
    "Signed in to GitHub. Lazurio now links the SSH key of this Machine to your account and checks that git over SSH works. This takes a few seconds.",
  toolsLoginRefreshText:
    "Your gh sign-in may not manage the SSH keys of your account yet. To allow it, open the GitHub device page on any device (this computer, another one or your phone) and enter this code:",
  toolsSshLinkedDone:
    "The SSH key of this Machine is linked: git clone git@github.com:… works as {account}.",
  toolsSshKeyCreated:
    "A new key without a passphrase was created, so agents can use it: {path} ({fingerprint}).",
  toolsSshKeyReused:
    "The existing key {path} ({fingerprint}) is used unchanged.",
  toolsSshNotLinkedDone:
    "You are signed in to gh as {account}, but the SSH key of this Machine is not linked, so git over SSH does not work yet.",
  toolsSshFailureNotSignedIn: "gh is not signed in on this Machine.",
  toolsSshFailureScopeMissing:
    "The gh sign-in may not manage the SSH keys of your account.",
  toolsSshFailureKeygenMissing: "ssh-keygen is not installed on this Machine.",
  toolsSshFailureKeygenFailed: "A new key could not be created in ~/.ssh.",
  toolsSshFailureKeyPassphrase:
    "The existing key {path} is protected by a passphrase, which agents cannot enter. It was left as it is.",
  toolsSshFailureKeyIncomplete:
    "The existing key {path} has no matching .pub file. It was left as it is.",
  toolsSshFailureKeyUnreadable:
    "The existing key {path} could not be read. It was left as it is.",
  toolsSshFailureKeyInUse:
    "GitHub refuses the key {path} because it is already in use there: on another GitHub account or as a deploy key of a repository. No second key was created.",
  toolsSshFailureRegisterFailed:
    "The key could not be registered on your GitHub account.",
  toolsSshFailureHostKeysUnavailable:
    "GitHub's published host keys could not be read.",
  toolsSshFailureHostKeyMismatch:
    "~/.ssh/known_hosts holds a github.com host key that differs from the keys GitHub publishes. Nothing was changed.",
  toolsSshFailureKnownHostsFailed:
    "~/.ssh/known_hosts could not be read or written.",
  toolsSshFailureSshMissing: "ssh is not installed on this Machine.",
  toolsSshFailureProofFailed:
    "The test connection to GitHub over SSH did not answer with GitHub's greeting.",
  toolsSshFailureProofOtherAccount:
    "Over SSH GitHub greeted another account ({account}): another key of this Machine is offered first.",
  toolsLoginFailureNotSignedIn:
    "gh is not signed in on this Machine. Sign in first; the SSH key is linked as part of it.",
  toolsSshRemoved:
    "The SSH key of this Machine ({fingerprint}) was removed from your GitHub account; the key files stay on this Machine.",
  toolsSshRemovalNotRegistered:
    "The SSH key of this Machine was not registered on your GitHub account.",
  toolsSshRemovalNoKey:
    "This Machine has no SSH key in ~/.ssh; nothing was removed from GitHub.",
  toolsSshRemovalKept:
    "The SSH key of this Machine ({fingerprint}) stays registered on your GitHub account because Lazurio did not register it. Remove it under GitHub Settings, SSH and GPG keys (github.com/settings/keys), if this Machine must lose access.",
  toolsSshRemovalFailed:
    "The SSH key of this Machine may still be registered on your GitHub account: gh could not remove it. Remove it under GitHub Settings, SSH and GPG keys (github.com/settings/keys), if this Machine must lose access.",
  toolsComposioOrgLabel: "Composio organization of this Environment",
  toolsComposioOrgCurrent: "{name} (current)",
  toolsComposioOrgHint:
    "Apps you connect in Composio belong to this account and organization: the account of the Environment, which its agents use.",
  toolsComposioOrgSaved:
    "The Composio organization of this Environment is now {name}.",
  toolsComposioOrgFailed:
    "The organization could not be changed. You can change it later with lazurio tools composio-org.",
  toolsComposioOrgLoading: "Reading your Composio organizations…",
  toolsComposioOrgUnavailable:
    "The organizations could not be read. You can choose one later with lazurio tools composio-org.",
  toolsPromptTitle: "Set up {name} with an agent",
  toolsPromptHint:
    "Copy this prompt and paste it into a new chat in T3 Code on this Machine. The agent installs the tool and guides you through the sign-in in your browser. You never copy an API key.",
  toolsPromptLabel: "Prepared prompt",
  toolsCopy: "Copy prompt",
  toolsCopied: "Copied.",
  toolsCopyFailed:
    "Copying is not available here. The text is selected; copy it with the keyboard.",
  toolsClose: "Close",
  toolsMcpTitle: "Connect another app through an MCP server",
  toolsMcpText:
    "For an app the catalog does not cover, an agent sets up an MCP server on your request. MCP servers are not recorded in the Lazurio Folder.",
  toolsMcpAction: "Set up an MCP server with an agent",
  toolsMcpPromptHint:
    "Copy this prompt and paste it into a new chat in T3 Code on this Machine. The agent asks which app you want, sets the server up and lets you sign in in your browser. You never copy an API key.",
  title: "Lazurio Launchpad",
  homeTitle: "Launchpad",
  settingsTitle: "Settings",
  settingsGeneral: "General",
  settingsBack: "Back",
  settingsBreadcrumb: "Where you are in Settings",
  navigationOpen: "Open navigation",
  technicalDetails: "Technical details",
  presetHint:
    "The kind of Machine this Folder is set up for. Only the presets its handover allows are offered.",
  localeHint:
    "The language of this page and of the agent instructions in this Folder. It changes once the change is applied.",
  detailHint:
    "How agents explain their work: briefly, or with technical explanation and evidence.",
  coordinationHint:
    "Whether agents work directly, or delegate within the task and verify the results.",
  profileHint:
    "Preview shows what would change in this Folder; nothing is written until you apply it.",
  toolsDetails: "Details",
  toolsDetailsNamed: "Details of {name}",
  toolsPathLabel: "Found at",
  notice: "Development fixture only. No Lazurio installation or migration.",
  legend: "Machine profile",
  machineTitle: "This Machine",
  machineNotice:
    "Recorded from the Machine handover; shown here, changed only by the Machines operator.",
  machineWorkstation: "Workstation of the signed-in Principal (no handover)",
  machineKind: "Kind",
  machineName: "Machine",
  machineOwner: "Owner",
  machineTeam: "Team",
  machineAssignment: "Assignment",
  machineAssignmentTeam: "shared by the Team",
  machineTailnet: "Tailnet node",
  machineHost: "Host",
  machineRelationships: "Relationships (enforced by Headscale, not here)",
  machineNoPeers: "no peers recorded",
  machineNoSsh: "no SSH",
  machineNoHttps: "no HTTPS",
  machineNone: "not recorded",
  preset: "Workspace preset",
  presetDerived: "derived from the handover",
  presetExplicit: "explicit choice",
  presetLocal: "Local workstation",
  presetHostedPersonal: "Personal",
  presetHostedOrganizationPersonal: "Work",
  presetHostedOrganizationTeam: "Work, Team",
  locale: "Language",
  detail: "Detail",
  concise: "Concise",
  technical: "Technical",
  coordination: "Coordination",
  direct: "Direct",
  coordinator: "Coordinator",
  preview: "Preview",
  reload: "Reload profile",
  apply: "Apply previewed change",
  revision: "Revision",
  previewComplete: "Preview complete. No changes applied.",
  refused: "Operation refused; reload state or use CLI recovery.",
  reloadFailed: "Cannot reload profile; CLI recovery may be required.",
  loadFailed:
    "Cannot read profile. Open the session link from CLI; pending state may require CLI recovery.",
} as const;
export type MessageKey = keyof typeof en;
const cs: Record<MessageKey, string> = {
  appDiscover: "Načíst deklarované aplikace",
  appDiscovered: "Nalezená aplikace",
  appDiscoveryNotice:
    "Pouze lokální deklarace, ne oprávnění ani připravenost. Konflikty a nedostupné moduly jsou uvedeny níže.",
  appDiscoveryUnavailable:
    "Aplikace nelze načíst. V CLI vyberte povolenou kanonickou organizaci; starý formát se jako náhrada nepoužívá.",
  appPrepare: "Připravit závislosti",
  appCleanPrepare: "Přeinstalovat závislosti (odstranit node_modules)",
  appPrepared:
    "Příprava modulu byla dokončena. Aplikaci zvlášť spusťte a ověřte její funkci.",
  appPreparationUnavailable:
    "Příprava modulu není v této vývojové relaci nakonfigurovaná.",
  appPrerequisitesNotReady:
    "Kontrola předpokladů modulu neproběhla úspěšně, proto aplikace nebyla spuštěna. Před výslovnou přípravou závislostí nebo opakováním ověřte závislosti a požadavky modulu na nastavení.",
  appPreparationPreflightFailed:
    "Vstupní kontroly přípravy selhaly před zastavením aplikace. Ověřte deklarace modulu, lockfile a požadované nástroje.",
  appPreparationCleanupRequired:
    "Nelze potvrdit úklid předchozích procesů. Další příprava a spouštění jsou zablokované; před opakováním vyřešte úklid přes stávajícího správce procesů.",
  appOtherAppManaged:
    "Jiná aplikace této Organizace běží nebo čeká na úklid. Před přípravou závislostí ji výslovně zastavte; příprava ji sama nezastaví.",
  appDeclarationChanged:
    "Změnila se deklarace aplikace nebo její umístění. Obnovte výběr a před opakováním ověřte zamýšlený modul.",
  appCoordinationBusy:
    "S aplikacemi této Organizace právě pracuje jiný proces Lazuria. Nic se nezměnilo; zkuste to znovu, až skončí.",
  appPreparationRecoveryRequired:
    "Dřívější příprava závislostí tohoto modulu nedoběhla nebo není potvrzen její úklid. Příprava i spuštění zůstávají zablokované, dokud se to výslovně nevyřeší; zastavení a stav fungují dál.",
  appApplicationRunning:
    "Tato aplikace běží pod správcem služeb operačního systému a někdo ji může používat. Závislosti se pod běžící aplikací nemění; nejdřív ji výslovně zastavte.",
  appServiceUnrecognized:
    "Existuje služba se jménem této aplikace, kterou ale Lazurio v očekávané podobě nevytvořilo. Nebyla spuštěna, zastavena ani změněna; prověřte ji správcem služeb operačního systému.",
  appHealthyPersistent:
    "Deklarované zdravotní kontroly prošly. Tato aplikace běží dál i při restartu Launchpadu; restart počítače nepřežije. Po otevření ověřte funkci aplikace.",
  appEnded:
    "Aplikace už neběží; její vlastník hlásí, že skončila. Prohlédněte výsledek a pak ji znovu spusťte, nebo ji zastavte a záznam tím uvolněte.",
  appsTitle: "Aplikace",
  appsNotice:
    "Výslovný vývojový výběr. Server musí povolit práci s deklarovanou aplikací.",
  appSelection: "Deklarovaná aplikace",
  appCompany: "Organizace",
  appModule: "Modul",
  appPackage: "Package",
  appStart: "Spustit",
  appStatus: "Stav",
  appOpen: "Získat odkaz aplikace",
  appStop: "Zastavit",
  appVisit: "Otevřít aplikaci na této mašině",
  appBusy: "Operace probíhá…",
  appStarted:
    "Proces je spuštěný. Před otevřením ověřte připravenost aplikace.",
  appHealthy:
    "Deklarované zdravotní kontroly prošly. Po otevření ověřte funkci aplikace.",
  appStopped: "Vlastněné procesy aplikace byly zastaveny.",
  appNotManaged: "Pro tento výběr není spravován proces aplikace.",
  appNotReady:
    "Aplikace není připravená nebo nebylo možné ověřit vlastnictví procesu.",
  appDenied: "Pro tuto operaci s aplikací nemáte přístup.",
  appUnavailable:
    "V této vývojové relaci nejsou nakonfigurované vazby aplikací.",
  appFailure:
    "Operace nebyla dokončena. Zkontrolujte výsledek; automatická oprava neproběhla.",
  appResultUnknown:
    "Výsledek operace nelze potvrdit. Operace může stále běžet; ztráta odpovědi ji neruší. Před opakováním změny ověřte stav u stávajícího správce procesů.",
  appLinkReady:
    "Lokální odkaz aplikace je připravený. Otevření samo neprokazuje její funkčnost.",
  appRemoteLink:
    "Tato adresa patří execution mašině. Vzdálené otevření vyžaduje ověřenou přístupovou cestu.",
  updateTitle: "Aktualizace produktu",
  updateNotes: "Poznámky k vydání",
  updateUnknown: "Lazurio {running}.",
  updateIdle: "Lazurio {running} je aktuální.",
  updateChecking: "Zjišťuje se nová verze…",
  updateAvailable: "Je k dispozici Lazurio {latest} (běží {running}).",
  updateDownloading: "Stahuje se a ověřuje Lazurio {latest}…",
  updateActivating:
    "Aktivuje se Lazurio {latest}. Launchpad se restartuje; aplikace běží dál.",
  updateRestart:
    "Lazurio {active} je nainstalované. Aktualizaci dokončí restart Launchpadu.",
  updateAction: "Aktualizovat",
  updateRetry: "Zkusit znovu",
  updateChecked: "Poslední ověřená kontrola: před {age}.",
  updateNeverChecked: "Zatím žádná ověřená kontrola.",
  updateStale:
    "Poslední ověřená kontrola: před {age}. Novější vydání může být této mašině zadržováno.",
  updateFailed:
    "Aktualizace se nedokončila: {code}. Nainstalovaná verze běží dál; stejné kliknutí ji zopakuje.",
  updateStateInvalid:
    "Stav aktualizace vyžaduje zásah člověka: {path}. Automaticky se nic nemění.",
  updateStarted: "Aktualizace spuštěna…",
  updateRefused: "Aktualizace nebyla spuštěna; zobrazený stav byl obnoven.",
  updateFolderRefresh:
    "Folder je potřeba obnovit: vykreslila ho revize šablon {recorded}, Lazurio teď vykresluje {product}. Spusť: {command}",
  toolsTitle: "Nástroje",
  toolsIntro:
    "Nástroje jsou programy pro příkazovou řádku, kterými agenti pracují s vnějšími službami. „Používají agenti“ vede agenty v tomhle Environmentu k tomu, aby nástroj používali. Instalace, odinstalace, přihlášení a odhlášení jsou samostatné kroky.",
  toolsSwitchLabel: "Používají agenti",
  toolsSwitchNamed: "Používají agenti: {name}",
  toolsTeamGithub: teamGithubText.cs,
  toolsTeamGithubLogout: teamGithubLogoutText.cs,
  toolsShared:
    "Tohle Environment je sdílené. Účty přihlášené v nástroji platí pro celé Environment a používají je všichni jeho operátoři.",
  toolsRefresh: "Obnovit stav",
  toolsLoading: "Načítají se nástroje…",
  toolsLoadFailed:
    "Nástroje se nepodařilo načíst. Zkuste Obnovit stav; když to nepomůže, spusťte v CLI lazurio tools list.",
  toolsChecked: "Revize Folderu {revision} · zjištěno v {time}",
  toolsTierRequired: "Povinné",
  toolsTierRequiredNote: "Vždy součást instrukcí pro agenty.",
  toolsTierRecommended: "Doporučené",
  toolsTierRecommendedNote:
    "Doporučený způsob, jak tohle Environment napojit na externí aplikace.",
  toolsTierOptional: "Volitelné",
  toolsTierOptionalNote:
    "Další nástroje pro jednotlivé služby. Zapněte ty, které používáte.",
  toolsInstalled: "Nainstalováno, verze {version}",
  toolsInstalledNoVersion: "Nainstalováno, verze neznámá",
  toolsNotInstalled: "Není nainstalováno",
  toolsVersionError: "Zjištění verze selhalo: {error}.",
  toolsOutsideStandard:
    "Nalezeno mimo ~/.local/bin, standardní místo pro nástroje. Funguje; jen se to hlásí.",
  toolsSetupLaunchpad: "Nastavení v Launchpadu",
  toolsSetupAgent: "Nastavení s agentem",
  toolsEnabled: "Zapnuto",
  toolsDisabled: "Vypnuto",
  toolsAlwaysOn: "Vždy zapnuto",
  toolsEnable: "Zapnout",
  toolsDisable: "Vypnout",
  toolsEnableNamed: "Zapnout {name}",
  toolsDisableNamed: "Vypnout {name}",
  toolsUsage: "Co se dozvědí agenti",
  toolsSource: "Oficiální zdroj",
  toolsBusy: "Pracuje se…",
  toolsEnabledDone:
    "{name} je zapnuto; instrukce pro agenty v tomhle Folderu se přepsaly. Revize Folderu {revision}.",
  toolsDisabledDone:
    "{name} už není zapnuto; instrukce pro agenty v tomhle Folderu se přepsaly. Revize Folderu {revision}.",
  toolsEnabledNotInstalled:
    "{name} zatím není nainstalováno; agenti to budou hlásit, dokud se nenastaví.",
  toolsNoteSaved:
    "Vaše poznámka k {name} je uložená; instrukce pro agenty v tomhle Folderu se přepsaly. Revize Folderu {revision}.",
  toolsNoteCleared:
    "Vaše poznámka k {name} je odebraná; instrukce pro agenty v tomhle Folderu se přepsaly. Revize Folderu {revision}.",
  toolsUndone:
    "Změna u {name} je vrácená; instrukce pro agenty v tomhle Folderu se přepsaly. Revize Folderu {revision}.",
  toolsUndo: "Vrátit zpět",
  toolsUndoNamed: "Vrátit zpět změnu u {name}",
  toolsUnchanged:
    "Nic se nezměnilo: Folder už přesně tohle eviduje. Načtěte jeho aktuální stav.",
  toolsBlockedStale:
    "Folder se mezitím změnil. Načtěte stav a zkuste to znovu; nic se nezapsalo.",
  toolsBlockedDrift:
    "Soubor {path} byl upraven ručně, proto ho Lazurio nepřepíše. Svou úpravu si uložte jinam, soubor vraťte do původní podoby a načtěte stav. Nic se nezapsalo.",
  toolsBlockedIncomplete:
    "Dřívější změna tohohle Folderu nedoběhla. Dokončete ji v CLI příkazem lazurio profile-resume a načtěte stav. Nic se nezapsalo.",
  toolsBlockedOther: "Změna byla odmítnuta ({reason}). Nic se nezapsalo.",
  toolsFailed:
    "Změnu se nepodařilo potvrdit. Načtěte stav; může být nutná obnova přes CLI.",
  toolsReload: "Načíst stav",
  toolsAgentAction: "Nastavit s agentem",
  toolsAgentActionNamed: "Nastavit {name} s agentem",
  toolsInstallAction: "Nainstalovat a přihlásit",
  toolsInstallOnlyAction: "Nainstalovat",
  toolsSignInAction: "Přihlásit",
  toolsSignedInAs: "Přihlášeno jako {account}",
  toolsSignedInAsOrganization: "Přihlášeno jako {account} ({organization})",
  toolsSignedIn: "Přihlášeno",
  toolsSignedOut: "Nepřihlášeno",
  toolsSignInUnknown: "Přihlášení nezjištěno",
  toolsSignInUnchecked: "Přihlášení se nezjišťovalo",
  toolsUsageCatalog: "Co o tomhle nástroji agentům říká Lazurio:",
  toolsNoteLabel: "Vaše poznámka pro agenty",
  toolsNoteHint:
    "Napište sem záměr, se kterým nástroj používáte. Agenti ji čtou v manual/this-machine.md tohohle Folderu; neuděluje žádný přístup.",
  toolsNoteCount: "{count} / {max} znaků",
  toolsNoteTooLong: "Poznámka je delší než {max} znaků.",
  toolsNoteTooManyLines: "Poznámka má víc než {max} řádků.",
  toolsNoteControl:
    "Poznámka obsahuje nepovolené znaky (řídicí znaky nebo znaky směru textu).",
  toolsNoteSave: "Uložit poznámku",
  toolsNoteSaveNamed: "Uložit poznámku k {name}",
  toolsNoteClear: "Smazat poznámku",
  toolsNoteClearNamed: "Smazat poznámku k {name}",
  toolsNoteAfterEnable:
    "Až nástroj zapnete, můžete sem agentům napsat poznámku.",
  toolsInstallActionNamed: "Nainstalovat {name} a přihlásit",
  toolsInstallOnlyNamed: "Nainstalovat {name}",
  toolsSignInActionNamed: "Přihlásit do {name}",
  toolsSignOutAction: "Odhlásit",
  toolsSignOutNamed: "Odhlásit z {name}",
  toolsSignedOutLocal:
    "{name}: odhlášeno na téhle Mašině. Poskytovatel přihlášení eviduje, dokud ho nezrušíte v nastavení účtu u něj.",
  toolsSignedOutRemote:
    "{name}: odhlášeno; propojené zařízení bylo z účtu odebráno.",
  toolsSignOutFailed:
    "{name}: odhlášení nedoběhlo ({reason}). Obnovte stav a uvidíte, jak to je.",
  toolsLoginTitleInstall: "Nainstalovat a přihlásit: {name}",
  toolsLoginTitle: "Přihlásit: {name}",
  toolsLoginContinue: "Pokračovat",
  toolsStepInstalling: "Instalace",
  toolsStepWaiting: "Čeká se na vás",
  toolsStepSignedIn: "Přihlášeno",
  toolsStepDone: "{step}: hotovo",
  toolsStepCurrent: "{step}: probíhá",
  toolsStepTodo: "{step}: následuje",
  toolsStepFailed: "{step}: nedoběhlo",
  toolsInstalling:
    "{name} se instaluje z oficiálního zdroje. Může to chvíli trvat.",
  toolsInstalledNow: "{name} {version} je nainstalovaný.",
  toolsAlreadyInstalled: "{name} na téhle Mašině už funguje; nic se neměnilo.",
  toolsInstallFailed:
    "Instalace nedoběhla (krok {stage}: {reason}). Nic, co už fungovalo, se nezměnilo.",
  toolsInstallUnsupported:
    "Instalátor zabudovaný v Lazuriu tuhle Mašinu nepokrývá ({platform} {arch}).",
  toolsInstallNotOnPath:
    "~/.local/bin není na PATH tohoto Launchpadu, takže ho agenti nemusí najít, dokud se nepřidá do profilu shellu.",
  toolsInstallBusy:
    "Tenhle nástroj se už instaluje. Počkejte, až instalace skončí, a obnovte stav.",
  toolsFinishWithAgent: "Dokončit s agentem",
  toolsAgentFallback:
    "Nastavení může dokončit agent podle sepsaného cílového stavu tohoto nástroje.",
  toolsLoginStarting: "Spouští se přihlášení…",
  toolsLoginGhText:
    "Na libovolném zařízení (tomhle počítači, jiném nebo telefonu) otevřete stránku zařízení GitHubu a zadejte tento kód:",
  toolsLoginGhLink: "Otevřít github.com/login/device v nové záložce",
  toolsLoginCodeLabel: "Jednorázový kód",
  toolsLoginComposioText:
    "Na libovolném zařízení otevřete v nové záložce přihlašovací stránku Composia a přihlaste se svým účtem. Stránka platí 10 minut. Žádný klíč nekopírujete.",
  toolsLoginComposioLink: "Otevřít přihlašovací stránku Composia",
  toolsLoginQrText:
    "V telefonu otevřete WhatsApp, pak Nastavení, Propojená zařízení, Propojit zařízení, a namiřte fotoaparát na tento kód. Kód se každých pár sekund mění; tady je vždy ten nejnovější.",
  toolsLoginQrAlt:
    "QR kód, který propojí WhatsApp s tímto Environmentem. Naskenujte ho ve WhatsAppu v telefonu v Nastavení, Propojená zařízení, Propojit zařízení. Když ho naskenovat nejde, spárujte telefonním číslem níže.",
  toolsLoginPhoneTitle: "Spárovat raději telefonním číslem",
  toolsLoginPhoneLabel: "Vaše telefonní číslo ve WhatsAppu s předvolbou země",
  toolsLoginPhoneAction: "Získat párovací kód",
  toolsLoginPhoneInvalid:
    "Zadejte číslo s předvolbou země, například +420 123 456 789.",
  toolsLoginPairText:
    "V telefonu otevřete WhatsApp, pak Nastavení, Propojená zařízení, Propojit zařízení, dále Propojit telefonním číslem a zadejte tento kód:",
  toolsLoginPairLabel: "Párovací kód pro {phone}",
  toolsLoginQrAgain: "Zobrazit raději QR kód",
  toolsLoginWaiting:
    "Čeká se, až to dokončíte. Okno to ověřuje každé 2 sekundy.",
  toolsLoginSignedIn: "Jste přihlášeni do {name}.",
  toolsLoginSignedInAs: "Jste přihlášeni do {name} jako {account}.",
  toolsLoginWacliSync:
    "WhatsApp teď na pozadí kopíruje vaše nedávné zprávy do tohoto Environmentu. Okno můžete zavřít.",
  toolsLoginFailureNotInstalled: "Nástroj na téhle Mašině není nainstalovaný.",
  toolsLoginFailureUrl:
    "Nástroj nabídl adresu, která není jeho oficiální přihlašovací stránkou, a proto se nezobrazila.",
  toolsLoginFailureOutput: "Nástroj odpověděl v podobě, kterou Lazurio nezná.",
  toolsLoginFailureExit: "Nástroj skončil, aniž by přihlášení dokončil.",
  toolsLoginFailureNotConfirmed:
    "Nástroj skončil, ale jeho stav neříká, že je přihlášený.",
  toolsLoginFailureSpawn: "Nástroj se nepodařilo spustit.",
  toolsLoginExpired:
    "Přihlášení vypršelo dřív, než bylo dokončeno. Spusťte ho znovu, až budete připraveni.",
  toolsLoginEnded:
    "Přihlášení už neběží. Když ho pořád potřebujete, spusťte ho znovu.",
  toolsLoginUnreadable:
    "Odpověď Launchpadu se nepodařilo přečíst. Zavřete okno a zkuste to znovu.",
  toolsLoginTryAgain: "Zkusit znovu",
  toolsSshLinked: "SSH klíč propojený",
  toolsSshNotLinked: "SSH klíč nepropojený",
  toolsSshUnknown: "SSH klíč neověřený",
  toolsSshTeam: capitalized(teamGithubPhrase.cs),
  toolsWorksAs: capitalized(teamGithubWorksAs.cs),
  toolsLinkSshAction: "Propojit SSH klíč",
  toolsLinkSshNamed: "Propojit SSH klíč téhle Mašiny s účtem {name}",
  toolsLoginTitleSsh: "Propojit SSH klíč: {name}",
  toolsStepLinking: "Propojení SSH klíče",
  toolsStepLinked: "SSH klíč propojený",
  toolsLoginLinking:
    "Přihlášeno do GitHubu. Lazurio teď propojí SSH klíč téhle Mašiny s vaším účtem a ověří, že git přes SSH funguje. Trvá to pár sekund.",
  toolsLoginRefreshText:
    "Vaše přihlášení gh zatím nesmí spravovat SSH klíče vašeho účtu. Abyste to povolili, otevřete na libovolném zařízení (tomhle počítači, jiném nebo telefonu) stránku zařízení GitHubu a zadejte tento kód:",
  toolsSshLinkedDone:
    "SSH klíč téhle Mašiny je propojený: git clone git@github.com:… funguje jako {account}.",
  toolsSshKeyCreated:
    "Vytvořil se nový klíč bez hesla, aby ho agenti mohli používat: {path} ({fingerprint}).",
  toolsSshKeyReused:
    "Používá se stávající klíč {path} ({fingerprint}) beze změny.",
  toolsSshNotLinkedDone:
    "V gh jste přihlášeni jako {account}, ale SSH klíč téhle Mašiny propojený není, takže git přes SSH zatím nefunguje.",
  toolsSshFailureNotSignedIn: "gh na téhle Mašině není přihlášený.",
  toolsSshFailureScopeMissing:
    "Přihlášení gh nesmí spravovat SSH klíče vašeho účtu.",
  toolsSshFailureKeygenMissing:
    "Na téhle Mašině není nainstalovaný ssh-keygen.",
  toolsSshFailureKeygenFailed: "Nový klíč se v ~/.ssh nepodařilo vytvořit.",
  toolsSshFailureKeyPassphrase:
    "Stávající klíč {path} je chráněný heslem, které agenti zadat nemůžou. Zůstal, jak byl.",
  toolsSshFailureKeyIncomplete:
    "Ke stávajícímu klíči {path} chybí odpovídající soubor .pub. Zůstal, jak byl.",
  toolsSshFailureKeyUnreadable:
    "Stávající klíč {path} se nepodařilo přečíst. Zůstal, jak byl.",
  toolsSshFailureKeyInUse:
    "GitHub klíč {path} odmítá, protože ho tam už používá jiný účet GitHubu nebo repozitář jako deploy key. Druhý klíč se nevytvořil.",
  toolsSshFailureRegisterFailed:
    "Klíč se nepodařilo zaregistrovat u vašeho účtu GitHubu.",
  toolsSshFailureHostKeysUnavailable:
    "Zveřejněné klíče serverů GitHubu se nepodařilo načíst.",
  toolsSshFailureHostKeyMismatch:
    "~/.ssh/known_hosts obsahuje klíč serveru github.com, který se liší od klíčů zveřejněných GitHubem. Nic se nezměnilo.",
  toolsSshFailureKnownHostsFailed:
    "~/.ssh/known_hosts se nepodařilo přečíst ani zapsat.",
  toolsSshFailureSshMissing: "Na téhle Mašině není nainstalované ssh.",
  toolsSshFailureProofFailed:
    "Zkušební spojení s GitHubem přes SSH neodpovědělo pozdravem GitHubu.",
  toolsSshFailureProofOtherAccount:
    "GitHub přes SSH pozdravil jiný účet ({account}): tahle Mašina nabízí nejdřív jiný klíč.",
  toolsLoginFailureNotSignedIn:
    "gh na téhle Mašině není přihlášený. Nejdřív se přihlaste; SSH klíč se propojí jako součást přihlášení.",
  toolsSshRemoved:
    "SSH klíč téhle Mašiny ({fingerprint}) byl z vašeho účtu GitHubu odebrán; soubory klíče na Mašině zůstávají.",
  toolsSshRemovalNotRegistered:
    "SSH klíč téhle Mašiny u vašeho účtu GitHubu registrovaný nebyl.",
  toolsSshRemovalNoKey:
    "Tahle Mašina nemá v ~/.ssh žádný SSH klíč; z GitHubu se nic neodebralo.",
  toolsSshRemovalKept:
    "SSH klíč téhle Mašiny ({fingerprint}) zůstává registrovaný u vašeho účtu GitHubu, protože ho neregistrovalo Lazurio. Odeberte ho v Nastavení GitHubu, SSH and GPG keys (github.com/settings/keys), pokud má tahle Mašina přístup ztratit.",
  toolsSshRemovalFailed:
    "SSH klíč téhle Mašiny může být u vašeho účtu GitHubu pořád registrovaný: gh ho nedokázal odebrat. Odeberte ho v Nastavení GitHubu, SSH and GPG keys (github.com/settings/keys), pokud má tahle Mašina přístup ztratit.",
  toolsComposioOrgLabel: "Organizace Composia pro tohle Environment",
  toolsComposioOrgCurrent: "{name} (aktuální)",
  toolsComposioOrgHint:
    "Aplikace, které v Composiu napojíte, patří tomuto účtu a organizaci: účtu Environmentu, který používají jeho agenti.",
  toolsComposioOrgSaved:
    "Organizace Composia pro tohle Environment je teď {name}.",
  toolsComposioOrgFailed:
    "Organizaci se nepodařilo změnit. Změnit ji můžete později příkazem lazurio tools composio-org.",
  toolsComposioOrgLoading: "Načítají se vaše organizace v Composiu…",
  toolsComposioOrgUnavailable:
    "Organizace se nepodařilo načíst. Vybrat ji můžete později příkazem lazurio tools composio-org.",
  toolsPromptTitle: "Nastavit {name} s agentem",
  toolsPromptHint:
    "Zkopírujte tenhle prompt a vložte ho do nového chatu v T3 Code na téhle Mašině. Agent nástroj nainstaluje a provede vás přihlášením v prohlížeči. Žádný API klíč nikdy nekopírujete.",
  toolsPromptLabel: "Připravený prompt",
  toolsCopy: "Zkopírovat prompt",
  toolsCopied: "Zkopírováno.",
  toolsCopyFailed:
    "Kopírování tady není dostupné. Text je označený; zkopírujte ho klávesnicí.",
  toolsClose: "Zavřít",
  toolsMcpTitle: "Napojit další aplikaci přes MCP server",
  toolsMcpText:
    "Pro aplikaci, kterou katalog nepokrývá, nastaví agent na vaši žádost MCP server. MCP servery se do Lazurio Folderu nezapisují.",
  toolsMcpAction: "Nastavit MCP server s agentem",
  toolsMcpPromptHint:
    "Zkopírujte tenhle prompt a vložte ho do nového chatu v T3 Code na téhle Mašině. Agent se zeptá, kterou aplikaci chcete, server nastaví a přihlášení necháte proběhnout ve svém prohlížeči. Žádný API klíč nikdy nekopírujete.",
  title: "Lazurio Launchpad",
  homeTitle: "Launchpad",
  settingsTitle: "Nastavení",
  settingsGeneral: "Obecné",
  settingsBack: "Zpět",
  settingsBreadcrumb: "Kde v nastavení jste",
  navigationOpen: "Otevřít navigaci",
  technicalDetails: "Technické podrobnosti",
  presetHint:
    "Druh Mašiny, pro který je tenhle Folder nastavený. Nabízejí se jen presety, které dovoluje její handover.",
  localeHint:
    "Jazyk této stránky a instrukcí pro agenty v tomhle Folderu. Změní se, až změnu použijete.",
  detailHint:
    "Jak agenti vysvětlují svou práci: stručně, nebo s technickým vysvětlením a důkazy.",
  coordinationHint:
    "Zda agenti pracují přímo, nebo delegují v rozsahu zadání a výsledek ověří.",
  profileHint:
    "Náhled ukáže, co by se v tomhle Folderu změnilo; nic se nezapíše, dokud změnu nepoužijete.",
  toolsDetails: "Podrobnosti",
  toolsDetailsNamed: "Podrobnosti o {name}",
  toolsPathLabel: "Umístění",
  notice:
    "Pouze vývojová testovací složka. Nejde o instalaci Lazuria ani migraci.",
  legend: "Profil mašiny",
  machineTitle: "Tahle Mašina",
  machineNotice:
    "Zaznamenáno z handoveru Mašiny; tady se jen zobrazuje, mění ho jen operátor Machines.",
  machineWorkstation:
    "Pracovní stanice přihlášeného Principála (bez handoveru)",
  machineKind: "Druh",
  machineName: "Mašina",
  machineOwner: "Owner",
  machineTeam: "Team",
  machineAssignment: "Přiřazení",
  machineAssignmentTeam: "sdílená Teamem",
  machineTailnet: "Uzel tailnetu",
  machineHost: "Host",
  machineRelationships: "Vztahy (vynucuje Headscale, ne tahle stránka)",
  machineNoPeers: "žádní peers nezaznamenáni",
  machineNoSsh: "bez SSH",
  machineNoHttps: "bez HTTPS",
  machineNone: "nezaznamenáno",
  preset: "Preset pracovního prostředí",
  presetDerived: "odvozeno z handoveru",
  presetExplicit: "výslovná volba",
  presetLocal: "Lokální pracovní stanice",
  presetHostedPersonal: "Osobní",
  presetHostedOrganizationPersonal: "Pracovní",
  presetHostedOrganizationTeam: "Pracovní týmové",
  locale: "Jazyk",
  detail: "Podrobnost",
  concise: "Stručně",
  technical: "Technicky",
  coordination: "Koordinace",
  direct: "Přímá práce",
  coordinator: "Koordinátor",
  preview: "Náhled",
  reload: "Načíst aktuální profil",
  apply: "Použít zobrazenou změnu",
  revision: "Revize",
  previewComplete: "Náhled je připravený. Žádné změny nebyly použity.",
  refused:
    "Operace byla odmítnuta. Načtěte aktuální stav nebo použijte obnovu přes CLI.",
  reloadFailed: "Profil nelze znovu načíst. Může být nutná obnova přes CLI.",
  loadFailed:
    "Profil nelze načíst. Otevřete odkaz relace z CLI; rozpracovaný stav může vyžadovat obnovu přes CLI.",
};
export function messages(
  locale: unknown,
): Readonly<Record<MessageKey, string>> {
  return locale === "cs" ? cs : en;
}
