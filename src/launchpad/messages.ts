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
  appStart: "Start",
  appStatus: "Status",
  appOpen: "Get application link",
  appStop: "Stop",
  appVisit: "Open application in this Environment",
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
    "This address belongs to the Environment that runs the application. Remote browser access needs a qualified route.",
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
    "Last verified check: {age} ago. A newer release may be withheld from this Environment.",
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
    "{name}: signed out in this Environment. The provider still lists this sign-in until you revoke it in your account settings there.",
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
    "{name} already works in this Environment; nothing was changed.",
  toolsInstallFailed:
    "The installation did not finish (step {stage}: {reason}). Nothing that already worked was changed.",
  toolsInstallUnsupported:
    "The installer built into Lazurio does not cover this Environment ({platform} {arch}).",
  toolsInstallNotOnPath:
    "~/.local/bin is not on the PATH of this Launchpad, so agents may not find the tool until it is added to the shell profile.",
  toolsInstallBusy:
    "This tool is being installed already. Wait for it to finish, then refresh the status.",
  toolsFinishWithAgent: "Finish with an agent",
  toolsAgentFallback:
    "An agent can finish the setup by the written target state of this tool.",
  toolsLoginStarting: "Starting the sign-in…",
  toolsLoginStartingDetail:
    "Lazurio has started the tool's own sign-in and waits for its first step: a link, a code or a QR code. It usually takes a few seconds; after a minute without one the sign-in stops and says why.",
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
  toolsLoginAlreadySignedIn:
    "In this Environment {name} was already signed in; nothing was paired or changed.",
  toolsLoginAlreadySignedInAs:
    "In this Environment {name} was already signed in as {account}; nothing was paired or changed.",
  toolsLoginWacliSync:
    "WhatsApp now copies your recent messages to this Environment in the background. You can close this window.",
  toolsLoginFailureNotInstalled:
    "The tool is not installed in this Environment. Close this window and choose Install and sign in on its card.",
  toolsLoginFailureUrl:
    "The tool offered an address that is not its official sign-in page, so it was not shown.",
  toolsLoginFailureOutput: "The tool answered in a form Lazurio does not know.",
  toolsLoginFailureExit:
    "The tool ended without completing the sign-in. Try again; if it ends again, finish it with an agent.",
  toolsLoginFailureNotConfirmed:
    "The tool did not complete the sign-in: its status does not say signed in, so it was stopped. Try again; if it happens again, finish it with an agent.",
  toolsLoginFailureSpawn:
    "The tool could not be started. Try again; if it does not start, finish it with an agent.",
  toolsLoginFailureNoChallenge:
    "The tool showed no link, code or QR code within a minute, so its sign-in was stopped. Check that this Environment reaches the internet and try again; if it happens again, finish it with an agent.",
  toolsLoginNoAnswer:
    "The Launchpad did not answer in time. Try again; if it does not answer again, reload the page.",
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
  toolsLinkSshNamed:
    "Link the SSH key of this Environment to the {name} account",
  toolsLoginTitleSsh: "Link SSH key: {name}",
  toolsStepLinking: "Linking the SSH key",
  toolsStepLinked: "SSH key linked",
  toolsLoginLinking:
    "Signed in to GitHub. Lazurio now links the SSH key of this Environment to your account and checks that git over SSH works. This takes a few seconds.",
  toolsLoginRefreshText:
    "Your gh sign-in may not manage the SSH keys of your account yet. To allow it, open the GitHub device page on any device (this computer, another one or your phone) and enter this code:",
  toolsSshLinkedDone:
    "The SSH key of this Environment is linked: git clone git@github.com:… works as {account}.",
  toolsSshKeyCreated:
    "A new key without a passphrase was created, so agents can use it: {path} ({fingerprint}).",
  toolsSshKeyReused:
    "The existing key {path} ({fingerprint}) is used unchanged.",
  toolsSshNotLinkedDone:
    "You are signed in to gh as {account}, but the SSH key of this Environment is not linked, so git over SSH does not work yet.",
  toolsSshFailureNotSignedIn: "In this Environment gh is not signed in.",
  toolsSshFailureScopeMissing:
    "The gh sign-in may not manage the SSH keys of your account.",
  toolsSshFailureKeygenMissing:
    "ssh-keygen is not installed in this Environment.",
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
  toolsSshFailureSshMissing: "ssh is not installed in this Environment.",
  toolsSshFailureProofFailed:
    "The test connection to GitHub over SSH did not answer with GitHub's greeting.",
  toolsSshFailureProofOtherAccount:
    "Over SSH GitHub greeted another account ({account}): another key of this Environment is offered first.",
  toolsLoginFailureNotSignedIn:
    "In this Environment gh is not signed in. Sign in first; the SSH key is linked as part of it.",
  toolsLoginFailureEnvironment:
    "The kind of this Environment could not be read, so the sign-in stopped before changing anything further.",
  toolsSshRemoved:
    "The SSH key of this Environment ({fingerprint}) was removed from your GitHub account; the key files stay in this Environment.",
  toolsSshRemovalNotRegistered:
    "The SSH key of this Environment was not registered on your GitHub account.",
  toolsSshRemovalNoKey:
    "This Environment has no SSH key in ~/.ssh; nothing was removed from GitHub.",
  toolsSshRemovalKept:
    "The SSH key of this Environment ({fingerprint}) stays registered on your GitHub account because Lazurio did not register it. Remove it under GitHub Settings, SSH and GPG keys (github.com/settings/keys), if this Environment must lose access.",
  toolsSshRemovalFailed:
    "The SSH key of this Environment may still be registered on your GitHub account: gh could not remove it. Remove it under GitHub Settings, SSH and GPG keys (github.com/settings/keys), if this Environment must lose access.",
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
    "Copy this prompt and paste it into a new chat in T3 Code in this Environment. The agent installs the tool and guides you through the sign-in in your browser. You never copy an API key.",
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
    "Copy this prompt and paste it into a new chat in T3 Code in this Environment. The agent asks which app you want, sets the server up and lets you sign in in your browser. You never copy an API key.",
  // The Apps home and its left column (decision F36).
  appsAll: "All modules",
  appsSearch: "Search",
  appsSearchLabel: "Search modules",
  appsPersonal: "Personal",
  appsWorkspaceSubtitle: "{name} Workspace",
  appsProductionspaceSubtitle:
    "The Organization's repositories with their own release, read-only",
  appsModulesOne: "{count} module",
  appsModulesFew: "{count} modules",
  appsModulesMany: "{count} modules",
  appsRepositoriesOne: "{count} repository",
  appsRepositoriesFew: "{count} repositories",
  appsRepositoriesMany: "{count} repositories",
  appsOpenApp: "Open app",
  appsOpenAppNamed: "Open the app of {name} in a new tab",
  appsOverviewNamed: "Overview of the module {name}",
  appsCannotStart: "Cannot start",
  appsNoApp: "No app",
  appsRunning: "running",
  appsRepositoryNamed: "The repository {name} on GitHub, in a new tab",
  appsOrganizationPick: "Choose an Organization",
  appsAbout: "About the module",
  appsFolder: "Folder",
  appsLog: "App log",
  appsLogHint:
    "The Launchpad does not show the log yet. Its last lines are read on the command line of this Environment:",
  appsStarting: "Starting {name}…",
  appsStartFailed: "{name} could not be opened. Its overview says why.",
  appsNoMatch: "No module matches.",
  appsColumn: "Modules of {name}",
  // The org-agnostic description of a module by its stone's semantic key,
  // when its app declares none (decision F36; the root Launchpad's
  // `description.<key>`).
  appsDescriptionControl: "Processes, automations, and work coordination.",
  appsDescriptionBook: "Guides, documentation, and shared knowledge.",
  appsDescriptionPen: "Create, manage, and publish content.",
  appsDescriptionPalette: "Visual system, brand, and shared components.",
  appsDescriptionDeal: "Deals, proposals, and customer work.",
  appsDescriptionWarehouse: "Inventory, stock levels, and material movements.",
  appsDescriptionProduct: "Product catalog, parameters, and source materials.",
  appsDescriptionDatasheet: "Structured data and technical source materials.",
  appsDescriptionPricebook: "Price lists, rates, and sales materials.",
  appsDescriptionInvoice: "Invoices, customers, and payment records.",
  appsDescriptionInstallation: "Customer delivery and related project work.",
  appsDescriptionDashboard: "Company overview, results, and key metrics.",
  appsDescriptionProfitability:
    "Margins, costs, and the financial health of projects.",
  appsDescriptionMarketing: "Marketing activities, campaigns, and materials.",
  appsDescriptionWebsite: "Web content, pages, and public presentation.",
  appsDescriptionExamples: "Examples, patterns, and reference solutions.",
  appsDescriptionDatabase: "Data, records, and their safe management.",
  appsDescriptionApp: "Working files and materials for this module.",
  appsDescriptionSystem: "Operations tools and technical infrastructure.",
  appsDescriptionDefault:
    "An application for day-to-day work in the {module} module.",
  title: "Lazurio Launchpad",
  homeTitle: "Launchpad",
  catalogNavigation: "Organizations",
  catalogBreadcrumb: "Where you are in the Launchpad",
  catalogIntro:
    "The Organizations and modules of this Folder, read from its organizations/ directory each time. A module's page starts, stops and opens its app.",
  catalogRefresh: "Refresh",
  catalogLoading: "Reading Organizations…",
  catalogLoadFailed:
    "The Organizations could not be read. Try Refresh; if it keeps failing, run lazurio organization list in the CLI.",
  catalogEmpty:
    "No Organizations in this Folder. An Organization appears here once its repository is in organizations/.",
  catalogNotFound:
    "This Organization or module is not in this Folder. It may have been renamed or removed; see all Organizations.",
  catalogAll: "All Organizations",
  chat: "Chat",
  chatTitle: "Open T3 Code in this Environment",
  mausbot: "Lazurio MausBot",
  mausbotTitle: "Open Lazurio MausBot in this Environment",
  catalogModules: "Modules",
  catalogNoModules: "This Organization declares no modules.",
  catalogLayoutOrganization: "Organization",
  catalogLayoutWorkspace: "Workspace",
  catalogLayoutProductionspace: "Productionspace",
  catalogCheckedOut: "Checked out",
  catalogNotCheckedOut: "Not checked out",
  catalogRepositoryOpen: "GitHub",
  catalogRepositoryOpenNamed: "Open the repository {name} on GitHub",
  catalogOrganization: "Organization",
  catalogDirectory: "Directory",
  catalogState: "Resolution state",
  catalogIssues: "Issues",
  catalogApps: "Apps",
  catalogDefaultApp: "Default app",
  catalogDefaultMark: "default",
  catalogPath: "Path",
  catalogStatus: "Can it run",
  catalogNone: "none",
  catalogReady: "Can run",
  catalogReadyNamed: "{name}: can run",
  catalogBlockedNamed: "{name}: cannot run",
  catalogReasonCanonical:
    "No canonical lazurio.organization.json: the Organization cannot be read.",
  catalogReasonConflict:
    "The Organization's documents conflict or cannot be read.",
  catalogReasonNotExecutable:
    "This Organization's resolution state does not allow its modules to run.",
  catalogReasonTemplate: "A template Organization; templates never run.",
  catalogReasonChanged:
    "The Organization changed while it was being read. Refresh.",
  catalogReasonUnavailable:
    "The directory cannot be read: it must be a real directory owned by you.",
  catalogReasonDuplicate:
    "Another directory in this Folder declares the same Organization.",
  catalogReasonPersonalspaceAmbiguous:
    "personalspace/ holds more than one directory; only the Operator's own may be there, and none is read until it is the only one.",
  catalogReasonPersonalspaceUnavailable:
    "The Personalspace cannot be read: its directories must be real directories owned by you.",
  catalogReasonDeclaration:
    "The module's declaration in modules.manifest.json conflicts with another.",
  catalogReasonModuleUnavailable:
    "The module's checkout or its lazurio.module.json cannot be read.",
  catalogReasonExplicitApps: "lazurio.module.json does not list its apps.",
  catalogReasonNoApp: "The module has no app to run.",
  catalogReasonDefaultApp:
    "The default app's runtime declaration is missing or invalid.",
  catalogReasonDeclarationNotRegular:
    "{file} is not a regular file (a symlink, for example); Lazurio reads the module's files only as files of your own checkout.",
  catalogReasonDeclarationOwner:
    "{file} belongs to another account in this Environment, so it is not a file of your own checkout. Make it yours again (for example with chown) or check it out again.",
  catalogReasonDeclarationTooLarge:
    "{file} is larger than a file of the checkout may be (1 MiB; 16 MiB for a lockfile).",
  catalogReasonDirectoryNotRegular:
    "{file} is not a real directory (a symlink, for example); Lazurio reads the checkout only through its own directories.",
  catalogReasonDirectoryOwner:
    "The directory {file} belongs to another account in this Environment, so it is not your own checkout. Make it yours again (for example with chown) or check it out again.",
  preparationReasonOwnerInvalid:
    "{file} cannot prepare this app: it is missing, is not a package, or the app is not a declared member of its workspace.",
  preparationReasonScriptMissing:
    "The preparation declared in the app names a script that {file} does not have.",
  preparationReasonLockfileMissing:
    "{file} has no Bun lockfile (bun.lock) beside it, so its dependencies cannot be installed exactly. Commit the lockfile with the app.",
  preparationReasonLockfileAmbiguous:
    "{file} has both bun.lock and bun.lockb beside it; keep only the one Bun installs from.",
  preparationReasonPackageManager:
    "The packageManager of {file} is not an exact Bun version (bun@x.y.z); Lazurio installs and runs modules with Bun.",
  preparationReasonWorkspace:
    "{file} is a workspace; installing a workspace is not supported yet.",
  preparationReasonApplicationsOverlap:
    "{file} lies inside, or contains, the directory of another app of this module, whose running app its install could change, so a start does not install it. Keep the module's apps in sibling directories (app/v1, app/v2); an app that declares its preparation (lazurio.preparation) can be prepared explicitly (lazurio module prepare) while the module's other apps are stopped.",
  preparationReasonDependencyOutside:
    "{file} depends on a local package (file:…) outside its Organization's checkout; a local dependency must lie in the same Organization.",
  preparationReasonDependencyMissing:
    "{file} depends on a local package (file:…) that is not in the checkout; check out the repository that holds it.",
  preparationReasonToolchainMismatch:
    "{file} pins a Bun version (packageManager) that the Bun in ~/.local/bin is not.",
  preparationReasonInstallFailed:
    "Installing the dependencies from {file} failed (bun install --frozen-lockfile): the lockfile may not match the package, or a dependency could not be fetched.",
  preparationReasonScriptFailed:
    "The module's preparation script declared in {file} failed after its dependencies were installed, so the app was not started. Fix the module's preparation and start again.",
  modulePrerequisitesNotReady:
    "The module's declared check still fails after its dependencies were installed and its preparation ran, so the app was not started. Fix the module's preparation or its check and start again.",
  moduleApplication: "Application",
  moduleStart: "Start",
  moduleStop: "Stop",
  moduleOpen: "Open",
  moduleOpenNamed: "Open {name} in a new tab",
  moduleBusy: "Working…",
  moduleStatusUnknown: "Status not known yet.",
  moduleRunning: "Running",
  moduleStarting: "Starting…",
  moduleNotReady: "Running, not ready yet",
  moduleStopping: "Stopping…",
  moduleStopped: "Stopped",
  moduleEnded:
    "Ended by itself. Stop it to confirm its processes are gone, then start it again.",
  moduleKeepsRunning:
    "Keeps running when the Launchpad restarts; ends with a reboot.",
  moduleSessionBound: "Ends when this Launchpad ends.",
  moduleStarted: "Started. Waiting for it to report healthy…",
  moduleStartedHealthy: "Started and healthy.",
  moduleAlreadyRunning: "It was already running.",
  moduleStoppedDone: "Stopped; its processes ended.",
  moduleStartPending:
    "The start is still running (Lazurio is installing or preparing the app); it goes on, and the status shows the app once it runs.",
  modulePreparePending:
    "The preparation is still running; it goes on without starting the app.",
  moduleNotRunning: "It was not running.",
  moduleRefused: "Refused: {reason}.",
  moduleReasonToolchain:
    "Bun is missing from ~/.local/bin, where Lazurio runs modules with it. See Settings → Tools.",
  moduleReasonPortOccupied:
    "Another process listens on the module's declared port. Stop it first.",
  moduleReasonFailed:
    "The lifecycle failed before it could confirm a change, for a reason it cannot name. See lazurio module status and lazurio doctor.",
  moduleNoLinkEntry:
    "No link: the recorded entry of this Remote Environment names no hostname for modules yet.",
  moduleNoLinkApp:
    "No link: the gateway of this Remote Environment serves only the module's default app.",
  moduleNoLinkBrowser: "No link: the app declares no browser entrypoint.",
  moduleNoLink: "No link: {reason}.",
  recoveryTitle: "Recovery",
  recoveryIntro:
    "Whether Lazurio in this Environment needs a repair, read by the same check as lazurio recover. Reading changes nothing.",
  recoveryModeTitle: "The Launchpad is in Recovery mode",
  recoveryModeText:
    "It could not start normally and serves only this page. T3 Code, your tools, the Folder and the repositories keep working.",
  recoveryCheckLabel: "Check",
  recoveryReasonLabel: "Reason",
  recoveryReasonFolderStateUnreadable:
    "This version cannot read the Folder or its state: it is not owned by your account, or it holds entries, keys or a schema this version does not know.",
  recoveryReasonFolderTransactionPending:
    "A profile or tools change in the Folder was interrupted and is not finished.",
  recoveryReasonFolderLockUnavailable:
    "The Folder's operation lock cannot be taken.",
  recoveryReasonHostedEntryInvalid:
    "The hosted entry recorded in the Folder is not one this version accepts.",
  recoveryReasonAssetMissing:
    "The page this executable carries does not serve completely.",
  recoveryReasonUnknown: "A reason this page does not know.",
  recoveryLoading: "Checking…",
  recoveryAgain: "Check again",
  recoveryLoadFailed:
    "The check could not be read here. An agent in this Environment can run lazurio recover.",
  recoveryHealthy: "Lazurio in this Environment is healthy.",
  recoveryBroken: "Lazurio in this Environment needs a repair.",
  recoveryNotInstalled:
    "Lazurio is not installed in this Environment; there is nothing to check.",
  recoveryChecksTitle: "Checks",
  recoveryOutcomeOk: "ok",
  recoveryOutcomeFailed: "failed",
  recoveryOutcomeSkipped: "skipped",
  recoveryEvidenceTitle: "Evidence",
  recoveryEvidenceText:
    "Sanitized structured fields only, exactly as the prepared issue carries them.",
  recoveryJournalShow: "Show journal (stays in this Environment)",
  recoveryJournalHide: "Hide journal",
  recoveryJournalText:
    "The sanitized tail of the Launchpad's journal. It never leaves this Environment automatically.",
  recoveryPromptTitle: "Repair agent",
  recoveryPromptText:
    "Copy the prompt and paste it into a new chat of your agent app in this Environment (T3 Code in a Remote Environment). The agent repairs forward, or records the fault on GitHub.",
  recoveryPromptCopy: "Copy the prompt",
  recoveryPromptOpenT3: "Open T3 Code",
  recoveryIssueTitle: "Prepared issue",
  recoveryIssueText:
    "For the public repository {repository}. The repair agent files it after a search for a duplicate.",
  recoveryIssueCopy: "Copy the gh command",
  recoveryIssueLink: "Open the prefilled issue in the browser",
  recoveryIssueLinkPaste: "Open the issue form in the browser (paste the body)",
  recoveryIssueRefused:
    "No issue body was prepared: after sanitization it still contained {kinds}. Nothing may leave this Environment automatically.",
  recoveryNothingFiled:
    "Nothing was filed. This page only prepares the issue; nothing leaves this Environment automatically.",
  settingsTitle: "Settings",
  settingsGeneral: "General",
  settingsBack: "Back",
  settingsBreadcrumb: "Where you are in Settings",
  navigationOpen: "Open navigation",
  technicalDetails: "Technical details",
  presetHint:
    "The kind of Environment this Folder is set up for. Only the presets its handover allows are offered.",
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
  legend: "Environment profile",
  machineTitle: "This Environment",
  machineNotice:
    "Recorded when this Remote Environment was handed over; shown here, changed only by the operator who hosts it.",
  machineWorkstation: "Workstation of the signed-in Operator (no handover)",
  machineKind: "Kind",
  machineName: "Name",
  machineOwner: "Owner",
  machineTeam: "Team",
  machineAssignment: "Assignment",
  machineAssignmentTeam: "shared by the Team",
  machineAssignmentAutomation:
    "an automated Environment of an Organization persona; responsible operator {operator}",
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
  presetHostedOrganizationSteward: "Automated",
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
  filesTitle: "Files",
  filesIntro:
    "The Documents folder of this Environment. Agents save finished files here; download them, or upload files for the agents.",
  filesShared:
    "This Environment is shared: the whole Team sees and changes the same folder.",
  filesRoot: "Documents",
  filesPath: "Folder path",
  filesUpload: "Upload files",
  filesZip: "Download folder (ZIP)",
  filesRefresh: "Refresh",
  filesLoading: "Reading the folder…",
  filesLoadFailed: "The folder could not be read. Try Refresh.",
  filesUnavailable:
    "The Documents folder of this Environment cannot be used: it is not a folder, or it is a link to the home folder or the Lazurio Folder. An agent can fix it on request.",
  filesEmpty: "This folder is empty.",
  filesEmptyRoot:
    "This is the Documents folder of your Environment. Agents save finished files here, and the files you upload land here too. Nothing is here yet.",
  filesNotFound: "This folder or file does not exist.",
  filesOpenRoot: "Open Documents",
  filesIsFile: "{name} is a file.",
  filesOpenFolder: "Open its folder",
  filesName: "Name",
  filesSize: "Size",
  filesModified: "Modified",
  filesFolder: "Folder",
  filesDownload: "Download",
  filesDownloadNamed: "Download {name}",
  filesDownloading: "Downloading {name}…",
  filesDownloadFailed: "{name} could not be downloaded.",
  filesDrop: "Drop files to upload them to {folder}",
  filesFoldersSkipped:
    "Folders cannot be uploaded: upload the files inside, or a ZIP.",
  filesUploads: "Uploads",
  filesQueued: "Waiting",
  filesUploading: "Uploading, {percent}%",
  filesUploaded: "Uploaded",
  filesUploadedAs: "Uploaded as {name}",
  filesUploadedStatus: "{name} uploaded.",
  filesUploadCancelled: "Cancelled",
  filesCancel: "Cancel",
  filesCancelNamed: "Cancel the upload of {name}",
  filesUploadDiskFull: "Not enough free space in this Environment.",
  filesUploadIncomplete: "The upload was interrupted. Try again.",
  filesUploadName:
    "This name cannot be used here. Rename the file and try again.",
  filesUploadMissing: "The folder no longer exists.",
  filesUploadFailed: "The upload failed. Try again.",
} as const;
export type MessageKey = keyof typeof en;
const cs: Record<MessageKey, string> = {
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
    "Deklarované zdravotní kontroly prošly. Tato aplikace běží dál i při restartu Launchpadu; restart Environmentu nepřežije. Po otevření ověřte funkci aplikace.",
  appEnded:
    "Aplikace už neběží; její vlastník hlásí, že skončila. Prohlédněte výsledek a pak ji znovu spusťte, nebo ji zastavte a záznam tím uvolněte.",
  appStart: "Spustit",
  appStatus: "Stav",
  appOpen: "Získat odkaz aplikace",
  appStop: "Zastavit",
  appVisit: "Otevřít aplikaci na tomto Environmentu",
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
    "Tato adresa patří Environmentu, který aplikaci spouští. Vzdálené otevření vyžaduje ověřenou přístupovou cestu.",
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
    "Poslední ověřená kontrola: před {age}. Novější vydání může být tomuhle Environmentu zadržováno.",
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
    "Tenhle Environment je sdílený. Účty přihlášené v nástroji platí pro celý Environment a používají je všichni jeho operátoři.",
  toolsRefresh: "Obnovit stav",
  toolsLoading: "Načítají se nástroje…",
  toolsLoadFailed:
    "Nástroje se nepodařilo načíst. Zkuste Obnovit stav; když to nepomůže, spusťte v CLI lazurio tools list.",
  toolsChecked: "Revize Folderu {revision} · zjištěno v {time}",
  toolsTierRequired: "Povinné",
  toolsTierRequiredNote: "Vždy součást instrukcí pro agenty.",
  toolsTierRecommended: "Doporučené",
  toolsTierRecommendedNote:
    "Doporučený způsob, jak tenhle Environment napojit na externí aplikace.",
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
    "{name}: odhlášeno na tomhle Environmentu. Poskytovatel přihlášení eviduje, dokud ho nezrušíte v nastavení účtu u něj.",
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
  toolsAlreadyInstalled:
    "{name} na tomhle Environmentu už funguje; nic se neměnilo.",
  toolsInstallFailed:
    "Instalace nedoběhla (krok {stage}: {reason}). Nic, co už fungovalo, se nezměnilo.",
  toolsInstallUnsupported:
    "Instalátor zabudovaný v Lazuriu tenhle Environment nepokrývá ({platform} {arch}).",
  toolsInstallNotOnPath:
    "~/.local/bin není na PATH tohoto Launchpadu, takže ho agenti nemusí najít, dokud se nepřidá do profilu shellu.",
  toolsInstallBusy:
    "Tenhle nástroj se už instaluje. Počkejte, až instalace skončí, a obnovte stav.",
  toolsFinishWithAgent: "Dokončit s agentem",
  toolsAgentFallback:
    "Nastavení může dokončit agent podle sepsaného cílového stavu tohoto nástroje.",
  toolsLoginStarting: "Spouští se přihlášení…",
  toolsLoginStartingDetail:
    "Lazurio spustilo přihlášení nástroje a čeká na jeho první krok: odkaz, kód nebo QR kód. Obvykle to trvá pár sekund; když se do minuty neobjeví, přihlášení skončí a řekne proč.",
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
  toolsLoginAlreadySignedIn:
    "{name} už byl na tomhle Environmentu přihlášený; nic se nepárovalo ani neměnilo.",
  toolsLoginAlreadySignedInAs:
    "{name} už byl na tomhle Environmentu přihlášený jako {account}; nic se nepárovalo ani neměnilo.",
  toolsLoginWacliSync:
    "WhatsApp teď na pozadí kopíruje vaše nedávné zprávy do tohoto Environmentu. Okno můžete zavřít.",
  toolsLoginFailureNotInstalled:
    "Nástroj na tomhle Environmentu není nainstalovaný. Zavřete okno a na jeho kartě zvolte Nainstalovat a přihlásit.",
  toolsLoginFailureUrl:
    "Nástroj nabídl adresu, která není jeho oficiální přihlašovací stránkou, a proto se nezobrazila.",
  toolsLoginFailureOutput: "Nástroj odpověděl v podobě, kterou Lazurio nezná.",
  toolsLoginFailureExit:
    "Nástroj skončil, aniž by přihlášení dokončil. Zkuste to znovu; když skončí znovu, dokončete to s agentem.",
  toolsLoginFailureNotConfirmed:
    "Nástroj přihlášení nedokončil: jeho stav neříká, že je přihlášený, a proto se zastavil. Zkuste to znovu; když se to zopakuje, dokončete to s agentem.",
  toolsLoginFailureSpawn:
    "Nástroj se nepodařilo spustit. Zkuste to znovu; když se nespustí, dokončete to s agentem.",
  toolsLoginFailureNoChallenge:
    "Nástroj do minuty neukázal odkaz, kód ani QR kód, a proto se jeho přihlášení zastavilo. Ověřte, že se tenhle Environment dostane na internet, a zkuste to znovu; když se to zopakuje, dokončete to s agentem.",
  toolsLoginNoAnswer:
    "Launchpad včas neodpověděl. Zkuste to znovu; když zase neodpoví, obnovte stránku.",
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
  toolsLinkSshNamed: "Propojit SSH klíč tohohle Environmentu s účtem {name}",
  toolsLoginTitleSsh: "Propojit SSH klíč: {name}",
  toolsStepLinking: "Propojení SSH klíče",
  toolsStepLinked: "SSH klíč propojený",
  toolsLoginLinking:
    "Přihlášeno do GitHubu. Lazurio teď propojí SSH klíč tohohle Environmentu s vaším účtem a ověří, že git přes SSH funguje. Trvá to pár sekund.",
  toolsLoginRefreshText:
    "Vaše přihlášení gh zatím nesmí spravovat SSH klíče vašeho účtu. Abyste to povolili, otevřete na libovolném zařízení (tomhle počítači, jiném nebo telefonu) stránku zařízení GitHubu a zadejte tento kód:",
  toolsSshLinkedDone:
    "SSH klíč tohohle Environmentu je propojený: git clone git@github.com:… funguje jako {account}.",
  toolsSshKeyCreated:
    "Vytvořil se nový klíč bez hesla, aby ho agenti mohli používat: {path} ({fingerprint}).",
  toolsSshKeyReused:
    "Používá se stávající klíč {path} ({fingerprint}) beze změny.",
  toolsSshNotLinkedDone:
    "V gh jste přihlášeni jako {account}, ale SSH klíč tohohle Environmentu propojený není, takže git přes SSH zatím nefunguje.",
  toolsSshFailureNotSignedIn: "gh na tomhle Environmentu není přihlášený.",
  toolsSshFailureScopeMissing:
    "Přihlášení gh nesmí spravovat SSH klíče vašeho účtu.",
  toolsSshFailureKeygenMissing:
    "Na tomhle Environmentu není nainstalovaný ssh-keygen.",
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
  toolsSshFailureSshMissing: "Na tomhle Environmentu není nainstalované ssh.",
  toolsSshFailureProofFailed:
    "Zkušební spojení s GitHubem přes SSH neodpovědělo pozdravem GitHubu.",
  toolsSshFailureProofOtherAccount:
    "GitHub přes SSH pozdravil jiný účet ({account}): tenhle Environment nabízí nejdřív jiný klíč.",
  toolsLoginFailureNotSignedIn:
    "gh na tomhle Environmentu není přihlášený. Nejdřív se přihlaste; SSH klíč se propojí jako součást přihlášení.",
  toolsLoginFailureEnvironment:
    "Druh tohoto Environmentu se nepodařilo přečíst, proto se přihlášení zastavilo dřív, než by cokoli dalšího změnilo.",
  toolsSshRemoved:
    "SSH klíč tohohle Environmentu ({fingerprint}) byl z vašeho účtu GitHubu odebrán; soubory klíče na tomhle Environmentu zůstávají.",
  toolsSshRemovalNotRegistered:
    "SSH klíč tohohle Environmentu u vašeho účtu GitHubu registrovaný nebyl.",
  toolsSshRemovalNoKey:
    "Tenhle Environment nemá v ~/.ssh žádný SSH klíč; z GitHubu se nic neodebralo.",
  toolsSshRemovalKept:
    "SSH klíč tohohle Environmentu ({fingerprint}) zůstává registrovaný u vašeho účtu GitHubu, protože ho neregistrovalo Lazurio. Odeberte ho v Nastavení GitHubu, SSH and GPG keys (github.com/settings/keys), pokud má tenhle Environment přístup ztratit.",
  toolsSshRemovalFailed:
    "SSH klíč tohohle Environmentu může být u vašeho účtu GitHubu pořád registrovaný: gh ho nedokázal odebrat. Odeberte ho v Nastavení GitHubu, SSH and GPG keys (github.com/settings/keys), pokud má tenhle Environment přístup ztratit.",
  toolsComposioOrgLabel: "Organizace Composia pro tenhle Environment",
  toolsComposioOrgCurrent: "{name} (aktuální)",
  toolsComposioOrgHint:
    "Aplikace, které v Composiu napojíte, patří tomuto účtu a organizaci: účtu Environmentu, který používají jeho agenti.",
  toolsComposioOrgSaved:
    "Organizace Composia pro tenhle Environment je teď {name}.",
  toolsComposioOrgFailed:
    "Organizaci se nepodařilo změnit. Změnit ji můžete později příkazem lazurio tools composio-org.",
  toolsComposioOrgLoading: "Načítají se vaše organizace v Composiu…",
  toolsComposioOrgUnavailable:
    "Organizace se nepodařilo načíst. Vybrat ji můžete později příkazem lazurio tools composio-org.",
  toolsPromptTitle: "Nastavit {name} s agentem",
  toolsPromptHint:
    "Zkopírujte tenhle prompt a vložte ho do nového chatu v T3 Code na tomhle Environmentu. Agent nástroj nainstaluje a provede vás přihlášením v prohlížeči. Žádný API klíč nikdy nekopírujete.",
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
    "Zkopírujte tenhle prompt a vložte ho do nového chatu v T3 Code na tomhle Environmentu. Agent se zeptá, kterou aplikaci chcete, server nastaví a přihlášení necháte proběhnout ve svém prohlížeči. Žádný API klíč nikdy nekopírujete.",
  // The Apps home and its left column (decision F36).
  appsAll: "Všechny moduly",
  appsSearch: "Hledat",
  appsSearchLabel: "Hledat moduly",
  appsPersonal: "Osobní",
  appsWorkspaceSubtitle: "{name} Workspace",
  appsProductionspaceSubtitle:
    "Repozitáře Organizace s vlastním releasem, jen pro čtení",
  appsModulesOne: "{count} modul",
  appsModulesFew: "{count} moduly",
  appsModulesMany: "{count} modulů",
  appsRepositoriesOne: "{count} repozitář",
  appsRepositoriesFew: "{count} repozitáře",
  appsRepositoriesMany: "{count} repozitářů",
  appsOpenApp: "Otevřít aplikaci",
  appsOpenAppNamed: "Otevřít aplikaci modulu {name} v nové záložce",
  appsOverviewNamed: "Přehled modulu {name}",
  appsCannotStart: "Nelze spustit",
  appsNoApp: "Bez aplikace",
  appsRunning: "běží",
  appsRepositoryNamed: "Repozitář {name} na GitHubu v nové záložce",
  appsOrganizationPick: "Vybrat Organizaci",
  appsAbout: "O modulu",
  appsFolder: "Složka",
  appsLog: "Log aplikace",
  appsLogHint:
    "Launchpad log zatím neukazuje. Jeho poslední řádky přečteš v příkazové řádce tohoto Environmentu:",
  appsStarting: "Spouštím {name}…",
  appsStartFailed: "{name} se nepodařilo otevřít. Proč, říká přehled modulu.",
  appsNoMatch: "Žádný modul neodpovídá.",
  appsColumn: "Moduly {name}",
  // The org-agnostic description of a module by its stone's semantic key,
  // when its app declares none (decision F36; the root Launchpad's
  // `description.<key>`).
  appsDescriptionControl: "Procesy, automatizace a koordinace práce.",
  appsDescriptionBook: "Návody, dokumentace a sdílené znalosti.",
  appsDescriptionPen: "Tvorba, správa a publikace obsahu.",
  appsDescriptionPalette: "Vizuální systém, značka a sdílené komponenty.",
  appsDescriptionDeal: "Obchodní případy, nabídky a práce se zákazníky.",
  appsDescriptionWarehouse: "Skladové položky, zásoby a pohyby materiálu.",
  appsDescriptionProduct: "Produktový katalog, parametry a podklady.",
  appsDescriptionDatasheet: "Strukturovaná data a technické podklady.",
  appsDescriptionPricebook: "Ceníky, sazby a obchodní podklady.",
  appsDescriptionInvoice: "Faktury, odběratelé a evidence úhrad.",
  appsDescriptionInstallation:
    "Realizace u zákazníků a návazná projektová práce.",
  appsDescriptionDashboard: "Přehled firmy, výsledků a důležitých ukazatelů.",
  appsDescriptionProfitability: "Marže, náklady a finanční zdraví zakázek.",
  appsDescriptionMarketing: "Marketingové aktivity, kampaně a podklady.",
  appsDescriptionWebsite: "Webový obsah, stránky a veřejná prezentace.",
  appsDescriptionExamples: "Ukázky, vzory a referenční řešení.",
  appsDescriptionDatabase: "Data, záznamy a jejich bezpečná správa.",
  appsDescriptionApp: "Pracovní podklady a soubory tohoto modulu.",
  appsDescriptionSystem: "Provozní nástroje a technické zázemí.",
  appsDescriptionDefault: "Aplikace pro každodenní práci v modulu {module}.",
  title: "Lazurio Launchpad",
  homeTitle: "Launchpad",
  catalogNavigation: "Organizace",
  catalogBreadcrumb: "Kde v Launchpadu jste",
  catalogIntro:
    "Organizace a moduly tohoto Folderu, pokaždé znovu načtené z jeho složky organizations/. Stránka modulu jeho aplikaci spouští, zastavuje a otevírá.",
  catalogRefresh: "Načíst znovu",
  catalogLoading: "Načítám Organizace…",
  catalogLoadFailed:
    "Organizace nelze načíst. Zkuste Načíst znovu; když to nepomůže, spusťte v CLI lazurio organization list.",
  catalogEmpty:
    "V tomhle Folderu nejsou žádné Organizace. Organizace se tu objeví, jakmile je její repozitář v organizations/.",
  catalogNotFound:
    "Tahle Organizace nebo modul v tomhle Folderu není. Možná byl přejmenován nebo odstraněn; podívejte se na všechny Organizace.",
  catalogAll: "Všechny Organizace",
  chat: "Chat",
  chatTitle: "Otevřít T3 Code na tomto Environmentu",
  mausbot: "Lazurio MausBot",
  mausbotTitle: "Otevřít Lazurio MausBot na tomto Environmentu",
  catalogModules: "Moduly",
  catalogNoModules: "Tahle Organizace nedeklaruje žádné moduly.",
  catalogLayoutOrganization: "Organizace",
  catalogLayoutWorkspace: "Workspace",
  catalogLayoutProductionspace: "Productionspace",
  catalogCheckedOut: "Naklonovaný",
  catalogNotCheckedOut: "Nenaklonovaný",
  catalogRepositoryOpen: "GitHub",
  catalogRepositoryOpenNamed: "Otevřít repozitář {name} na GitHubu",
  catalogOrganization: "Organizace",
  catalogDirectory: "Složka",
  catalogState: "Stav rozlišení",
  catalogIssues: "Problémy",
  catalogApps: "Aplikace",
  catalogDefaultApp: "Výchozí aplikace",
  catalogDefaultMark: "výchozí",
  catalogPath: "Cesta",
  catalogStatus: "Lze spustit",
  catalogNone: "žádné",
  catalogReady: "Lze spustit",
  catalogReadyNamed: "{name}: lze spustit",
  catalogBlockedNamed: "{name}: nelze spustit",
  catalogReasonCanonical:
    "Chybí kanonický lazurio.organization.json: Organizaci nelze načíst.",
  catalogReasonConflict:
    "Dokumenty Organizace si odporují nebo je nelze přečíst.",
  catalogReasonNotExecutable:
    "Stav rozlišení této Organizace nedovoluje spouštět její moduly.",
  catalogReasonTemplate: "Šablona Organizace; šablony se nikdy nespouštějí.",
  catalogReasonChanged: "Organizace se během čtení změnila. Načtěte znovu.",
  catalogReasonUnavailable:
    "Složku nelze přečíst: musí to být skutečná složka, kterou vlastníte.",
  catalogReasonDuplicate:
    "Jiná složka v tomhle Folderu deklaruje stejnou Organizaci.",
  catalogReasonPersonalspaceAmbiguous:
    "V personalspace/ je víc než jedna složka; smí tam být jen ta Operátorova a žádná se nečte, dokud nezůstane jediná.",
  catalogReasonPersonalspaceUnavailable:
    "Personalspace nelze přečíst: jeho složky musí být skutečné složky, které vlastníte.",
  catalogReasonDeclaration:
    "Deklarace modulu v modules.manifest.json je v konfliktu s jinou.",
  catalogReasonModuleUnavailable:
    "Checkout modulu nebo jeho lazurio.module.json nelze přečíst.",
  catalogReasonExplicitApps:
    "lazurio.module.json neuvádí seznam svých aplikací.",
  catalogReasonNoApp: "Modul nemá žádnou aplikaci ke spuštění.",
  catalogReasonDefaultApp:
    "Deklarace běhu výchozí aplikace chybí nebo je neplatná.",
  catalogReasonDeclarationNotRegular:
    "{file} není obyčejný soubor (například je to symlink); Lazurio čte soubory modulu jen jako soubory vašeho vlastního checkoutu.",
  catalogReasonDeclarationOwner:
    "{file} patří jinému účtu na tomhle Environmentu, takže to není soubor vašeho vlastního checkoutu. Vraťte ho do svého vlastnictví (například chown) nebo ho znovu checkoutněte.",
  catalogReasonDeclarationTooLarge:
    "{file} je větší, než smí soubor checkoutu být (1 MiB; 16 MiB pro lockfile).",
  catalogReasonDirectoryNotRegular:
    "{file} není skutečná složka (například je to symlink); Lazurio čte checkout jen přes jeho vlastní složky.",
  catalogReasonDirectoryOwner:
    "Složka {file} patří jinému účtu na tomhle Environmentu, takže to není váš vlastní checkout. Vraťte ji do svého vlastnictví (například chown) nebo ji znovu checkoutněte.",
  preparationReasonOwnerInvalid:
    "{file} nemůže tuhle aplikaci připravit: chybí, není to balíček, nebo aplikace není deklarovaným členem jeho workspace.",
  preparationReasonScriptMissing:
    "Příprava deklarovaná v aplikaci jmenuje skript, který {file} nemá.",
  preparationReasonLockfileMissing:
    "Vedle {file} není Bun lockfile (bun.lock), takže jeho závislosti nejde nainstalovat přesně. Commitněte lockfile spolu s aplikací.",
  preparationReasonLockfileAmbiguous:
    "Vedle {file} je bun.lock i bun.lockb; nechte jen ten, ze kterého Bun instaluje.",
  preparationReasonPackageManager:
    "packageManager v {file} není přesná verze Bunu (bun@x.y.z); Lazurio moduly instaluje a spouští Bunem.",
  preparationReasonWorkspace:
    "{file} je workspace; instalace workspace zatím není podporovaná.",
  preparationReasonApplicationsOverlap:
    "{file} leží ve složce jiné aplikace tohoto modulu, nebo ji obsahuje, a jeho instalace by mohla změnit soubory, které ta běžící aplikace používá, proto ho start neinstaluje. Mějte aplikace modulu v sourozeneckých složkách (app/v1, app/v2); aplikaci s deklarovanou přípravou (lazurio.preparation) lze připravit výslovně (lazurio module prepare), když ostatní aplikace modulu neběží.",
  preparationReasonDependencyOutside:
    "{file} závisí na lokálním balíčku (file:…) mimo checkout své Organizace; lokální závislost musí být ve stejné Organizaci.",
  preparationReasonDependencyMissing:
    "{file} závisí na lokálním balíčku (file:…), který v checkoutu není; naklonujte repozitář, ve kterém je.",
  preparationReasonToolchainMismatch:
    "{file} vyžaduje verzi Bunu (packageManager), kterou Bun v ~/.local/bin nemá.",
  preparationReasonInstallFailed:
    "Instalace závislostí z {file} selhala (bun install --frozen-lockfile): lockfile možná neodpovídá balíčku, nebo nešlo stáhnout některou závislost.",
  preparationReasonScriptFailed:
    "Přípravný skript modulu deklarovaný v {file} po instalaci závislostí selhal, proto aplikace nebyla spuštěna. Opravte přípravu modulu a spusťte ji znovu.",
  modulePrerequisitesNotReady:
    "Deklarovaná kontrola modulu neprošla ani po instalaci závislostí a jeho přípravě, proto aplikace nebyla spuštěna. Opravte přípravu nebo kontrolu modulu a spusťte ji znovu.",
  moduleApplication: "Aplikace",
  moduleStart: "Spustit",
  moduleStop: "Zastavit",
  moduleOpen: "Otevřít",
  moduleOpenNamed: "Otevřít {name} na nové kartě",
  moduleBusy: "Pracuji…",
  moduleStatusUnknown: "Stav zatím není známý.",
  moduleRunning: "Běží",
  moduleStarting: "Spouští se…",
  moduleNotReady: "Běží, zatím není připravená",
  moduleStopping: "Zastavuje se…",
  moduleStopped: "Zastavená",
  moduleEnded:
    "Skončila sama. Zastavte ji, tím se ověří, že její procesy skončily, a pak ji spusťte znovu.",
  moduleKeepsRunning:
    "Běží dál i po restartu Launchpadu; restart Environmentu ji ukončí.",
  moduleSessionBound: "Skončí, až skončí tenhle Launchpad.",
  moduleStarted: "Spuštěno. Čekám, až se ohlásí zdravá…",
  moduleStartedHealthy: "Spuštěno a zdravé.",
  moduleAlreadyRunning: "Už běžela.",
  moduleStoppedDone: "Zastaveno; její procesy skončily.",
  moduleStartPending:
    "Spouštění ještě běží (Lazurio aplikaci instaluje nebo připravuje); pokračuje dál a stav aplikaci ukáže, až poběží.",
  modulePreparePending:
    "Příprava ještě běží; pokračuje dál a aplikaci nespustí.",
  moduleNotRunning: "Neběžela.",
  moduleRefused: "Odmítnuto: {reason}.",
  moduleReasonToolchain:
    "V ~/.local/bin chybí Bun, se kterým Lazurio moduly spouští. Viz Nastavení → Nástroje.",
  moduleReasonPortOccupied:
    "Na deklarovaném portu modulu poslouchá jiný proces. Nejdřív ho zastavte.",
  moduleReasonFailed:
    "Životní cyklus selhal dřív, než mohl změnu potvrdit, z důvodu, který neumí pojmenovat. Viz lazurio module status a lazurio doctor.",
  moduleNoLinkEntry:
    "Bez odkazu: zaznamenaný vstup tohohle Remote Environmentu zatím neuvádí hostname pro moduly.",
  moduleNoLinkApp:
    "Bez odkazu: gateway tohohle Remote Environmentu obsluhuje jen výchozí aplikaci modulu.",
  moduleNoLinkBrowser: "Bez odkazu: aplikace nedeklaruje vstup pro prohlížeč.",
  moduleNoLink: "Bez odkazu: {reason}.",
  recoveryTitle: "Obnova",
  recoveryIntro:
    "Jestli Lazurio na tomhle Environmentu potřebuje opravu, zjištěné stejnou kontrolou jako lazurio recover. Čtení nic nemění.",
  recoveryModeTitle: "Launchpad je v režimu obnovy (Recovery mode)",
  recoveryModeText:
    "Nepodařilo se ho normálně spustit, a tak ukazuje jen tuhle stránku. T3 Code, vaše nástroje, Folder i repozitáře fungují dál.",
  recoveryCheckLabel: "Kontrola",
  recoveryReasonLabel: "Důvod",
  recoveryReasonFolderStateUnreadable:
    "Tahle verze nedokáže přečíst Folder nebo jeho stav: nepatří vašemu účtu, nebo obsahuje položky, klíče či schéma, které tahle verze nezná.",
  recoveryReasonFolderTransactionPending:
    "Změna profilu nebo nástrojů ve Folderu byla přerušena a není dokončená.",
  recoveryReasonFolderLockUnavailable: "Zámek operací Folderu nejde získat.",
  recoveryReasonHostedEntryInvalid:
    "Hostovaný vstup zaznamenaný ve Folderu tahle verze nepřijímá.",
  recoveryReasonAssetMissing:
    "Stránka, kterou tenhle program nese, se neservíruje celá.",
  recoveryReasonUnknown: "Důvod, který tahle stránka nezná.",
  recoveryLoading: "Kontroluji…",
  recoveryAgain: "Zkontrolovat znovu",
  recoveryLoadFailed:
    "Výsledek kontroly tady nejde načíst. Agent na tomhle Environmentu může spustit lazurio recover.",
  recoveryHealthy: "Lazurio na tomhle Environmentu je v pořádku.",
  recoveryBroken: "Lazurio na tomhle Environmentu potřebuje opravu.",
  recoveryNotInstalled:
    "Lazurio na tomhle Environmentu není nainstalované; není co kontrolovat.",
  recoveryChecksTitle: "Kontroly",
  recoveryOutcomeOk: "v pořádku",
  recoveryOutcomeFailed: "selhala",
  recoveryOutcomeSkipped: "přeskočena",
  recoveryEvidenceTitle: "Důkazy",
  recoveryEvidenceText:
    "Jen sanitizovaná strukturovaná pole, přesně jak je nese připravené issue.",
  recoveryJournalShow: "Zobrazit journal (zůstává na tomhle Environmentu)",
  recoveryJournalHide: "Skrýt journal",
  recoveryJournalText:
    "Sanitizovaný konec journalu Launchpadu. Nikdy automaticky neopouští tenhle Environment.",
  recoveryPromptTitle: "Opravný agent",
  recoveryPromptText:
    "Zkopírujte prompt a vložte ho do nového chatu své agentní aplikace na tomhle Environmentu (na Remote Environmentu do T3 Code). Agent opraví Lazurio směrem dopředu, nebo závadu zapíše na GitHub.",
  recoveryPromptCopy: "Zkopírovat prompt",
  recoveryPromptOpenT3: "Otevřít T3 Code",
  recoveryIssueTitle: "Připravené issue",
  recoveryIssueText:
    "Pro veřejný repozitář {repository}. Opravný agent ho založí, až ověří, že neexistuje duplicita.",
  recoveryIssueCopy: "Zkopírovat příkaz gh",
  recoveryIssueLink: "Otevřít předvyplněné issue v prohlížeči",
  recoveryIssueLinkPaste:
    "Otevřít formulář issue v prohlížeči (tělo vložte sami)",
  recoveryIssueRefused:
    "Tělo issue se nepřipravilo: po sanitizaci v něm zůstalo {kinds}. Nic nesmí tenhle Environment opustit automaticky.",
  recoveryNothingFiled:
    "Nic nebylo odesláno. Tahle stránka issue jen připraví; nic automaticky neopouští tenhle Environment.",
  settingsTitle: "Nastavení",
  settingsGeneral: "Obecné",
  settingsBack: "Zpět",
  settingsBreadcrumb: "Kde v nastavení jste",
  navigationOpen: "Otevřít navigaci",
  technicalDetails: "Technické podrobnosti",
  presetHint:
    "Druh Environmentu, pro který je tenhle Folder nastavený. Nabízejí se jen presety, které dovoluje jeho handover.",
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
  legend: "Profil Environmentu",
  machineTitle: "Tento Environment",
  machineNotice:
    "Zaznamenáno při předání tohohle Remote Environmentu; tady se jen zobrazuje, mění ho jen provozovatel, který ho hostuje.",
  machineWorkstation: "Pracovní stanice přihlášeného Operátora (bez handoveru)",
  machineKind: "Druh",
  machineName: "Název",
  machineOwner: "Owner",
  machineTeam: "Team",
  machineAssignment: "Přiřazení",
  machineAssignmentTeam: "sdílený Teamem",
  machineAssignmentAutomation:
    "automatizovaný Environment persony Organizace; odpovědný operátor {operator}",
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
  presetHostedOrganizationSteward: "Automatizovaný",
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
  filesTitle: "Soubory",
  filesIntro:
    "Složka Dokumenty tohoto Environmentu. Agenti sem ukládají hotové soubory; stáhněte si je, nebo sem nahrajte soubory pro agenty.",
  filesShared:
    "Tenhle Environment je sdílený: celý Team vidí a mění stejnou složku.",
  filesRoot: "Dokumenty",
  filesPath: "Cesta ke složce",
  filesUpload: "Nahrát soubory",
  filesZip: "Stáhnout složku (ZIP)",
  filesRefresh: "Načíst znovu",
  filesLoading: "Načítám složku…",
  filesLoadFailed: "Složku se nepodařilo načíst. Zkuste Načíst znovu.",
  filesUnavailable:
    "Složku Dokumenty tohoto Environmentu nejde použít: není to složka, nebo je to link na domovskou složku či Lazurio Folder. Na požádání to opraví agent.",
  filesEmpty: "Tahle složka je prázdná.",
  filesEmptyRoot:
    "Tohle je složka Dokumenty vašeho Environmentu. Agenti sem ukládají hotové soubory a dorazí sem i soubory, které nahrajete. Zatím tu nic není.",
  filesNotFound: "Tahle složka nebo soubor neexistuje.",
  filesOpenRoot: "Otevřít Dokumenty",
  filesIsFile: "{name} je soubor.",
  filesOpenFolder: "Otevřít jeho složku",
  filesName: "Název",
  filesSize: "Velikost",
  filesModified: "Změněno",
  filesFolder: "Složka",
  filesDownload: "Stáhnout",
  filesDownloadNamed: "Stáhnout {name}",
  filesDownloading: "Stahuji {name}…",
  filesDownloadFailed: "{name} se nepodařilo stáhnout.",
  filesDrop: "Pusťte soubory a nahrají se do složky {folder}",
  filesFoldersSkipped:
    "Složky nahrát nejde: nahrajte soubory z nich, nebo ZIP.",
  filesUploads: "Nahrávání",
  filesQueued: "Čeká",
  filesUploading: "Nahrávám, {percent}\u00a0%",
  filesUploaded: "Nahráno",
  filesUploadedAs: "Nahráno jako {name}",
  filesUploadedStatus: "{name}: nahráno.",
  filesUploadCancelled: "Zrušeno",
  filesCancel: "Zrušit",
  filesCancelNamed: "Zrušit nahrávání {name}",
  filesUploadDiskFull: "Na tomhle Environmentu není dost volného místa.",
  filesUploadIncomplete: "Nahrávání se přerušilo. Zkuste to znovu.",
  filesUploadName:
    "Tohle jméno tu použít nejde. Soubor přejmenujte a zkuste to znovu.",
  filesUploadMissing: "Složka už neexistuje.",
  filesUploadFailed: "Nahrání se nezdařilo. Zkuste to znovu.",
};
export function messages(
  locale: unknown,
): Readonly<Record<MessageKey, string>> {
  return locale === "cs" ? cs : en;
}
