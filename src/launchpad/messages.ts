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
  toolsSwitchLabel: "Used by agents",
  toolsSwitchNamed: "Used by agents: {name}",
  // One wording with the CLI and the server's rule (src/tools/team-github.ts).
  toolsTeamGithub: teamGithubText.en,
  toolsTeamGithubLogout: teamGithubLogoutText.en,
  toolsShared:
    "This is the whole Team's shared Environment. Sign in here with team accounts, such as a shared mailbox or calendar. Whatever you sign in here, anyone in the Team can use. Connect your personal accounts in your own Environment.",
  toolsRefresh: "Refresh status",
  toolsLoading: "Reading tools…",
  toolsLoadFailed:
    "The tools could not be read. Try Refresh status; if that does not help, ask an agent for help.",
  toolsChecked: "Checked at {time}",
  toolsTierRequired: "Required",
  toolsTierRequiredNote: "Nothing works here without them.",
  toolsTierRecommended: "Recommended",
  toolsTierRecommendedNote: "Useful to almost everyone.",
  toolsTierOptional: "Optional",
  toolsTierOptionalNote: "Turn on only what you use.",
  toolsInstalled: "Installed, version {version}",
  toolsInstalledNoVersion: "Installed, version unknown",
  toolsNotInstalled: "Not installed",
  toolsVersionError: "The version check failed: {error}.",
  toolsFixWithAgent: "Fix with an agent",
  toolsFixWithAgentNamed: "Fix {name} with an agent",
  toolsFixPromptHint:
    "Copy this prompt and paste it into a new chat in this Environment. The agent puts the tool where it belongs; nothing is reinstalled and your sign-in stays.",
  toolsFixPrompt:
    "Task: the tool `{command}` works in this Environment, but it does not run from the standard place `~/.local/bin/{command}`; it now runs from `{path}`. Straighten it: put only a link or wrapper to the working program into `~/.local/bin`, so that `{command}` runs from there. Reinstall nothing, change no version and leave the sign-in and settings alone. If it cannot be done without a change outside the home directory, change nothing and tell me why. Proof: `command -v {command}` prints `~/.local/bin/{command}` (expanded to the home directory), `{command} --version` answers with the same version as before, and `lazurio tools status --json` shows `standardPath: true` for it.",
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
  // What a row says after a change (Matěj 2026-10-09): plain words for
  // people who do not know the machinery underneath. The Folder, its
  // revision, a path or a command is said only under the tool's Details
  // (the `…Detail` texts, under "What happened").
  toolsEnabledDone: "Agents now use {name}.",
  toolsSwitchedOn: "Switched on.",
  toolsEnabledNotInstalled:
    "Once {name} is installed, agents will start using it.",
  toolsDisabledDone: "Agents no longer use {name}.",
  toolsNoteSaved: "Your note on {name} is saved.",
  toolsNoteCleared: "Your note on {name} is removed.",
  toolsUndone: "The change of {name} is undone.",
  toolsUndo: "Undo",
  toolsUndoNamed: "Undo the change of {name}",
  toolsUnchanged: "Nothing changed; it was already set this way.",
  toolsBlockedStale:
    "Nothing was saved; something changed here in the meantime. Reload and try again.",
  toolsBlockedDrift:
    "Nothing was saved: someone edited the agents' instructions here by hand. An agent can put them right.",
  toolsBlockedDriftDetail:
    "The file {path} was edited by hand, so Lazurio does not overwrite it. Keep your edit elsewhere, restore the file, then reload.",
  toolsBlockedIncomplete:
    "Nothing was saved: an earlier change did not finish. An agent can complete it.",
  toolsBlockedIncompleteDetail:
    "An earlier change of this Folder did not finish. Complete it with lazurio profile-resume in the CLI, then reload.",
  toolsBlockedOther:
    "Nothing was saved: this change cannot be made here right now. An agent can find out why.",
  toolsBlockedOtherDetail:
    "Lazurio refused the change with the reason {reason}.",
  toolsFailed:
    "Whether the change was saved could not be confirmed. Reload to see.",
  toolsFailedDetail:
    "The answer to the change was missing or could not be read. If the state still looks wrong after a reload, recovery through the CLI may be needed (lazurio recover).",
  toolsWhatHappened: "What happened",
  toolsReload: "Reload",
  toolsAgentAction: "Connect with an agent",
  toolsAgentActionNamed: "Connect {name} with an agent",
  toolsInstallAction: "Add and connect",
  toolsInstallOnlyAction: "Install",
  toolsSignInAction: "Connect",
  toolsSignedInAs: "Connected as {account}",
  toolsSignedInAsOrganization: "Connected as {account} ({organization})",
  toolsSignedIn: "Connected",
  toolsSignedOut: "Not connected",
  toolsSignInUnknown: "Connection unknown",
  toolsSignInUnchecked: "Connection not checked",
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
  toolsInstallActionNamed: "Add and connect {name}",
  toolsInstallOnlyNamed: "Install {name}",
  toolsSignInActionNamed: "Connect {name}",
  toolsSignOutAction: "Disconnect",
  toolsSignOutNamed: "Disconnect {name}",
  toolsSignedOutLocal:
    "{name}: signed out in this Environment. The provider still lists this sign-in until you revoke it in your account settings there.",
  toolsSignedOutRemote:
    "{name}: signed out; the linked device was removed from your account.",
  toolsSignOutFailed:
    "{name}: signing out did not finish. Refresh the status to see where it stands.",
  toolsSignOutFailedDetail: "Reason: {reason}.",
  toolsLoginTitleInstall: "Connect {name}",
  toolsLoginTitle: "Connect {name}",
  toolsLoginContinue: "Continue",
  toolsStepInstalling: "Installing",
  toolsStepWaiting: "Waiting for you",
  toolsStepSignedIn: "Connected",
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
    "The installation did not finish. Nothing that already worked was changed.",
  toolsInstallFailedDetail: "Step {stage}: {reason}.",
  toolsInstallUnsupported:
    "The installer built into Lazurio does not cover this Environment.",
  toolsInstallUnsupportedDetail: "System {platform}, architecture {arch}.",
  toolsInstallNotOnPath:
    "~/.local/bin is not on the PATH of this Launchpad, so agents may not find the tool until it is added to the shell profile.",
  toolsInstallBusy:
    "This tool is being installed already. Wait for it to finish, then refresh the status.",
  toolsFinishWithAgent: "Finish with an agent",
  toolsAgentFallback:
    "An agent can finish the setup by the written target state of this tool.",
  toolsLoginStarting: "Starting the connection…",
  toolsLoginStartingDetail: "It usually takes a few seconds.",
  toolsLoginGhText: "Copy the code and confirm it on GitHub.",
  toolsLoginGhLink: "Open GitHub",
  toolsLoginCodeLabel: "One-time code",
  toolsLoginComposioText: "Sign in to Composio in your browser.",
  toolsLoginComposioLink: "Open Composio",
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
  toolsLoginWaiting: "Waiting for your confirmation…",
  toolsLoginSignedIn: "{name} is connected.",
  toolsLoginSignedInAs: "Connected as {account}.",
  toolsLoginAlreadySignedIn: "{name} was already connected; nothing changed.",
  toolsLoginAlreadySignedInAs:
    "{name} was already connected as {account}; nothing changed.",
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
  toolsLoginLinking: "Connected. Linking the SSH key of this Environment…",
  toolsLoginRefreshText:
    "Your gh sign-in may not manage the SSH keys of your account yet. To allow it, open the GitHub device page on any device (this computer, another one or your phone) and enter this code:",
  toolsSshLinkedDone: "Connected as {account}.",
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
    "The SSH key of this Environment was removed from your GitHub account; the key files stay in this Environment.",
  toolsSshRemovalNotRegistered:
    "The SSH key of this Environment was not registered on your GitHub account.",
  toolsSshRemovalNoKey:
    "This Environment has no SSH key; nothing was removed from GitHub.",
  toolsSshRemovalKept:
    "The SSH key of this Environment stays registered on your GitHub account because Lazurio did not register it. Remove it under GitHub Settings, SSH and GPG keys (github.com/settings/keys), if this Environment must lose access.",
  toolsSshKeyFingerprint: "Key fingerprint: {fingerprint}.",
  toolsSshRemovalFailed:
    "The SSH key of this Environment may still be registered on your GitHub account: gh could not remove it. Remove it under GitHub Settings, SSH and GPG keys (github.com/settings/keys), if this Environment must lose access.",
  toolsComposioOrgLabel: "Organization in Composio",
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
  toolsPromptTitle: "Connect {name} with an agent",
  toolsPromptHint:
    "Copy this prompt and paste it into a new chat in T3 Code in this Environment. The agent installs the tool and guides you through the sign-in in your browser. You never copy an API key.",
  toolsPromptLabel: "Prepared prompt",
  toolsCopy: "Copy prompt",
  toolsCopied: "Copied.",
  toolsCopyFailed:
    "Copying is not available here. The text is selected; copy it with the keyboard.",
  toolsClose: "Close",
  toolsMcpTitle: "A custom MCP server",
  toolsMcpText:
    "You add custom MCP servers in Apps → Integrations → Custom; an agent adds one on your explicit request.",
  toolsMcpAction: "Add one with an agent",
  toolsMcpPromptHint:
    "Copy this prompt and paste it into a new chat in T3 Code in this Environment. The agent asks which server you want and adds it to this Environment's Executor; a key you enter yourself in Integrations.",
  // The Apps home and its left column (decision F36).
  appsTitle: "Apps",
  appsAll: "All modules",
  appsPersonal: "Personal",
  appsOrganizationDashboard: "Organization Dashboard",
  appsModulesOne: "{count} module",
  appsModulesFew: "{count} modules",
  appsModulesMany: "{count} modules",
  appsRepositoriesOne: "{count} repository",
  appsRepositoriesFew: "{count} repositories",
  appsRepositoriesMany: "{count} repositories",
  appsOpenApp: "Open app",
  appsOpenAppNamed: "Open the app of {name} in a new tab",
  appsOpenAppNamedSame: "Open the app of {name}",
  appsNoApp: "No app",
  appsAbout: "About the module",
  appsLog: "App log",
  appsLogHint:
    "The Launchpad does not show the log yet. Its last lines are read on the command line of this Environment:",
  appsStarting: "Starting {name}…",
  appsStartFailed: "{name} could not be opened. Its overview says why.",
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
  // The Apps home and column of the Organization rail (decision F36
  // addendum of 2026-10-04): the wireframe's words.
  appsSayNoApp: "The module {name} has no app yet.",
  appsSayCannotStart: "The app of the module {name} cannot start right now.",
  appsSayRepository: "The repository {name} has no app.",
  appsMore: "More options for {name}",
  appsFavorites: "Favourites",
  appsFavoritesLoading: "Loading favourites…",
  appsFavoritesHint: "Star a module to pin it here.",
  appsFavoriteAdd: "Add to favourites",
  appsFavoriteRemove: "Remove from favourites",
  appsFavoriteMark: "In favourites",
  appsFavoriteFailed: "The favourite could not be saved. Try again.",
  appsModuleAccess: "Module access",
  appsInfoModule: "Module information",
  appsInfoRepository: "Repository information",
  appsNewModule: "New module",
  appsNewModuleSub: "You found it with an agent in Chat",
  appsNewModuleOpened:
    "Chat opens in a new tab with the new module's brief in the composer, not sent.",
  appsNewModuleCopied:
    "The new module's brief is in your clipboard: paste it into a new chat.",
  appsNewModuleCopyFailed:
    "The brief could not be copied; open Chat and describe the new module to the agent.",
  appsNewModulePrompt:
    "I want to found a new module in the Organization {name} (GitHub {login}).\n\nBefore you create anything, ask me one question at a time:\n1. What the module is for and who will use it.\n2. What it should be called (a name and a short slug).\n3. Whether it should have an app and which (vite-react, astro, astro-starlight, bun-service, python-uv), or none.\n4. Which Teams should have access to it.\n\nThen follow the Lazurio Module Standard (skill lazurio-module-standard):\n- found the module with the scaffold `lazurio module create {login}/<slug> --stack <stack> --teams <teams>` from a task worktree of the Organization's root, never by hand, and first show me the plan with --dry-run;\n- check that the module's repository exists on GitHub in the Organization {login} and that the chosen Teams have access to it;\n- prepare the result as a pull request and ask me before Publication.",
  appsGuide: "Guide",
  appsMarketplace: "Marketplace",
  appsSoon: "coming soon",
  appsMarketplaceSoon: "Coming soon",
  appsMarketplaceText:
    "This is where you will add more modules to the Environment. We are preparing it.",
  appsMarketplaceOrganization:
    " Until then, modules are added in the Dashboard of the Organization {name}.",
  title: "Lazurio Launchpad",
  homeTitle: "Launchpad",
  catalogBreadcrumb: "Where you are in the Launchpad",
  catalogLoading: "Reading Organizations…",
  catalogLoadFailed:
    "The Organizations could not be read. Try Refresh; if it keeps failing, run lazurio organization list in the CLI.",
  catalogEmpty: "There are no apps in this Environment yet.",
  catalogNotFound:
    "This Organization or module is not in this Folder. It may have been renamed or removed; see all Organizations.",
  chat: "Chat",
  mausbot: "Lazurio MausBot",
  catalogModules: "Modules",
  catalogNoModules:
    "You have no modules here yet. Ask the Organization's Admin for access.",
  catalogPersonalspaceEmpty: "Your personal space is empty for now.",
  catalogSectionWorkspace: "Workspace",
  catalogSectionProductionspace: "Productionspace",
  catalogCheckedOut: "Checked out",
  catalogNotCheckedOut: "Not checked out",
  catalogOrganization: "Organization",
  catalogDirectory: "Directory",
  catalogState: "Resolution state",
  catalogIssues: "Issues",
  catalogApps: "Apps",
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
  preparationReasonLockfileUnused:
    "{file} lies beside a package that declares nothing to install: such a package needs no lockfile and Bun keeps none for it, so this one is left over. Remove it from the module, or declare the dependencies it locks.",
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
  moduleOpenNamedSame: "Open {name}",
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
  machineKind: "Kind",
  machineName: "Technical name",
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
  // The first run of an Environment (root decision 0188): the line until it
  // is usable, the tour, "Obsah Environmentu" and its prompt for Chat.
  setupGithub: "GitHub is not connected. Nothing works here without it.",
  setupGithubAction: "Connect GitHub",
  setupOrganizationMissing: "{name} is not here yet.",
  setupPersonalMissing: "Your personal space is not here yet.",
  setupDownload: "Download",
  setupPrepare: "Prepare",
  setupFailed: "The preparation stopped.",
  setupResolve: "Solve in Chat",
  setupRetry: "Try again",
  tourLabel: "Tour of this Environment",
  tourGearTitle: "First connect GitHub",
  tourGearText: "Nothing works here without it.",
  tourSettingsToolsTitle: "Services are connected here",
  tourGithubTitle: "Connect GitHub",
  tourGithubText: "See your modules; agents work for you.",
  tourComposioTitle: "Connect your apps",
  tourComposioText: "Mail, calendar, Slack. Later is fine too.",
  tourGearPersonalTitle: "Now prepare your personal space",
  tourPersonalText: "A place for your own things.",
  tourGearOrganizationTitle: "Now download {name}",
  tourOrganizationText: "Then you will see its modules here.",
  tourOrganization: "the Organization",
  tourSettingsEnvironmentTitle: "The Environment's content is here",
  tourPrepareFailedTitle: "Something went wrong",
  tourPrepareFailedText: "Try again, or an agent in Chat fixes it.",
  tourPreparePersonalTitle: "Prepare your personal space",
  tourPrepareOrganizationTitle: "Download {name}",
  tourAppsTitle: "Apps",
  tourAppsText: "Open your modules' apps here.",
  tourChatTitle: "Chat",
  tourChatText: "Give agents work here.",
  tourChatMissingText: "Work for agents. Not running here yet.",
  tourAutomateTitle: "Automate",
  tourAutomateText: "Set up what happens on its own here.",
  tourAutomateMissingText: "What happens on its own. Not running here yet.",
  tourSettingsTitle: "Settings are always here",
  tourNext: "Next",
  tourDone: "Done",
  tourNotNow: "Not now",
  tourQuit: "End",
  contentTitle: "Content of this Environment",
  contentPersonalspace: "Personal space",
  contentAbsent: "Not here yet",
  contentPresent: "Ready",
  contentRunning: "Downloading…",
  contentWaiting: "Next in line",
  contentStopped: "Stopped",
  contentBlocked: "Cannot be prepared now",
  contentDownloadAll: "Download all",
  contentNeedsGithub: "Connect GitHub in Tools first.",
  contentNotAllowed: "This Environment cannot prepare its content.",
  contentRefused: "This Environment may not prepare it.",
  contentStartFailed: "The preparation could not start. Try again.",
  contentLost: "The progress of the preparation could not be read.",
  contentAgentFixes: "An agent in Chat will fix it.",
  contentDetails: "Details",
  contentStepAccess: "Checking access",
  contentStepRoot: "Downloading the Organization",
  contentStepModules: "Downloading modules",
  contentStepPreparation: "Installing",
  contentStepCheck: "Checking",
  contentStepFind: "Looking for your personal space",
  contentStepCreate: "Creating",
  contentStepClone: "Downloading",
  contentStepOther: "Preparing",
  contentFailedAccess: "Access to the Organization could not be verified.",
  contentFailedRoot: "The Organization could not be downloaded.",
  contentFailedModules: "The modules could not be downloaded.",
  contentFailedPreparation: "The modules could not be installed.",
  contentFailedCheck: "The check after the preparation did not pass.",
  contentFailedFind: "Your personal space could not be found.",
  contentFailedCreate: "Your personal space could not be created.",
  contentFailedClone: "Your personal space could not be downloaded.",
  contentFailedOther: "The preparation did not finish.",
  contentResolveOpened:
    "Chat opens in a new tab with the brief in the composer, not sent.",
  contentResolveCopied:
    "The brief is in your clipboard: paste it into a new chat.",
  contentResolveCopyFailed:
    "The brief could not be copied; open Chat and tell the agent what stopped.",
  preparePromptWhatPersonal:
    "The preparation of my personal space (Personalspace) in this Environment",
  preparePromptWhatOrganization:
    "The preparation of the Organization {name} (GitHub {login}) in this Environment",
  preparePromptStoppedAt: "{what} stopped at the step “{step}”:",
  preparePromptStopped: "{what} stopped.",
  preparePromptBody:
    "Please finish the installation completely:\n1. Find the cause of the error and fix it in this Environment.\n2. Finish the preparation with the same command the Launchpad runs: `{command}`.\n3. Verify the result: `lazurio doctor`, and the tests of the modules that have them.\n4. Tell me briefly what was wrong, what you did and what you verified. If the fix needs a change outside this Environment (in a repository, for example), ask me first.",
  toolsDescriptionGh:
    "The connection to GitHub, where your modules are kept. Nothing works here without it.",
  toolsDescriptionComposio:
    "An easy way to many apps through Composio, with your own account. You connect the apps in Apps → Integrations.",
  toolsDescriptionWacli:
    "The connection to WhatsApp: agents read and send your messages.",
  toolsDescriptionGogcli:
    "The connection to Google: Gmail, Calendar and Drive, when you do not want Composio.",
  toolsDescriptionNeon:
    "The connection to Neon databases, mainly for developing apps.",
  toolsDescriptionBitwarden:
    "Passwords and access you share with this Environment in your Vaultwarden vault.",
  toolsDescriptionExecutor:
    "Agents use the apps connected directly from this Environment through it. Lazurio installs it and keeps it running.",
  toolsNotOffered: "Not offered in this Environment; agents do not use it.",
  vaultRowChecking: "Checking…",
  vaultRowNone: "Not connected",
  vaultRowConfirming: "Waiting for the confirmation in the vault",
  vaultRowConnected: "Connected",
  vaultRowRevoked: "Access removed in the vault",
  vaultRowUnreachable: "The vault does not answer",
  vaultRowSecondWave: "Soon · second wave",
  vaultRowUnavailable: "Not available in this Environment",
  vaultActionConnect: "Connect",
  vaultActionContinue: "Continue",
  vaultActionReconnect: "Connect again",
  vaultActionRetry: "Try again",
  vaultActionDisconnect: "Disconnect",
  vaultActionNamed: "{action}: bitwarden",
  vaultOpen: "Open Vaultwarden",
  vaultSync: "Synchronize",
  vaultTitle: "Connect Bitwarden",
  vaultStepInvite: "Invite the account in the vault",
  vaultStepConnect: "The Environment connects",
  vaultStepConfirm: "Confirm the account in the vault",
  vaultStepDone: "Connected",
  vaultInviteText:
    "Create the collection and invite this address into it with edit rights.",
  vaultInviteAgainText:
    "Invite this address into the collection again with edit rights.",
  vaultAdminHint:
    "Only an Admin or Owner of the vault's organization can invite and confirm.",
  vaultTeamHint: "The whole Team sees the collection.",
  vaultCollectionLabel: "Collection",
  vaultAccountLabel: "Account address",
  vaultCopy: "Copy",
  vaultCopyNamed: "Copy: {label}",
  vaultCopied: "Copied",
  vaultInvited: "Invited",
  vaultNotInvited: "The address is not invited in the vault yet.",
  vaultUnreachableLine: "The vault does not answer.",
  vaultPhaseInstall: "Installing Bitwarden",
  vaultPhaseAccount: "Creating the account",
  vaultPhaseSignIn: "Signing in",
  vaultPasswordHint: "Only this Environment knows the account's password.",
  vaultConfirmText: "Confirm the new member in the vault.",
  vaultFingerprintHint: "The fingerprint in the vault must be the same:",
  vaultWaiting: "Waiting for the confirmation…",
  vaultNoCollection:
    "Confirmed, but it does not see the collection {collection} yet.",
  vaultSees: "It sees {seen}.",
  vaultFailed: "Connecting did not finish ({stage}: {reason}).",
  vaultDisconnectTitle: "Disconnect Bitwarden",
  vaultDisconnectText:
    "Agents here stop using the vault. You end the access completely by removing the account in the vault.",
  vaultDisconnected:
    "Disconnected. The account stays in the vault; Connect signs it in again.",
  vaultCancel: "Cancel",
  vaultDetails: "Vault",
  vaultDetailAccount: "Account",
  vaultDetailVault: "Vault",
  vaultDetailOrganization: "Organization",
  vaultDetailCollection: "Collection",
  vaultDetailFingerprint: "Fingerprint",
  vaultCollectionsOne: "{count} collection",
  vaultCollectionsFew: "{count} collections",
  vaultCollectionsMany: "{count} collections",
  vaultItemsOne: "{count} item",
  vaultItemsFew: "{count} items",
  vaultItemsMany: "{count} items",
  vaultLoadFailed: "The vault's state could not be read.",
  executorRowChecking: "Checking…",
  executorRowRunning: "Running",
  executorRowNotInstalled: "Not installed",
  executorRowOutdated: "Waiting for an update",
  executorRowNotRunning: "Not running",
  executorRowIncomplete: "Running, setup not finished",
  executorRowConflict: "Conflicts with another installation",
  executorRowSecondWave: "Soon · second wave",
  executorRowUnavailable: "Not available in this Environment",
  executorPhaseInstall: "Installing…",
  executorPhaseService: "Starting…",
  executorPhaseAgents: "Connecting the agents…",
  executorActionInstall: "Install",
  executorActionUpdate: "Update",
  executorActionRepair: "Repair",
  executorActionResolve: "Resolve with an agent",
  executorActionNamed: "{action}: executor",
  executorLoadFailed: "Executor's state could not be read.",
  executorDetails: "Executor",
  executorDetailVersion: "Version",
  executorDetailAddress: "Address",
  executorDetailService: "Service",
  executorDetailAgents: "Agents",
  executorVersionPinned: "{version} is installed by the next setup",
  executorVersionOther: "{installed} (Lazurio pins {version})",
  executorAddressLocal: "{address} (this Environment only)",
  executorServiceRunning: "running",
  executorServiceStopped: "stopped",
  executorServiceFailed: "failed",
  executorServiceMissing: "not installed",
  executorServiceOther: "runs another installation",
  executorServiceUnknown: "cannot be read",
  executorAgentConnected: "connected",
  executorAgentDisabled: "switched off in its settings",
  executorAgentMissing: "not connected yet",
  executorAgentConflict: "has another server named executor",
  executorAgentAbsent: "not installed",
  executorAgentUnknown: "cannot be read",
  executorNewChats:
    "Agents see it in new chats; running chats keep going without it.",
  executorFailed: "The setup did not finish ({stage}: {reason}).",
  executorConflictTitle: "Resolve the conflict of executor with an agent",
  executorConflictPrompt:
    "Task: in this Environment, Lazurio's Executor conflicts with another installation. Find out with `lazurio executor status --json` what conflicts: `entry` is `~/.local/bin/executor`, `agents` an MCP server named `executor` in Codex or Claude Code. Show the Operator what is there, and only with their consent remove or rename it; then run `lazurio executor setup --json` and check that it reports `running`. Change nothing else.",
  toolsNotAdded: "Not added yet",
  toolsLoginTitleGh: "Connect GitHub",
  toolsLoginTitleComposio: "Connect your apps",
  toolsLoginCopyCode: "Copy",
  toolsLoginCodeCopied: "Copied",
  toolsLoginGhHint: "Valid for 15 minutes, from your phone too.",
  toolsLoginDone: "Done",
  toolsInstallLabel: "Installation",
  machineBelongs: "Belongs to",
  machineBelongsYou: "you (@{login})",
  machineWorks: "Who works in it",
  machineWorksOnlyYou: "only you",
  machineWorksTeam: "Team {team}",
  machineWorksAutomation: "automation, @{login} is responsible",
  machineKindPersonal: "Personal Remote Environment",
  machineKindWork: "Work Remote Environment",
  machineKindTeam: "Team Remote Environment",
  machineKindAutomated: "Automated Environment",
  machineKindWorkstation: "Your computer",
  machineTechnicalKind: "Technical kind",
  machineSupport: "For support",
  browserToggle: "Browser",
  browserTitle: "Environment browser",
  browserReload: "Reload",
  browserOpenTab: "Open in a new tab",
  browserClose: "Close",
  browserFrame: "Windows of the Environment browser",
  browserLoading: "Opening the Environment browser…",
  browserUnavailable:
    "The Environment browser is not available right now; try to reload it in a moment.",
  browserFailed:
    "The Environment browser could not be loaded here; open it in a new tab, where you can sign in again.",
  integrationsTitle: "Integrations",
  integrationsSubtitle:
    "Every agent and bot of this Environment uses what you connect here.",
  integrationsHelp: "How it works",
  integrationsSearch: "Search apps",
  integrationsRefresh: "Check connections",
  integrationsTabsLabel: "Show",
  integrationsTabAll: "All",
  integrationsTabConnected: "Connected",
  integrationsTabCustom: "Custom",
  integrationsAvailable: "Available apps · {count}",
  integrationsYours: "Your connections",
  integrationsResults: "Search results",
  integrationsLoading: "Reading Integrations…",
  integrationsChecking: "Checking connections…",
  integrationsLoadFailed: "Integrations could not be read.",
  integrationsNoneConnected: "No connected apps yet.",
  integrationsPick: "Choose an app",
  integrationsNoneFound: "No apps found.",
  integrationsShowAll: "Show all {count} apps",
  integrationsPopupBlocked:
    "The browser blocked the connection window. Allow pop-ups and try again.",
  integrationsExecutorUnavailable:
    "Executor does not run in this Environment now, so nothing connects directly.",
  integrationsExecutorAbsent:
    "This Environment has no Executor, so apps connect here through Composio or their tool.",
  integrationsExecutorUnreadable:
    "Executor answered unexpectedly; the direct connections could not be read.",
  integrationsComposioUnreadable:
    "The connections through Composio could not be read.",
  integrationsToolsUnreadable: "The tools could not be read.",
  integrationsRetry: "Try again",
  integrationsConnect: "Connect",
  integrationsAddAccount: "Add account",
  integrationsConnected: "Connected",
  integrationsPathDirect: "directly",
  integrationsPathComposio: "through Composio",
  integrationsPathTool: "through {tool}",
  integrationsComposioNote:
    "Composio, a third-party service, makes this connection.",
  integrationsAccountName: "Account name (optional)",
  integrationsAccountNameRequired: "Account name",
  integrationsAccountNameHint:
    "Another account of this app needs a name of its own.",
  integrationsContinue: "Continue",
  integrationsCancel: "Cancel",
  integrationsFinishInBrowser: "Finish the connection in the browser",
  integrationsFinishInEnvironment:
    "Finish the sign-in in the Environment browser on the right.",
  integrationsWaiting: "Waiting for the sign-in…",
  integrationsConnectedNow: "{app} is connected.",
  integrationsConnectFailed: "The connection could not be started.",
  integrationsIntegrationConflict:
    "Executor holds another server under this app's name. You find it in Custom: remove it there and connect the app again.",
  integrationsConnectEnded: "The connection was not finished.",
  integrationsNameTaken: "This name is used by another account of the app.",
  integrationsAccountUnnamed: "account",
  integrationsAccountExpired: "The sign-in expired — try again",
  integrationsAccountPending:
    "Finish the connection in the browser, or disconnect the account",
  integrationsAccountFailed: "The connection failed — try again",
  integrationsAccountSpareDirect: "Also directly, not used",
  integrationsAccountSpareComposio: "Also through Composio, not used",
  integrationsSignInAgain: "Sign in again",
  integrationsDisconnect: "Disconnect",
  integrationsDisconnectTitle: "Disconnect {account} from {app}?",
  integrationsDisconnectDirect: "It disconnects in this Environment only.",
  integrationsDisconnectComposio:
    "It disconnects from the Composio account {account}, so in every Environment that uses it.",
  integrationsDisconnectComposioAny:
    "It disconnects from the Composio account, so in every Environment that uses it.",
  integrationsDisconnectPending:
    "Only this account is withdrawn; the other accounts of {app} stay connected.",
  integrationsDisconnectUnsupported:
    "Composio cannot disconnect from here yet: disconnect the account in Composio.",
  integrationsDisconnectFailed: "The account could not be disconnected.",
  integrationsOpenComposio: "Open Composio",
  integrationsMissingPath: "It cannot be connected here yet.",
  integrationsMissingTool: "The tool {tool} connects it.",
  integrationsOpenTools: "Open Tools",
  integrationsMissingCompanyApp:
    "The company app {provider} is not set up yet.",
  integrationsComposioOffOrganization: "Composio is off in the company.",
  integrationsComposioOffHere: "Composio is off here.",
  integrationsAskAdmin: "Ask the Admin",
  integrationsAskAdminCopied: "A message for the Admin is in your clipboard.",
  integrationsAskAdminText:
    "Please make {app} available in the Integrations of our Environments: {line}",
  integrationsSetUpInDashboard: "Set up in the Dashboard",
  integrationsAllowComposio: "Allow Composio",
  integrationsComposioSignIn:
    "Sign in to Composio first: it opens in Settings → Tools.",
  integrationsBrowserMissing:
    "A direct sign-in needs this Environment's browser, which is not available here.",
  integrationsKeyTitle: "Key for {app}",
  integrationsKeyText:
    "The key goes only to this Environment's Executor and is never shown again.",
  integrationsKeyLabel: "Key",
  integrationsMcpTitle: "MCP servers",
  integrationsMcpAdd: "Add MCP server",
  integrationsMcpCommand: "A command in this Environment",
  integrationsMcpUrl: "A server at a URL",
  integrationsMcpKind: "Server",
  integrationsMcpName: "Name",
  integrationsMcpCommandLine: "Command with arguments",
  integrationsMcpAddress: "URL",
  integrationsMcpVariable: "Variable (optional)",
  integrationsMcpHeader: "Header (optional)",
  integrationsMcpValue: "Value",
  integrationsMcpSubmit: "Add",
  integrationsMcpNone: "No MCP servers yet.",
  integrationsMcpWhereCommand: "A command in this Environment",
  integrationsMcpReady: "Added",
  integrationsMcpTools: "Connected · {tools}",
  integrationsMcpPending: "Starting…",
  integrationsMcpFailed: "Could not start",
  integrationsMcpRemove: "Remove",
  integrationsMcpRemoveTitle: "Remove the MCP server “{name}”?",
  integrationsMcpRemoveText: "Agents and bots lose its tools.",
  integrationsMcpAddFailed: "The MCP server could not be added.",
  integrationsMcpNameTaken: "An integration of this name exists already.",
  integrationsMcpUnavailable:
    "Executor does not run here now, so MCP servers cannot be added.",
  integrationsToolsOne: "{count} tool",
  integrationsToolsFew: "{count} tools",
  integrationsToolsMany: "{count} tools",
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
  toolsSwitchLabel: "Používají agenti",
  toolsSwitchNamed: "Používají agenti: {name}",
  toolsTeamGithub: teamGithubText.cs,
  toolsTeamGithubLogout: teamGithubLogoutText.cs,
  toolsShared:
    "Tohle je společný Environment celého Teamu. Přihlašujte se tu týmovými účty, třeba společnou schránkou nebo kalendářem. Co tu přihlásíte, může používat každý z Teamu. Svoje osobní účty propojujte ve svém vlastním Environmentu.",
  toolsRefresh: "Obnovit stav",
  toolsLoading: "Načítají se nástroje…",
  toolsLoadFailed:
    "Nástroje se nepodařilo načíst. Zkuste Obnovit stav; když to nepomůže, požádejte o pomoc agenta.",
  toolsChecked: "Zjištěno v {time}",
  toolsTierRequired: "Povinné",
  toolsTierRequiredNote: "Bez nich tu nic nefunguje.",
  toolsTierRecommended: "Doporučené",
  toolsTierRecommendedNote: "Hodí se skoro každému.",
  toolsTierOptional: "Volitelné",
  toolsTierOptionalNote: "Zapni jen to, co používáš.",
  toolsInstalled: "Nainstalováno, verze {version}",
  toolsInstalledNoVersion: "Nainstalováno, verze neznámá",
  toolsNotInstalled: "Není nainstalováno",
  toolsVersionError: "Zjištění verze selhalo: {error}.",
  toolsFixWithAgent: "Opravit s agentem",
  toolsFixWithAgentNamed: "Opravit {name} s agentem",
  toolsFixPromptHint:
    "Zkopírujte tenhle prompt a vložte ho do nového chatu na tomhle Environmentu. Agent nástroj srovná na jeho místo; nic se nepřeinstaluje a přihlášení zůstane.",
  toolsFixPrompt:
    "Úkol: nástroj `{command}` na tomhle Environmentu funguje, ale nespouští se ze standardního místa `~/.local/bin/{command}`; teď se spouští z `{path}`. Srovnej to: do `~/.local/bin` dej jen link nebo wrapper na fungující program, aby se `{command}` spouštěl odtud. Nic nepřeinstalovávej, neměň verzi a nesahej na přihlášení ani nastavení. Když to bez změny mimo domovský adresář nejde, nic neměň a řekni mi proč. Důkaz: `command -v {command}` vypíše `~/.local/bin/{command}` (rozbalené na domovský adresář), `{command} --version` odpoví stejnou verzí jako předtím a `lazurio tools status --json` u něj ukáže `standardPath: true`.",
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
  toolsEnabledDone: "{name} teď používají agenti.",
  toolsSwitchedOn: "Zapnuto.",
  toolsEnabledNotInstalled:
    "Až se {name} nainstaluje, agenti ho začnou používat.",
  toolsDisabledDone: "{name} už agenti nepoužívají.",
  toolsNoteSaved: "Vaše poznámka k {name} je uložená.",
  toolsNoteCleared: "Vaše poznámka k {name} je odebraná.",
  toolsUndone: "Změna u {name} je vrácená.",
  toolsUndo: "Vrátit zpět",
  toolsUndoNamed: "Vrátit zpět změnu u {name}",
  toolsUnchanged: "Nic se nezměnilo, takhle už to nastavené bylo.",
  toolsBlockedStale:
    "Nic se neuložilo, mezitím se tu něco změnilo. Načtěte znovu a zkuste to ještě jednou.",
  toolsBlockedDrift:
    "Nic se neuložilo: pokyny pro agenty tu někdo upravil ručně. Srovnat je může agent.",
  toolsBlockedDriftDetail:
    "Soubor {path} byl upraven ručně, proto ho Lazurio nepřepíše. Úpravu si uložte jinam, soubor vraťte do původní podoby a načtěte znovu.",
  toolsBlockedIncomplete:
    "Nic se neuložilo: předchozí změna se nedokončila. Dokončit ji může agent.",
  toolsBlockedIncompleteDetail:
    "Dřívější změna tohohle Folderu nedoběhla. Dokončete ji v CLI příkazem lazurio profile-resume a načtěte znovu.",
  toolsBlockedOther:
    "Nic se neuložilo: tuhle změnu tu teď nejde udělat. Důvod zjistí agent.",
  toolsBlockedOtherDetail: "Lazurio změnu odmítlo s důvodem {reason}.",
  toolsFailed: "Nepodařilo se ověřit, jestli se změna uložila. Načtěte znovu.",
  toolsFailedDetail:
    "Odpověď na změnu chyběla nebo se nedala přečíst. Když stav ani po načtení nesedí, může být nutná obnova přes CLI (lazurio recover).",
  toolsWhatHappened: "Co se stalo",
  toolsReload: "Načíst znovu",
  toolsAgentAction: "Připojit s pomocí agenta",
  toolsAgentActionNamed: "Připojit {name} s pomocí agenta",
  toolsInstallAction: "Přidat a připojit",
  toolsInstallOnlyAction: "Nainstalovat",
  toolsSignInAction: "Připojit",
  toolsSignedInAs: "Připojeno jako {account}",
  toolsSignedInAsOrganization: "Připojeno jako {account} ({organization})",
  toolsSignedIn: "Připojeno",
  toolsSignedOut: "Nepřipojeno",
  toolsSignInUnknown: "Připojení nezjištěno",
  toolsSignInUnchecked: "Připojení se nezjišťovalo",
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
  toolsInstallActionNamed: "Přidat a připojit {name}",
  toolsInstallOnlyNamed: "Nainstalovat {name}",
  toolsSignInActionNamed: "Připojit {name}",
  toolsSignOutAction: "Odpojit",
  toolsSignOutNamed: "Odpojit {name}",
  toolsSignedOutLocal:
    "{name}: odhlášeno na tomhle Environmentu. Poskytovatel přihlášení eviduje, dokud ho nezrušíte v nastavení účtu u něj.",
  toolsSignedOutRemote:
    "{name}: odhlášeno; propojené zařízení bylo z účtu odebráno.",
  toolsSignOutFailed:
    "{name}: odhlášení nedoběhlo. Obnovte stav a uvidíte, jak to je.",
  toolsSignOutFailedDetail: "Důvod: {reason}.",
  toolsLoginTitleInstall: "Připojit {name}",
  toolsLoginTitle: "Připojit {name}",
  toolsLoginContinue: "Pokračovat",
  toolsStepInstalling: "Instalace",
  toolsStepWaiting: "Čeká se na tebe",
  toolsStepSignedIn: "Připojeno",
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
    "Instalace nedoběhla. Nic, co už fungovalo, se nezměnilo.",
  toolsInstallFailedDetail: "Krok {stage}: {reason}.",
  toolsInstallUnsupported:
    "Instalátor zabudovaný v Lazuriu tenhle Environment nepokrývá.",
  toolsInstallUnsupportedDetail: "Systém {platform}, architektura {arch}.",
  toolsInstallNotOnPath:
    "~/.local/bin není na PATH tohoto Launchpadu, takže ho agenti nemusí najít, dokud se nepřidá do profilu shellu.",
  toolsInstallBusy:
    "Tenhle nástroj se už instaluje. Počkejte, až instalace skončí, a obnovte stav.",
  toolsFinishWithAgent: "Dokončit s agentem",
  toolsAgentFallback:
    "Nastavení může dokončit agent podle sepsaného cílového stavu tohoto nástroje.",
  toolsLoginStarting: "Spouštím připojení…",
  toolsLoginStartingDetail: "Obvykle to trvá pár sekund.",
  toolsLoginGhText: "Zkopíruj kód a potvrď ho na GitHubu.",
  toolsLoginGhLink: "Otevřít GitHub",
  toolsLoginCodeLabel: "Jednorázový kód",
  toolsLoginComposioText: "Přihlas se do Composia v prohlížeči.",
  toolsLoginComposioLink: "Otevřít Composio",
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
  toolsLoginWaiting: "Čekám na potvrzení…",
  toolsLoginSignedIn: "{name} je připojený.",
  toolsLoginSignedInAs: "Připojeno jako {account}.",
  toolsLoginAlreadySignedIn: "{name} už byl připojený; nic se neměnilo.",
  toolsLoginAlreadySignedInAs:
    "{name} už byl připojený jako {account}; nic se neměnilo.",
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
  toolsLoginLinking: "Připojeno. Propojuji SSH klíč tohoto Environmentu…",
  toolsLoginRefreshText:
    "Vaše přihlášení gh zatím nesmí spravovat SSH klíče vašeho účtu. Abyste to povolili, otevřete na libovolném zařízení (tomhle počítači, jiném nebo telefonu) stránku zařízení GitHubu a zadejte tento kód:",
  toolsSshLinkedDone: "Připojeno jako {account}.",
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
    "SSH klíč tohohle Environmentu byl z vašeho účtu GitHubu odebrán; soubory klíče na tomhle Environmentu zůstávají.",
  toolsSshRemovalNotRegistered:
    "SSH klíč tohohle Environmentu u vašeho účtu GitHubu registrovaný nebyl.",
  toolsSshRemovalNoKey:
    "Tenhle Environment nemá žádný SSH klíč; z GitHubu se nic neodebralo.",
  toolsSshRemovalKept:
    "SSH klíč tohohle Environmentu zůstává registrovaný u vašeho účtu GitHubu, protože ho neregistrovalo Lazurio. Odeberte ho v Nastavení GitHubu, SSH and GPG keys (github.com/settings/keys), pokud má tenhle Environment přístup ztratit.",
  toolsSshKeyFingerprint: "Otisk klíče: {fingerprint}.",
  toolsSshRemovalFailed:
    "SSH klíč tohohle Environmentu může být u vašeho účtu GitHubu pořád registrovaný: gh ho nedokázal odebrat. Odeberte ho v Nastavení GitHubu, SSH and GPG keys (github.com/settings/keys), pokud má tenhle Environment přístup ztratit.",
  toolsComposioOrgLabel: "Organizace v Composiu",
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
  toolsPromptTitle: "Připojit {name} s pomocí agenta",
  toolsPromptHint:
    "Zkopírujte tenhle prompt a vložte ho do nového chatu v T3 Code na tomhle Environmentu. Agent nástroj nainstaluje a provede vás přihlášením v prohlížeči. Žádný API klíč nikdy nekopírujete.",
  toolsPromptLabel: "Připravený prompt",
  toolsCopy: "Zkopírovat prompt",
  toolsCopied: "Zkopírováno.",
  toolsCopyFailed:
    "Kopírování tady není dostupné. Text je označený; zkopírujte ho klávesnicí.",
  toolsClose: "Zavřít",
  toolsMcpTitle: "Vlastní MCP server",
  toolsMcpText:
    "Vlastní MCP servery přidáš v Apps → Integrace → Vlastní; agent ho přidá na tvůj výslovný pokyn.",
  toolsMcpAction: "Přidat s agentem",
  toolsMcpPromptHint:
    "Zkopírujte tenhle prompt a vložte ho do nového chatu v T3 Code na tomhle Environmentu. Agent se zeptá, který server chcete, a přidá ho do Executoru tohohle Environmentu; klíč zadáte sami v Integracích.",
  // The Apps home and its left column (decision F36).
  appsTitle: "Apps",
  appsAll: "Všechny moduly",
  appsPersonal: "Osobní",
  appsOrganizationDashboard: "Dashboard Organizace",
  appsModulesOne: "{count} modul",
  appsModulesFew: "{count} moduly",
  appsModulesMany: "{count} modulů",
  appsRepositoriesOne: "{count} repozitář",
  appsRepositoriesFew: "{count} repozitáře",
  appsRepositoriesMany: "{count} repozitářů",
  appsOpenApp: "Otevřít aplikaci",
  appsOpenAppNamed: "Otevřít aplikaci modulu {name} v nové záložce",
  appsOpenAppNamedSame: "Otevřít aplikaci modulu {name}",
  appsNoApp: "Bez aplikace",
  appsAbout: "O modulu",
  appsLog: "Log aplikace",
  appsLogHint:
    "Launchpad log zatím neukazuje. Jeho poslední řádky přečteš v příkazové řádce tohoto Environmentu:",
  appsStarting: "Spouštím {name}…",
  appsStartFailed: "{name} se nepodařilo otevřít. Proč, říká přehled modulu.",
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
  // The Apps home and column of the Organization rail (decision F36
  // addendum of 2026-10-04): the wireframe's words.
  appsSayNoApp: "Modul {name} zatím nemá aplikaci.",
  appsSayCannotStart: "Aplikace modulu {name} teď nejde spustit.",
  appsSayRepository: "Repozitář {name} nemá aplikaci.",
  appsMore: "Další volby pro {name}",
  appsFavorites: "Oblíbené",
  appsFavoritesLoading: "Načítání oblíbených…",
  appsFavoritesHint: "Hvězdičkou u modulu si ho připneš sem.",
  appsFavoriteAdd: "Přidat do oblíbených",
  appsFavoriteRemove: "Odebrat z oblíbených",
  appsFavoriteMark: "V oblíbených",
  appsFavoriteFailed: "Oblíbené se nepodařilo uložit. Zkus to znovu.",
  appsModuleAccess: "Přístup k modulu",
  appsInfoModule: "Informace o modulu",
  appsInfoRepository: "Informace o repozitáři",
  appsNewModule: "Nový modul",
  appsNewModuleSub: "Založíš ho s agentem v Chatu",
  appsNewModuleOpened:
    "Chat se otevírá v nové záložce se zadáním nového modulu v poli zprávy, neodeslaným.",
  appsNewModuleCopied:
    "Zadání nového modulu je ve schránce: vlož ho v Chatu do nového vlákna.",
  appsNewModuleCopyFailed:
    "Zadání se nepodařilo zkopírovat; otevři Chat a popiš agentovi nový modul.",
  appsNewModulePrompt:
    "Chci založit nový modul v Organizaci {name} (GitHub {login}).\n\nNež cokoli vytvoříš, zeptej se mě postupně, jednu otázku po druhé:\n1. K čemu modul je a kdo ho bude používat.\n2. Jak se má jmenovat (název a krátký slug).\n3. Jestli má mít aplikaci a jakou (vite-react, astro, astro-starlight, bun-service, python-uv), nebo žádnou.\n4. Které Teamy k němu mají mít přístup.\n\nPak postupuj podle Lazurio Module Standard (skill lazurio-module-standard):\n- modul založ scaffoldem `lazurio module create {login}/<slug> --stack <stack> --teams <teamy>` z task worktree rootu Organizace, nikdy ručně, a nejdřív mi ukaž plán přes --dry-run;\n- ověř, že repozitář modulu existuje na GitHubu v Organizaci {login} a že k němu mají přístup vybrané Teamy;\n- výsledek připrav jako pull request a před Publikací se mě zeptej.",
  appsGuide: "Guide",
  appsMarketplace: "Marketplace",
  appsSoon: "již brzy",
  appsMarketplaceSoon: "Již brzy",
  appsMarketplaceText:
    "Tady si do Environmentu budeš přidávat další moduly. Připravujeme to.",
  appsMarketplaceOrganization:
    " Do té doby přibývají moduly v Dashboardu Organizace {name}.",
  title: "Lazurio Launchpad",
  homeTitle: "Launchpad",
  catalogBreadcrumb: "Kde v Launchpadu jste",
  catalogLoading: "Načítám Organizace…",
  catalogLoadFailed:
    "Organizace nelze načíst. Zkuste Načíst znovu; když to nepomůže, spusťte v CLI lazurio organization list.",
  catalogEmpty: "V tomto Environmentu zatím nejsou žádné aplikace.",
  catalogNotFound:
    "Tahle Organizace nebo modul v tomhle Folderu není. Možná byl přejmenován nebo odstraněn; podívejte se na všechny Organizace.",
  chat: "Chat",
  mausbot: "Lazurio MausBot",
  catalogModules: "Moduly",
  catalogNoModules:
    "Zatím tu nemáš žádné moduly. O přístup požádej Admina Organizace.",
  catalogPersonalspaceEmpty: "Osobní prostor je zatím prázdný.",
  catalogSectionWorkspace: "Workspace",
  catalogSectionProductionspace: "Productionspace",
  catalogCheckedOut: "Naklonovaný",
  catalogNotCheckedOut: "Nenaklonovaný",
  catalogOrganization: "Organizace",
  catalogDirectory: "Složka",
  catalogState: "Stav rozlišení",
  catalogIssues: "Problémy",
  catalogApps: "Aplikace",
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
  preparationReasonLockfileUnused:
    "{file} leží vedle balíčku, který nedeklaruje nic k instalaci: takový balíček lockfile nepotřebuje a Bun pro něj žádný nedrží, takže tenhle tu zůstal navíc. Odstraňte ho z modulu, nebo deklarujte závislosti, které zamyká.",
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
  moduleOpenNamedSame: "Otevřít {name}",
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
  machineKind: "Druh",
  machineName: "Technický název",
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
  setupGithub: "GitHub není připojený. Bez něj tu nic nefunguje.",
  setupGithubAction: "Připojit GitHub",
  setupOrganizationMissing: "{name} tu ještě není.",
  setupPersonalMissing: "Osobní prostor tu ještě není.",
  setupDownload: "Stáhnout",
  setupPrepare: "Připravit",
  setupFailed: "Příprava se zastavila.",
  setupResolve: "Vyřešit v Chatu",
  setupRetry: "Zkusit znovu",
  tourLabel: "Prohlídka Environmentu",
  tourGearTitle: "Nejdřív připoj GitHub",
  tourGearText: "Bez něj tu nic nefunguje.",
  tourSettingsToolsTitle: "Tady se připojují služby",
  tourGithubTitle: "Připoj GitHub",
  tourGithubText: "Uvidíš své moduly a agenti budou pracovat za tebe.",
  tourComposioTitle: "Připoj své aplikace",
  tourComposioText: "Pošta, kalendář, Slack. Klidně až později.",
  tourGearPersonalTitle: "Ještě připrav osobní prostor",
  tourPersonalText: "Místo pro tvé vlastní věci.",
  tourGearOrganizationTitle: "Ještě stáhni {name}",
  tourOrganizationText: "Pak tu uvidíš její moduly.",
  tourOrganization: "Organizaci",
  tourSettingsEnvironmentTitle: "Obsah Environmentu je tady",
  tourPrepareFailedTitle: "Něco se nepovedlo",
  tourPrepareFailedText: "Zkus to znovu, nebo to vyřeší agent v Chatu.",
  tourPreparePersonalTitle: "Připrav osobní prostor",
  tourPrepareOrganizationTitle: "Stáhni {name}",
  tourAppsTitle: "Apps",
  tourAppsText: "Tady otevíráš aplikace svých modulů.",
  tourChatTitle: "Chat",
  tourChatText: "Tady zadáváš práci agentům.",
  tourChatMissingText: "Práce pro agenty. Tady zatím neběží.",
  tourAutomateTitle: "Automate",
  tourAutomateText: "Tady nastavíš, co se má dít samo.",
  tourAutomateMissingText: "Co se má dít samo. Tady zatím neběží.",
  tourSettingsTitle: "Nastavení je vždycky tady",
  tourNext: "Další",
  tourDone: "Hotovo",
  tourNotNow: "Teď ne",
  tourQuit: "Ukončit",
  contentTitle: "Obsah Environmentu",
  contentPersonalspace: "Osobní prostor",
  contentAbsent: "Ještě tu není",
  contentPresent: "Připraveno",
  contentRunning: "Stahuji…",
  contentWaiting: "Na řadě",
  contentStopped: "Zastavilo se",
  contentBlocked: "Teď to připravit nejde",
  contentDownloadAll: "Stáhnout vše",
  contentNeedsGithub: "Nejdřív připoj GitHub v Nástrojích.",
  contentNotAllowed: "Tady se obsah připravit nedá.",
  contentRefused: "Tady to připravit nejde.",
  contentStartFailed: "Přípravu se nepodařilo spustit. Zkus to znovu.",
  contentLost: "Průběh přípravy se nepodařilo zjistit.",
  contentAgentFixes: "Agent v Chatu to opraví.",
  contentDetails: "Podrobnosti",
  contentStepAccess: "Ověřuji přístup",
  contentStepRoot: "Stahuji Organizaci",
  contentStepModules: "Stahuji moduly",
  contentStepPreparation: "Instaluji",
  contentStepCheck: "Kontroluji",
  contentStepFind: "Hledám tvůj osobní prostor",
  contentStepCreate: "Zakládám",
  contentStepClone: "Stahuji",
  contentStepOther: "Připravuji",
  contentFailedAccess: "Přístup k Organizaci se nepodařilo ověřit.",
  contentFailedRoot: "Organizaci se nepodařilo stáhnout.",
  contentFailedModules: "Moduly se nepodařilo stáhnout.",
  contentFailedPreparation: "Moduly se nepodařilo nainstalovat.",
  contentFailedCheck: "Kontrola po přípravě neprošla.",
  contentFailedFind: "Osobní prostor se nepodařilo najít.",
  contentFailedCreate: "Osobní prostor se nepodařilo založit.",
  contentFailedClone: "Osobní prostor se nepodařilo stáhnout.",
  contentFailedOther: "Příprava se nedokončila.",
  contentResolveOpened:
    "Chat se otevírá v nové záložce se zadáním v poli zprávy, neodeslaným.",
  contentResolveCopied:
    "Zadání je ve schránce: vlož ho v Chatu do nového vlákna.",
  contentResolveCopyFailed:
    "Zadání se nepodařilo zkopírovat; otevři Chat a řekni agentovi, co se zastavilo.",
  preparePromptWhatPersonal:
    "Příprava mého osobního prostoru (Personalspace) v tomhle Environmentu",
  preparePromptWhatOrganization:
    "Příprava Organizace {name} (GitHub {login}) v tomhle Environmentu",
  preparePromptStoppedAt: "{what} se zastavila u kroku „{step}“:",
  preparePromptStopped: "{what} se zastavila.",
  preparePromptBody:
    "Dotáhni prosím instalaci se vším všudy:\n1. Zjisti příčinu chyby a oprav ji v tomhle Environmentu.\n2. Dokonči přípravu stejným příkazem, jaký spouští Launchpad: `{command}`.\n3. Ověř výsledek: `lazurio doctor`, a u modulů, které mají testy, jejich testy.\n4. Řekni mi stručně, co bylo špatně, co jsi udělal a co jsi ověřil. Kdyby oprava potřebovala změnu mimo tenhle Environment (třeba v repozitáři), nejdřív se zeptej.",
  toolsDescriptionGh:
    "Připojení na GitHub, kde jsou uložené tvoje moduly. Bez něj tu nic nefunguje.",
  toolsDescriptionComposio:
    "Snadná cesta k mnoha aplikacím přes Composio, s tvým vlastním účtem. Aplikace připojíš v Apps → Integrace.",
  toolsDescriptionWacli:
    "Připojení na WhatsApp: agenti čtou a posílají tvoje zprávy.",
  toolsDescriptionGogcli:
    "Připojení na Google: Gmail, Kalendář a Disk, když nechceš Composio.",
  toolsDescriptionNeon:
    "Připojení na databáze Neon, hlavně pro vývoj aplikací.",
  toolsDescriptionBitwarden:
    "Hesla a přístupy, které Environmentu nasdílíš ve svém trezoru Vaultwarden.",
  toolsDescriptionExecutor:
    "Přes něj agenti používají aplikace připojené přímo z tohoto Environmentu. Instaluje ho a udržuje v chodu Lazurio.",
  toolsNotOffered: "V tomhle Environmentu se nenabízí; agenti ho nepoužívají.",
  vaultRowChecking: "Zjišťuji stav…",
  vaultRowNone: "Nepřipojeno",
  vaultRowConfirming: "Čeká na potvrzení v trezoru",
  vaultRowConnected: "Připojeno",
  vaultRowRevoked: "Přístup odebrán v trezoru",
  vaultRowUnreachable: "Trezor neodpovídá",
  vaultRowSecondWave: "Brzy · druhá vlna",
  vaultRowUnavailable: "V tomhle Environmentu není k dispozici",
  vaultActionConnect: "Připojit",
  vaultActionContinue: "Pokračovat",
  vaultActionReconnect: "Připojit znovu",
  vaultActionRetry: "Zkusit znovu",
  vaultActionDisconnect: "Odpojit",
  vaultActionNamed: "{action}: bitwarden",
  vaultOpen: "Otevřít Vaultwarden",
  vaultSync: "Synchronizovat",
  vaultTitle: "Připojit Bitwarden",
  vaultStepInvite: "Pozvi účet v trezoru",
  vaultStepConnect: "Environment se připojí",
  vaultStepConfirm: "Potvrď účet v trezoru",
  vaultStepDone: "Připojeno",
  vaultInviteText: "Založ kolekci a pozvi do ní tuhle adresu s právem úprav.",
  vaultInviteAgainText: "Pozvi tuhle adresu znovu do kolekce s právem úprav.",
  vaultAdminHint:
    "Pozvat a potvrdit může Admin nebo Owner organizace v trezoru.",
  vaultTeamHint: "Kolekci uvidí celý Team.",
  vaultCollectionLabel: "Kolekce",
  vaultAccountLabel: "Adresa účtu",
  vaultCopy: "Kopírovat",
  vaultCopyNamed: "Kopírovat: {label}",
  vaultCopied: "Zkopírováno",
  vaultInvited: "Pozváno",
  vaultNotInvited: "Adresa ještě není v trezoru pozvaná.",
  vaultUnreachableLine: "Trezor neodpovídá.",
  vaultPhaseInstall: "Instaluji Bitwarden",
  vaultPhaseAccount: "Zakládám účet",
  vaultPhaseSignIn: "Přihlašuji",
  vaultPasswordHint: "Heslo účtu zná jen tento Environment.",
  vaultConfirmText: "Potvrď v trezoru nového člena.",
  vaultFingerprintHint: "Otisk v trezoru musí být stejný:",
  vaultWaiting: "Čekám na potvrzení…",
  vaultNoCollection: "Potvrzeno, ale kolekci {collection} zatím nevidí.",
  vaultSees: "Vidí {seen}.",
  vaultFailed: "Připojení se nedokončilo ({stage}: {reason}).",
  vaultDisconnectTitle: "Odpojit Bitwarden",
  vaultDisconnectText:
    "Agenti tu přestanou trezor používat. Přístup úplně ukončíš odebráním účtu v trezoru.",
  vaultDisconnected:
    "Odpojeno. Účet v trezoru zůstává; Připojit ho přihlásí znovu.",
  vaultCancel: "Zrušit",
  vaultDetails: "Trezor",
  vaultDetailAccount: "Účet",
  vaultDetailVault: "Trezor",
  vaultDetailOrganization: "Organizace",
  vaultDetailCollection: "Kolekce",
  vaultDetailFingerprint: "Otisk",
  vaultCollectionsOne: "{count} kolekce",
  vaultCollectionsFew: "{count} kolekce",
  vaultCollectionsMany: "{count} kolekcí",
  vaultItemsOne: "{count} položka",
  vaultItemsFew: "{count} položky",
  vaultItemsMany: "{count} položek",
  vaultLoadFailed: "Stav trezoru se nepodařilo přečíst.",
  executorRowChecking: "Zjišťuji stav…",
  executorRowRunning: "Běží",
  executorRowNotInstalled: "Není nainstalovaný",
  executorRowOutdated: "Čeká na aktualizaci",
  executorRowNotRunning: "Neběží",
  executorRowIncomplete: "Běží, nastavení není dokončené",
  executorRowConflict: "Koliduje s jinou instalací",
  executorRowSecondWave: "Brzy · druhá vlna",
  executorRowUnavailable: "V tomhle Environmentu není k dispozici",
  executorPhaseInstall: "Instaluje se…",
  executorPhaseService: "Spouští se…",
  executorPhaseAgents: "Připojují se agenti…",
  executorActionInstall: "Nainstalovat",
  executorActionUpdate: "Aktualizovat",
  executorActionRepair: "Opravit",
  executorActionResolve: "Vyřešit s pomocí agenta",
  executorActionNamed: "{action}: executor",
  executorLoadFailed: "Stav Executoru se nepodařilo přečíst.",
  executorDetails: "Executor",
  executorDetailVersion: "Verze",
  executorDetailAddress: "Adresa",
  executorDetailService: "Služba",
  executorDetailAgents: "Agenti",
  executorVersionPinned: "{version} se nainstaluje při příštím nastavení",
  executorVersionOther: "{installed} (Lazurio připíná {version})",
  executorAddressLocal: "{address} (jen tento Environment)",
  executorServiceRunning: "běží",
  executorServiceStopped: "zastavená",
  executorServiceFailed: "selhala",
  executorServiceMissing: "není nainstalovaná",
  executorServiceOther: "spouští jinou instalaci",
  executorServiceUnknown: "nelze zjistit",
  executorAgentConnected: "připojený",
  executorAgentDisabled: "vypnutý v jeho nastavení",
  executorAgentMissing: "zatím nepřipojený",
  executorAgentConflict: "má jiný server jménem executor",
  executorAgentAbsent: "není nainstalovaný",
  executorAgentUnknown: "nelze zjistit",
  executorNewChats:
    "Agenti ho uvidí v nových chatech; běžící chaty pokračují bez něj.",
  executorFailed: "Nastavení se nedokončilo ({stage}: {reason}).",
  executorConflictTitle: "Vyřešit kolizi executoru s pomocí agenta",
  executorConflictPrompt:
    "Úkol: v tomhle Environmentu koliduje Executor Lazuria s jinou instalací. Příkazem `lazurio executor status --json` zjisti, co koliduje: `entry` je `~/.local/bin/executor`, `agents` MCP server jménem `executor` v Codexu nebo Claude Code. Ukaž Operátorovi, co tam je, a jen s jeho souhlasem to odstraň nebo přejmenuj; pak spusť `lazurio executor setup --json` a ověř, že hlásí `running`. Nic dalšího neměň.",
  toolsNotAdded: "Ještě není přidané",
  toolsLoginTitleGh: "Připojit GitHub",
  toolsLoginTitleComposio: "Připojit aplikace",
  toolsLoginCopyCode: "Kopírovat",
  toolsLoginCodeCopied: "Zkopírováno",
  toolsLoginGhHint: "Platí 15 minut, klidně z telefonu.",
  toolsLoginDone: "Hotovo",
  toolsInstallLabel: "Instalace",
  machineBelongs: "Patří",
  machineBelongsYou: "tobě (@{login})",
  machineWorks: "Pracuje v něm",
  machineWorksOnlyYou: "jen ty",
  machineWorksTeam: "Team {team}",
  machineWorksAutomation: "automatizace, odpovídá @{login}",
  machineKindPersonal: "Osobní Remote Environment",
  machineKindWork: "Pracovní Remote Environment",
  machineKindTeam: "Týmový Remote Environment",
  machineKindAutomated: "Automatizovaný Environment",
  machineKindWorkstation: "Tvůj počítač",
  machineTechnicalKind: "Technický druh",
  machineSupport: "Pro podporu",
  browserToggle: "Prohlížeč",
  browserTitle: "Prohlížeč Environmentu",
  browserReload: "Načíst znovu",
  browserOpenTab: "Otevřít v nové kartě",
  browserClose: "Zavřít",
  browserFrame: "Okna prohlížeče Environmentu",
  browserLoading: "Otevírá se prohlížeč Environmentu…",
  browserUnavailable:
    "Prohlížeč Environmentu teď není k dispozici; zkus ho za chvíli načíst znovu.",
  browserFailed:
    "Prohlížeč Environmentu se tu nepodařilo načíst; otevři ho v nové kartě, kde se můžeš znovu přihlásit.",
  integrationsTitle: "Integrace",
  integrationsSubtitle:
    "Co tu připojíš, používají všichni agenti a boti tohoto Environmentu.",
  integrationsHelp: "Jak to funguje",
  integrationsSearch: "Hledat aplikace",
  integrationsRefresh: "Zkontrolovat připojení",
  integrationsTabsLabel: "Zobrazit",
  integrationsTabAll: "Vše",
  integrationsTabConnected: "Připojené",
  integrationsTabCustom: "Vlastní",
  integrationsAvailable: "Dostupné aplikace · {count}",
  integrationsYours: "Tvoje připojení",
  integrationsResults: "Výsledky hledání",
  integrationsLoading: "Načítám Integrace…",
  integrationsChecking: "Kontroluji připojení…",
  integrationsLoadFailed: "Integrace se nepodařilo načíst.",
  integrationsNoneConnected: "Zatím žádné připojené aplikace.",
  integrationsPick: "Vybrat aplikaci",
  integrationsNoneFound: "Žádné aplikace jsme nenašli.",
  integrationsShowAll: "Zobrazit všech {count} aplikací",
  integrationsPopupBlocked:
    "Prohlížeč zablokoval okno s připojením. Povol vyskakovací okna a zkus to znovu.",
  integrationsExecutorUnavailable:
    "Executor v tomhle Environmentu teď neběží, takže nic nejde připojit přímo.",
  integrationsExecutorAbsent:
    "Tenhle Environment nemá Executor, aplikace se tu proto připojují přes Composio nebo svým nástrojem.",
  integrationsExecutorUnreadable:
    "Executor odpověděl nečekaně, přímá připojení se nepodařilo načíst.",
  integrationsComposioUnreadable:
    "Připojení přes Composio se nepodařilo načíst.",
  integrationsToolsUnreadable: "Nástroje se nepodařilo načíst.",
  integrationsRetry: "Zkusit znovu",
  integrationsConnect: "Připojit",
  integrationsAddAccount: "Přidat účet",
  integrationsConnected: "Připojeno",
  integrationsPathDirect: "přímo",
  integrationsPathComposio: "přes Composio",
  integrationsPathTool: "přes {tool}",
  integrationsComposioNote:
    "Připojení zprostředkuje služba Composio, server třetí strany.",
  integrationsAccountName: "Název účtu (nepovinné)",
  integrationsAccountNameRequired: "Název účtu",
  integrationsAccountNameHint:
    "Další účet téže aplikace potřebuje vlastní název.",
  integrationsContinue: "Pokračovat",
  integrationsCancel: "Zrušit",
  integrationsFinishInBrowser: "Dokonči připojení v prohlížeči",
  integrationsFinishInEnvironment:
    "Dokonči přihlášení v prohlížeči Environmentu vpravo.",
  integrationsWaiting: "Čekám na přihlášení…",
  integrationsConnectedNow: "{app} je připojená.",
  integrationsConnectFailed: "Připojení se nepodařilo spustit.",
  integrationsIntegrationConflict:
    "V Executoru je pod jménem téhle aplikace jiný server. Najdeš ho ve Vlastní: odeber ho tam a aplikaci připoj znovu.",
  integrationsConnectEnded: "Připojení se nedokončilo.",
  integrationsNameTaken: "Tenhle název už má jiný účet aplikace.",
  integrationsAccountUnnamed: "účet",
  integrationsAccountExpired: "Přihlášení vypršelo — zkus to znovu",
  integrationsAccountPending: "Dokonči připojení v prohlížeči, nebo účet odpoj",
  integrationsAccountFailed: "Připojení se nepovedlo — zkus to znovu",
  integrationsAccountSpareDirect: "Navíc přímo, nepoužívá se",
  integrationsAccountSpareComposio: "Navíc přes Composio, nepoužívá se",
  integrationsSignInAgain: "Přihlásit znovu",
  integrationsDisconnect: "Odpojit",
  integrationsDisconnectTitle: "Odpojit {account} od aplikace {app}?",
  integrationsDisconnectDirect: "Odpojí se jen v tomto Environmentu.",
  integrationsDisconnectComposio:
    "Odpojí se z Composio účtu {account}, takže ve všech Environmentech, které ho používají.",
  integrationsDisconnectComposioAny:
    "Odpojí se z Composio účtu, takže ve všech Environmentech, které ho používají.",
  integrationsDisconnectPending:
    "Odvolá se jen tento účet; ostatní účty aplikace {app} zůstanou připojené.",
  integrationsDisconnectUnsupported:
    "Composio odsud zatím odpojit nejde: účet odpoj v Composiu.",
  integrationsDisconnectFailed: "Účet se nepodařilo odpojit.",
  integrationsOpenComposio: "Otevřít Composio",
  integrationsMissingPath: "Tady ji zatím nejde připojit.",
  integrationsMissingTool: "Připojí ji nástroj {tool}.",
  integrationsOpenTools: "Otevřít Nástroje",
  integrationsMissingCompanyApp:
    "Firemní aplikace {provider} ještě není nastavená.",
  integrationsComposioOffOrganization: "Composio je ve firmě vypnuté.",
  integrationsComposioOffHere: "Composio je tu vypnuté.",
  integrationsAskAdmin: "Požádat Admina",
  integrationsAskAdminCopied: "Zprávu pro Admina máš ve schránce.",
  integrationsAskAdminText:
    "Prosím o zpřístupnění aplikace {app} v Integracích našich Environmentů: {line}",
  integrationsSetUpInDashboard: "Nastavit v Dashboardu",
  integrationsAllowComposio: "Povolit Composio",
  integrationsComposioSignIn:
    "Nejdřív se přihlas do Composia: otevře se v Nastavení → Nástroje.",
  integrationsBrowserMissing:
    "Přímé přihlášení potřebuje prohlížeč tohoto Environmentu, který tu teď není.",
  integrationsKeyTitle: "Klíč pro {app}",
  integrationsKeyText:
    "Klíč jde jen do Executoru tohoto Environmentu a už se nikde nezobrazí.",
  integrationsKeyLabel: "Klíč",
  integrationsMcpTitle: "MCP servery",
  integrationsMcpAdd: "Přidat MCP server",
  integrationsMcpCommand: "Příkaz na tomto Environmentu",
  integrationsMcpUrl: "Server na adrese URL",
  integrationsMcpKind: "Server",
  integrationsMcpName: "Název",
  integrationsMcpCommandLine: "Příkaz s argumenty",
  integrationsMcpAddress: "Adresa URL",
  integrationsMcpVariable: "Proměnná (nepovinné)",
  integrationsMcpHeader: "Hlavička (nepovinné)",
  integrationsMcpValue: "Hodnota",
  integrationsMcpSubmit: "Přidat",
  integrationsMcpNone: "Zatím žádné MCP servery.",
  integrationsMcpWhereCommand: "Příkaz na tomto Environmentu",
  integrationsMcpReady: "Přidáno",
  integrationsMcpTools: "Připojeno · {tools}",
  integrationsMcpPending: "Spouštím…",
  integrationsMcpFailed: "Nepodařilo se spustit",
  integrationsMcpRemove: "Odebrat",
  integrationsMcpRemoveTitle: "Odebrat MCP server „{name}“?",
  integrationsMcpRemoveText: "Agenti a boti přijdou o jeho nástroje.",
  integrationsMcpAddFailed: "MCP server se nepodařilo přidat.",
  integrationsMcpNameTaken: "Integrace s tímhle názvem už existuje.",
  integrationsMcpUnavailable:
    "Executor tu teď neběží, takže MCP servery nejde přidat.",
  integrationsToolsOne: "{count} nástroj",
  integrationsToolsFew: "{count} nástroje",
  integrationsToolsMany: "{count} nástrojů",
};
export function messages(
  locale: unknown,
): Readonly<Record<MessageKey, string>> {
  return locale === "cs" ? cs : en;
}
