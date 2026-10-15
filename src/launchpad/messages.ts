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
  voiceContextLarge:
    "The combined agent instructions are too long. Shorten this voice or your tool notes, then load current settings and try again.",
  voiceTitle: "Agent communication",
  voiceEditor: "Tone of Voice for agents",
  voiceIntro:
    "Set how agents communicate in this Environment, including emails, WhatsApp messages and instructions for other agents.",
  voiceShared: "Everyone in this team Environment uses the same voice.",
  voiceLanguageLink: "Change language in General",
  voiceHint:
    "Edit the text to suit you. Saved changes apply to new conversations.",
  voiceSave: "Save",
  voiceCancel: "Cancel changes",
  voiceRestore: "Restore default",
  voiceDefault: "Default tone",
  voiceCustom: "Custom tone",
  voiceDirty: "Unsaved changes",
  voiceSaved: "Saved. New conversations will use this voice.",
  voiceInvalid:
    "Enter a text up to 8 KB, or restore the default tone. Shorten long text before saving.",
  voiceFailed:
    "Could not save. Your draft is kept. Load current settings before trying again.",
  voiceStale:
    "Settings changed elsewhere. Your draft is kept. Load current settings, check your text and save again.",
  voiceRefresh: "Load current settings",

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
  toolsNotPinned: "This is not the build Lazurio uses ({pinned}).",
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
  // A tool the Organization decides on its Environment (root decision 0194,
  // decision F45).
  toolsOrganizationOff: "The Organization does not allow {name} here.",
  toolsOrganizationKept:
    "Your choice is kept: once the Organization allows it, agents use it again.",
  toolsOrganizationAllows: "The Organization allows it.",
  toolsOrganizationLocked: "Set by the Organization",
  toolsOrganizationLockedNamed: "Set by the Organization: {name}",
  toolsOrganizationDetails: "Organization settings",
  toolsOrganizationHow:
    "Only the Organization's Admin can change it, in the Organization's settings.",
  toolsOrganizationFromDashboard:
    "This Environment asks the Dashboard for them every two minutes.",
  toolsOrganizationFromRepository:
    "This Environment reads them from the Organization's repository it holds.",
  toolsOrganizationVersion: "Version {version}, applied {time}.",
  toolsOrganizationNotApplied: "Nothing applied yet.",
  toolsOrganizationChecked: "Last checked {time}.",
  toolsOrganizationNotChecked: "Not checked yet.",
  toolsOrganizationUnreachable:
    "The Dashboard is not answering right now; the settings applied last stay.",
  toolsOrganizationIdentity:
    "This Environment cannot identify itself to the Dashboard right now; the settings applied last stay.",
  toolsOrganizationInvalid:
    "The Organization's settings are invalid right now and its Admin needs to fix them; the settings applied last stay.",
  toolsOrganizationRepository:
    "The Organization's repository here could not be read; the settings applied last stay.",
  toolsOrganizationState:
    "The record of the settings applied last could not be read; they are checked again.",
  toolsOrganizationUnapplied:
    "Some of the Organization's settings could not be applied here; an agent can find out why.",
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
  toolsUpdateAction: "Update",
  toolsUpdateActionNamed: "Update {name}",
  toolsUpdating:
    "Updating {name} to the build Lazurio uses. This can take a minute.",
  toolsUpdatedNow: "{name} {version} is installed; the sign-in stays.",
  toolsUpdateFailed:
    "The update did not finish. Refresh the status to see which version runs now.",
  toolsUpdateFailedDetail: "Why: {reason}",
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
  toolsGitIdentitySet:
    "Your commits in this Environment carry the name {name} <{email}>.",
  toolsGitIdentityCompleted:
    "Git in this Environment now has your name and email for commits; what was missing came from your GitHub account.",
  toolsGitIdentityNotSet:
    "Git in this Environment does not know your name and email for commits yet, so publishing changes from here fails. Ask an agent to set your Git identity.",
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
  toolsComposioOrgMatches:
    "This Environment uses your Composio organization “{name}”, named as its Organization is.",
  toolsComposioOrgMissing:
    "Your Composio account has no organization named “{name}”, as this Environment's Organization is. Until you create it, this Environment connects in the organization you have selected. Create it in Composio, for yourself alone, then click Check again.",
  toolsComposioOrgAmbiguous:
    "Your Composio account has more than one organization named “{name}”. Until only one is left, this Environment connects in the organization you have selected. Keep one, then click Check again.",
  toolsComposioOrgElsewhere:
    "Composio could not be switched to your organization “{name}”. Click Check again.",
  toolsComposioOrgCheckAgain: "Check again",
  toolsComposioOrgUnverified:
    "The name of this Environment's Organization cannot be read, so its Composio organization cannot be checked. Click Check again; if that does not help, ask the agent in Chat to check this Environment's Folder.",
  toolsComposioOrgPersonal:
    "On a personal Environment, choose your default organization, the one Composio made when you signed up.",
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
  // An Owner's Workspace before its first module (#376).
  appsModulesNone: "no modules yet",
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
  // The personal space's links after its modules (root decision 0185's
  // addendum of 2026-10-13); the names are the switch's and the column's.
  appsStartsTitle: "What else you can do here",
  appsStartsChat: "Give the agent its first task",
  appsStartsAutomate: "Set up what should happen on its own",
  appsStartsIntegrations: "Connect your mail and calendar",
  appsStartsFiles: "Upload documents for the agents",
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
  appsNewModuleSub: "Create with an agent",
  appsNewModuleOpened:
    "Chat opens in a new tab with the new module's brief in the composer, not sent.",
  appsNewModuleCopied:
    "The new module's brief is in your clipboard: paste it into a new chat.",
  appsNewModuleCopyFailed:
    "The brief could not be copied; open Chat and describe the new module to the agent.",
  appsNewModulePrompt:
    "I want to build a new module in the Lazurio Workspace.\nIt will be in the Organization {name} (GitHub {login}).\n\nUse the skill `new-module`. First ask me what the module is for and what it should solve for me, choose the technical details yourself, and before you start building, show me the plan to confirm.",
  // The personal space's "+ Nový modul" (root decision 0185's addendum of
  // 2026-10-13); in Czech the person's own words, so tykání (0199).
  appsNewPersonalModulePrompt:
    "I want to build a new module in the Lazurio Workspace.\nIt will be in my personal space, as a private repository on my GitHub account {login}.\n\nUse the skill `new-module`. First ask me what the module is for and what it should solve for me, choose the technical details yourself, and before you start building, show me the plan to confirm.",
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
  catalogReasonPersonalspaceForeign:
    "personalspace/ holds a checkout that is not the personal space of the GitHub account signed in here, so it is not read and none of its apps run. It was left untouched.",
  catalogReasonPersonalspaceNotOwned:
    "GitHub does not know this personal space as a repository of the account signed in here, so it is not read.",
  catalogReasonPersonalspacePublic:
    "This personal space's repository is public on GitHub. A personal space must be private, so it is not read until it is.",
  catalogReasonGithubSignedOut:
    "GitHub is not signed in here, so it cannot be verified that this personal space is yours. Sign in to GitHub in Settings → Tools.",
  catalogReasonGithubUnavailable:
    "GitHub did not answer, so it cannot be verified now that this personal space is yours. It is checked again once GitHub answers.",
  catalogReasonGithubIdentityMismatch:
    "GitHub is signed in here with another account than this Environment's owner, so this personal space is not read.",
  catalogReasonPersonalspaceUnverified:
    "Checking with GitHub that this personal space is yours…",
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
  moduleReasonRequiredSlotUndeclared:
    "The app requires {file}, which the Organization manifest does not declare, so it was not started. Fix the app's required_module_slots or the Organization manifest.",
  moduleReasonRequiredSlotPlanned:
    "The app requires {file}, which the Organization manifest declares as planned, so it cannot start in this Environment yet.",
  moduleReasonRequiredSlotMissing:
    "The app requires {file}, which is not in this Environment beside it, so it was not started. Synchronize the Organization, or ask for access to that module, and start again.",
  moduleReasonRuntimeSecretUnavailable:
    "The app was not started: it needs secrets that this Environment's vault did not give it. {secrets}. Values are never shown; add or fix the item named exactly like the secret in the Environment's vault and start again.",
  moduleSecretsNotProvided:
    "Started without these optional secrets, so the capabilities that need them are off: {secrets}.",
  runtimeSecretPersonalspace:
    "a Personalspace app reads secrets only in its person's personal Environment",
  runtimeSecretPersonalEnvironment:
    "the vault of a personal Environment serves only Personalspace apps",
  runtimeSecretWorkstation: "this computer has no Environment vault yet",
  runtimeSecretNoVaultIdentity: "this Environment has no vault yet",
  runtimeSecretOtherOrganization:
    "the app belongs to another Organization than the one that owns this Environment and its vault",
  runtimeSecretNotConnected:
    "the vault is not set up yet (Settings → Tools → bitwarden)",
  runtimeSecretLocked: "the vault could not be unlocked",
  runtimeSecretBusy: "the vault is busy; try again",
  runtimeSecretUnreachable: "the vault cannot be reached",
  runtimeSecretVaultFailed: "the vault did not answer as expected",
  runtimeSecretMissing: "no item of this name in the Environment's vault",
  runtimeSecretAmbiguous:
    "more than one item of this name in the Environment's vault",
  runtimeSecretEmpty: "its item has no password",
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
  machineAssignmentTeam: "Team",
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
  contentStepBootstrap: "Setting up",
  contentStepPush: "Saving to GitHub",
  contentStepOther: "Preparing",
  contentFailedAccess: "Access to the Organization could not be verified.",
  contentFailedRoot: "The Organization could not be downloaded.",
  contentFailedModules: "The modules could not be downloaded.",
  contentFailedPreparation: "The modules could not be installed.",
  contentFailedCheck: "The check after the preparation did not pass.",
  contentFailedFind: "Your personal space could not be found.",
  contentFailedCreate: "Your personal space could not be created.",
  contentFailedClone: "Your personal space could not be downloaded.",
  contentFailedBootstrap: "Your personal space could not be set up.",
  contentFailedPush:
    "The setup of your personal space could not be saved to GitHub.",
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
  toolsDescriptionBitwarden: "Passwords and other items for agents.",
  toolsDescriptionExecutor:
    "Agents use the apps connected directly from this Environment through it. Lazurio installs it and keeps it running.",
  toolsNotOffered: "Not offered in this Environment; agents do not use it.",
  vaultRowChecking: "Checking…",
  vaultRowConnected: "Connected",
  vaultRowNotSetUp: "Not set up yet",
  vaultRowCreating: "The vault is being created",
  vaultRowNotAllowed: "The network has not allowed its account yet",
  vaultRowRemoved: "The vault was removed",
  vaultRowRevoked: "Access removed in the vault",
  vaultRowUnreachable: "The vault does not answer",
  vaultRowFailed: "The setup did not finish",
  vaultRowNoVault: "This Environment has no vault yet",
  vaultRowSecondWave: "Soon · second wave",
  vaultRowUnavailable: "Not available in this Environment",
  vaultPhaseInstall: "Installing Bitwarden…",
  vaultPhaseAccount: "Preparing the vault's account…",
  vaultPhaseVault: "Preparing the vault…",
  vaultPhaseSignIn: "Signing in…",
  vaultActionSetUp: "Set up",
  vaultActionRetry: "Try again",
  vaultActionNamed: "{action}: bitwarden",
  vaultOpen: "Open the vault",
  vaultLoadFailed: "The vault's state could not be read.",
  // Settings → Vault (root decision 0198 point 5, the wireframe's
  // Nastavení → Trezor): the rule, the vault and the way into it.
  vaultPageTitle: "Vault",
  vaultPageRule:
    "Whoever has access to the Environment has all of its passwords.",
  vaultPageWorkstation: "There is no vault on this computer yet.",
  vaultPageNoVault: "This Environment has no vault yet.",
  vaultPageAgentsOnly: "Only this Environment's agents use its vault for now.",
  vaultPageCreating: "Creating the vault…",
  vaultPageUnreachable: "Not responding",
  vaultPageItemsOne: "{count} item",
  vaultPageItemsFew: "{count} items",
  vaultPageItemsMany: "{count} items",
  vaultPageAddItem: "Add item",
  vaultPageOpen: "Open vault",
  vaultPageCreateAccount: "Create an account in the vault",
  // An agent's secret request in Nastavení → Trezor (root decision 0198
  // point 9 (c), decision F54; the wireframe's screens/SecretRequest.tsx).
  vaultRequestsTitle: "Agents' requests",
  vaultRequestTitle: "Agent's request",
  vaultRequestAnswer: "Fill in",
  vaultRequestAnd: "and",
  vaultRequestItem:
    "It is saved in the Environment's vault as the item {item}.",
  vaultRequestSave: "Save to the vault",
  vaultRequestDecline: "Decline",
  vaultRequestShow: "Show",
  vaultRequestHide: "Hide",
  vaultRequestSaving: "Saving…",
  vaultRequestSaved: "Saved to the vault.",
  vaultRequestDeclined: "Declined.",
  vaultRequestMissing: "This request does not exist.",
  vaultRequestNoVault: "This Environment has no vault yet.",
  vaultRequestNotReady: "The Environment's vault is not ready yet.",
  vaultRequestFill: "Fill in every field.",
  vaultRequestBusy: "The vault is not responding. Try again in a moment.",
  vaultRequestFailed: "Saving did not work. Try again.",
  vaultRequestLoadFailed: "The request could not be read.",
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
  browserTabClose: "Close",
  browserTabCloseOthers: "Close others",
  browserTabCloseRight: "Close to the right",
  browserClose: "Close",
  browserFrame: "A tab of the Environment browser",
  browserFailed: "This tab of the Environment browser cannot be shown here.",
  browserWidth: "Browser width",
  dividerHint: "Drag to change the width; a double-click restores the default",
  columnHide: "Hide navigation",
  columnShow: "Show navigation",
  columnWidth: "Navigation width",
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
  integrationsComposioOrganizationMissing:
    "Your Composio account has no organization named “{name}”. This Environment belongs to the Organization {name} and should connect through Composio in your own organization of the same name; until you create it, it connects in the organization you have selected. Create it in Composio, then click Check connections.",
  integrationsComposioOrganizationAmbiguous:
    "Your Composio account has more than one organization named “{name}”. Until only one is left, this Environment connects in the organization you have selected. Keep one, then click Check connections.",
  integrationsComposioOrganizationElsewhere:
    "Composio could not be switched to your organization “{name}”, so nothing connects through it now. Click Check connections to try again.",
  integrationsComposioOrganizationUnverified:
    "The name of this Environment's Organization cannot be read, so its Composio organization cannot be checked and nothing connects through Composio now. Click Check connections; if that does not help, ask the agent in Chat to check this Environment's Folder.",
  integrationsComposioOpen: "Open Composio",
  integrationsComposioApps: "Apps in Composio",
  integrationsComposioMissing: "Can't find an app here?",
  integrationsComposioConnectThere: "Connect it in Composio",
  integrationsOutsideCatalog: "From Composio, outside Lazurio's catalog.",
  integrationsComposioOrganizationChanged:
    "Composio does not work in this Environment's organization now. Click Check connections.",
  composioModelTitle: "How this Environment uses Composio",
  composioModelAccount: "Your Composio account",
  composioModelAccountNote: "signed in with GitHub",
  composioModelOrganization: "organization “{name}”",
  composioModelOthers: "an organization for each of your other Organizations",
  composioModelDefault: "your default organization",
  composioModelEnvironments: "Environments of {name}",
  composioModelOtherEnvironments: "their Environments",
  composioModelPersonal: "your personal Environment",
  composioModelCaption:
    "You invite nobody to your organizations and share no key.",
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
  integrationsReturnTitle: "Sign-in",
  integrationsReturnConnected:
    "{app} is connected. You can close this window and go back to Lazurio.",
  integrationsReturnFailed:
    "The sign-in to {app} could not be finished. Go back to Lazurio and try again.",
  integrationsReturnPending:
    "The sign-in to {app} is finishing. Lazurio shows how it went; you can close this window.",
  integrationsReturnUnknown:
    "This sign-in is no longer valid. Start connecting again in Lazurio.",
  integrationsConnectFailed: "The connection could not be started.",
  integrationsIntegrationConflict:
    "Executor holds another server under this app's name. You find it in Custom: remove it there and connect the app again.",
  integrationsStillFailing:
    "It still does not work: Executor cannot use this account. Try again later, or disconnect it.",
  integrationsConnectEnded: "The connection was not finished.",
  integrationsNameTaken: "This name is used by another account of the app.",
  integrationsAccountUnnamed: "account",
  integrationsAccountExpired: "The sign-in expired",
  integrationsAccountPending:
    "Finish the connection in the browser, or disconnect the account",
  integrationsAccountFailed: "The connection failed",
  integrationsAccountSpareDirect: "Also directly, not used",
  integrationsAccountSpareComposio: "Also through Composio, not used",
  integrationsSignInAgain: "Sign in again",
  integrationsAccountMore: "More options for {account} in {app}",
  integrationsManageInComposio: "Manage in Composio",
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
  integrationsDisconnecting: "Disconnecting…",
  integrationsDisconnectStillListed:
    "Disconnected, but it still shows here. Check connections in a moment.",
  integrationsComposioUpdate:
    "Update Composio to disconnect accounts here and see their names.",
  integrationsComposioUpdating: "Updating Composio…",
  integrationsComposioUpdated: "Composio is updated.",
  integrationsComposioUpdateFailed: "The update did not finish. Try again.",
  integrationsOpenComposio: "Open Composio",
  integrationsMissingPath: "It cannot be connected here yet.",
  integrationsMissingTool: "The tool {tool} connects it.",
  integrationsOpenTools: "Open Tools",
  integrationsMissingCompanyApp:
    "The {provider} company app is not set up yet.",
  integrationsComposioOffOrganization: "Composio is off in the Organization.",
  integrationsComposioOffHere: "Composio is off here.",
  integrationsAskAdmin: "Ask the Admin",
  integrationsAskAdminCopied: "A message for the Admin is in your clipboard.",
  integrationsAskAdminText:
    "Please make {app} available in the Integrations of our Environments: {line}",
  integrationsSetUpInDashboard: "Set up in the Dashboard",
  integrationsAllowComposio: "Allow Composio",
  integrationsAdminWhere:
    "You set this up in the Dashboard, in the Organization's settings.",
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
  integrationsMcpNone: "No MCP servers yet.",
  integrationsMcpWhereCommand: "A command in this Environment",
  integrationsMcpReady: "Added",
  integrationsMcpTools: "Connected · {tools}",
  integrationsMcpPending: "Starting…",
  integrationsMcpFailed: "Could not start",
  integrationsMcpEdit: "Edit",
  integrationsMcpRemove: "Remove",
  integrationsMcpRemoveTitle: "Remove the MCP server “{name}”?",
  integrationsMcpRemoveText: "Agents and bots lose its tools.",
  integrationsMcpNameTaken: "An integration of this name exists already.",
  integrationsMcpPageTitle: "Connect a custom MCP server",
  integrationsMcpEditTitle: "Edit a custom MCP server",
  integrationsMcpBack: "Back",
  integrationsMcpDocs: "Docs",
  integrationsMcpName: "Name",
  integrationsMcpNamePlaceholder: "MCP server name",
  integrationsMcpType: "Type",
  integrationsMcpTypeFixed:
    "A saved server keeps its type: remove it and add it again to change it.",
  integrationsMcpCommand: "Command to launch",
  integrationsMcpArgs: "Arguments",
  integrationsMcpAddArg: "Add argument",
  integrationsMcpRemoveArg: "Remove argument",
  integrationsMcpEnv: "Environment variables",
  integrationsMcpAddEnv: "Add environment variable",
  integrationsMcpRemoveEnv: "Remove variable",
  integrationsMcpCwd: "Working directory",
  integrationsMcpUrl: "URL",
  integrationsMcpBearer: "Bearer token",
  integrationsMcpRemoveBearer: "Remove the Bearer token",
  integrationsMcpHeaders: "Headers",
  integrationsMcpAddHeader: "Add header",
  integrationsMcpRemoveHeader: "Remove header",
  integrationsMcpKey: "Key",
  integrationsMcpValue: "Value",
  integrationsMcpStored: "Stored",
  integrationsMcpEnterAgain: "Enter again",
  integrationsMcpSave: "Save",
  integrationsMcpSaving: "Saving…",
  integrationsMcpLoading: "Reading the server's settings…",
  integrationsMcpLoadFailed: "The server's settings could not be read.",
  integrationsMcpAdded: "The MCP server “{name}” is added.",
  integrationsMcpSaved: "The changes to “{name}” are saved.",
  integrationsMcpSaveFailed: "The MCP server could not be saved.",
  integrationsMcpGone: "This MCP server is no longer in Executor.",
  integrationsMcpInvalid: "Some of the fields are not right; check them.",
  integrationsMcpNameInvalid: "A name has at most 64 characters on one line.",
  integrationsMcpTextInvalid:
    "This text cannot be used: it has a control character or is too long.",
  integrationsMcpUrlInvalid:
    "Enter the full address, such as https://mcp.example.com/mcp.",
  integrationsMcpUrlInsecure:
    "The address starts with https://. Plain http:// only to this Environment (localhost).",
  integrationsMcpCwdInvalid: "Enter a full path, such as ~/code or /srv/mcp.",
  integrationsMcpEnvNameInvalid:
    "Letters, digits and underscores only, not starting with a digit.",
  integrationsMcpHeaderNameInvalid: "A header name has no spaces or colons.",
  integrationsMcpKeyRequired: "Fill in the key.",
  integrationsMcpValueRequired: "Fill in the value.",
  integrationsMcpValueInvalid:
    "A value has at most 4,096 characters; a header's is on one line.",
  integrationsMcpDuplicate: "This key is here twice.",
  integrationsMcpBearerTaken: "The Bearer token sends this header already.",
  integrationsToolsOne: "{count} tool",
  integrationsToolsFew: "{count} tools",
  integrationsToolsMany: "{count} tools",
  // Settings → SSH from your devices (decision F49).
  sshTitle: "SSH from your devices",
  sshIntro:
    "Connect to this Environment over SSH from a terminal on your own computer. Each computer has its own key, which you can remove here at any time.",
  sshShared:
    "This is the whole Team's shared Environment: a device added here signs in to the Team's account, and everyone in the Team sees it and can remove it.",
  sshUnsupported:
    "SSH from your devices is available in Environments on Linux and macOS.",
  sshRefresh: "Refresh",
  sshLoading: "Reading SSH access…",
  sshLoadFailed: "SSH access could not be read. Try Refresh.",
  sshPromptTitle: "Prompt for your agent",
  sshPromptNote:
    "Give it to the agent on your computer, for example Codex. It opens this page in its browser panel, where you only sign in; it sets up the rest itself.",
  sshPromptCopy: "Copy prompt",
  sshPromptUnavailable:
    "The prompt appears once the settings for your computer are known (below).",
  sshPromptText:
    "Connect this computer to my Lazurio Environment \"{alias}\" over SSH and add its Lazurio Folder to Codex as a project.\n\nThe Environment's page has its address, account and host key: {url}\n\n1. Use the key {keyPath} (on Windows {windowsKeyPath}). If it does not exist yet, create an ed25519 key. The private key never leaves this computer; only the .pub file does.\n2. On the page, under \"Add a device\", register its public key.\n3. Add the page's SSH settings and known_hosts line for {alias}. Leave other connections as they are. If the same entry already exists, use it; if a different one exists for {alias}, change nothing and tell me.\n4. Check that SSH works: ssh {alias} true\n5. Then open the page's Codex link: {desktopLink}. If the app cannot open it, add the alias and the page's Folder path yourself in Settings → Connections → SSH.\n\nDo not switch the Tailscale profile. A registered key does not give network access; the network administrator allows that. Finally, tell me how the connection went.",
  sshDevicesTitle: "Your devices",
  sshDevicesNone: "No device has been added here yet.",
  sshAddedBy: "Added {date} by {who}",
  sshAddedLocal: "Added {date} without a Lazurio account",
  sshRemove: "Remove",
  sshRemoveNamed: "Remove {device}",
  sshRemoveConfirm: "Remove {device}? It can no longer sign in over SSH.",
  sshRemoveYes: "Remove",
  sshRemoveCancel: "Cancel",
  sshRemoved: "{device} was removed and can no longer sign in.",
  sshRemovedStillAllowed:
    "{device} was removed here, but the same key is still allowed by a line added outside Launchpad.",
  sshRemoveFailed:
    "The device could not be removed. Try Refresh, then remove it again.",
  sshRemoveNotFound: "This key is no longer here. Try Refresh.",
  sshRemoveNotOwn:
    "This key was added outside Launchpad; Launchpad does not remove it.",
  sshOutsideTitle: "Added outside Launchpad",
  sshOutsideNote:
    "Launchpad never changes or removes these keys, for example the key this Environment was set up with. Whoever looks after this Environment removes them.",
  sshOutsideUnreadable: "A line Launchpad cannot read",
  sshOutsideUntitled: "A key without a name",
  sshProblemDirectory:
    "~/.ssh in this Environment is not a regular folder, so Launchpad does not change it.",
  sshProblemSymlink:
    "~/.ssh/authorized_keys is a link, so Launchpad does not change it. An agent in this Environment can replace it with a regular file.",
  sshProblemNotFile:
    "~/.ssh/authorized_keys is not a regular file, so Launchpad does not change it.",
  sshProblemForeignOwner:
    "~/.ssh/authorized_keys belongs to another account, so Launchpad does not change it.",
  sshProblemTooLarge:
    "~/.ssh/authorized_keys is larger than 1 MB, so Launchpad does not change it.",
  sshAddTitle: "Add a device",
  sshAddNote:
    "Its name and its public key: one line from the .pub file that starts with ssh-ed25519. Never the private key.",
  sshDeviceName: "Device name",
  sshDeviceNameHint: "For example alex-laptop.",
  sshPublicKey: "Public key",
  sshAdd: "Add device",
  sshAdding: "Adding…",
  sshAdded:
    "{device} can now sign in. The settings for your computer are below.",
  sshAlreadyPresent:
    "This key can already sign in here; nothing was changed. The settings for your computer are below.",
  sshAddFailed:
    "The device could not be added. Try again; if it keeps failing, ask an agent in this Environment.",
  sshRefusedKeyMissing: "Paste the public key.",
  sshRefusedPrivateKey:
    "This is a private key. Never paste it anywhere; paste the public key from the .pub file.",
  sshRefusedMultipleLines: "Paste exactly one key, on one line.",
  sshRefusedOptions:
    "Paste the key without options in front of it, such as command= or from=.",
  sshRefusedKeyRestricted:
    "This key is already allowed here with restrictions added outside Launchpad (such as from= or command=), so this device could not use it to sign in. Create a new key for this device, or ask whoever looks after this Environment.",
  sshRefusedType:
    "Only ed25519 keys are accepted (ssh-ed25519 or sk-ssh-ed25519@openssh.com). Create one with ssh-keygen -t ed25519.",
  sshRefusedInvalidKey:
    "This key is damaged or incomplete. Copy the whole line from the .pub file again.",
  sshRefusedNotKey:
    "This is not an SSH public key. It is one line that starts with ssh-ed25519.",
  sshRefusedName: "Give the device a name with letters or digits.",
  sshRefusedAddedBy:
    "The signed-in account could not be recorded. Reload the page and try again.",
  sshCodexLink: "Add Environment to Codex",
  sshComputerTitle: "Settings for your computer",
  sshComputerNote:
    "Your agent writes these on your computer. The host key is this Environment's own, so your computer checks that it really talks to this Environment.",
  sshConfigLabel: "SSH config",
  sshConfigNote: "Add to ~/.ssh/config",
  sshKnownHostsLabel: "known_hosts",
  sshKnownHostsNote: "Add to ~/.ssh/known_hosts_lazurio",
  sshCopy: "Copy",
  sshCopied: "Copied.",
  sshNetworkNote:
    "Adding a key does not give this device network access by itself. If SSH fails, give your agent the exact error. If the device is not allowed on the network yet, the network administrator can allow it.",
  sshComputerMissing: "The settings for your computer are not available yet:",
  sshMissingTailscale: "Tailscale is not installed in this Environment.",
  sshMissingTailscaleFailed: "Tailscale in this Environment did not answer.",
  sshMissingNotRunning: "Tailscale is not connected in this Environment.",
  sshMissingDnsName: "This Environment has no name in its tailnet (MagicDNS).",
  sshMissingHostKey:
    "This Environment has no ed25519 host key (/etc/ssh/ssh_host_ed25519_key.pub).",
  sshMissingUser:
    "This Environment's account has no name an SSH config can use.",
} as const;
export type MessageKey = keyof typeof en;
const cs: Record<MessageKey, string> = {
  voiceContextLarge:
    "Celé instrukce pro agenty jsou příliš dlouhé. Zkraťte tón nebo vlastní poznámky k nástrojům, pak načtěte aktuální nastavení a zkuste uložení znovu.",
  voiceTitle: "Komunikace agentů",
  voiceEditor: "Tone of Voice pro agenty",
  voiceIntro:
    "Nastavte, jak mají agenti v tomto Prostředí komunikovat — včetně e-mailů, zpráv na WhatsAppu a instrukcí pro další agenty.",
  voiceShared: "Toto Týmové Prostředí používá jeden společný tón pro všechny.",
  voiceLanguageLink: "Změnit jazyk v Obecném nastavení",
  voiceHint:
    "Text si můžete upravit. Uložené změny se projeví v nových konverzacích.",
  voiceSave: "Uložit",
  voiceCancel: "Zrušit úpravy",
  voiceRestore: "Obnovit výchozí tón",
  voiceDefault: "Výchozí tón",
  voiceCustom: "Vlastní tón",
  voiceDirty: "Neuložené úpravy",
  voiceSaved: "Uloženo. Nové konverzace budou používat tento tón.",
  voiceInvalid:
    "Napište text do 8 kB, nebo obnovte výchozí tón. Delší text před uložením zkraťte.",
  voiceFailed:
    "Uložení se nepodařilo. Rozepsaný text zůstává. Před dalším pokusem načtěte aktuální nastavení.",
  voiceStale:
    "Nastavení se mezitím změnilo. Rozepsaný text zůstává. Načtěte aktuální nastavení, zkontrolujte text a uložte ho znovu.",
  voiceRefresh: "Načíst aktuální nastavení",

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
    "Deklarované zdravotní kontroly prošly. Tato aplikace běží dál i při restartu Lazuria; restart Prostředí nepřežije. Po otevření ověřte funkci aplikace.",
  appEnded:
    "Aplikace už neběží; její vlastník hlásí, že skončila. Prohlédněte výsledek a pak ji znovu spusťte, nebo ji zastavte a záznam tím uvolněte.",
  appStart: "Spustit",
  appStatus: "Stav",
  appOpen: "Získat odkaz aplikace",
  appStop: "Zastavit",
  appVisit: "Otevřít aplikaci v tomto Prostředí",
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
    "Tato adresa patří Prostředí, které aplikaci spouští. Vzdálené otevření vyžaduje ověřenou přístupovou cestu.",
  updateTitle: "Aktualizace produktu",
  updateNotes: "Poznámky k vydání",
  updateUnknown: "Lazurio {running}.",
  updateIdle: "Lazurio {running} je aktuální.",
  updateChecking: "Zjišťuje se nová verze…",
  updateAvailable: "Je k dispozici Lazurio {latest} (běží {running}).",
  updateDownloading: "Stahuje se a ověřuje Lazurio {latest}…",
  updateActivating:
    "Aktivuje se Lazurio {latest} a restartuje se; aplikace běží dál.",
  updateRestart:
    "Lazurio {active} je nainstalované. Aktualizaci dokončí restart Lazuria.",
  updateAction: "Aktualizovat",
  updateRetry: "Zkusit znovu",
  updateChecked: "Poslední ověřená kontrola: před {age}.",
  updateNeverChecked: "Zatím žádná ověřená kontrola.",
  updateStale:
    "Poslední ověřená kontrola: před {age}. Novější vydání může být tomuto Prostředí zadržováno.",
  updateFailed:
    "Aktualizace se nedokončila: {code}. Nainstalovaná verze běží dál; stejné kliknutí ji zopakuje.",
  updateStateInvalid:
    "Stav aktualizace vyžaduje zásah člověka: {path}. Automaticky se nic nemění.",
  updateStarted: "Aktualizace spuštěna…",
  updateRefused: "Aktualizace nebyla spuštěna; zobrazený stav byl obnoven.",
  updateFolderRefresh:
    "Folder je potřeba obnovit: vykreslila ho revize šablon {recorded}, Lazurio teď vykresluje {product}. Spusťte: {command}",
  toolsTitle: "Nástroje",
  toolsSwitchLabel: "Používají agenti",
  toolsSwitchNamed: "Používají agenti: {name}",
  toolsTeamGithub: teamGithubText.cs,
  toolsTeamGithubLogout: teamGithubLogoutText.cs,
  toolsShared:
    "Toto je společné Prostředí celého Teamu. Přihlašujte se tu týmovými účty, třeba společnou schránkou nebo kalendářem. Co tu přihlásíte, může používat každý z Teamu. Svoje osobní účty propojujte ve svém vlastním Prostředí.",
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
  toolsTierOptionalNote: "Zapněte jen to, co používáte.",
  toolsInstalled: "Nainstalováno, verze {version}",
  toolsInstalledNoVersion: "Nainstalováno, verze neznámá",
  toolsNotInstalled: "Není nainstalováno",
  toolsVersionError: "Zjištění verze selhalo: {error}.",
  toolsNotPinned: "Toto není sestavení, které Lazurio používá ({pinned}).",
  toolsFixWithAgent: "Opravit s agentem",
  toolsFixWithAgentNamed: "Opravit {name} s agentem",
  toolsFixPromptHint:
    "Zkopírujte tento prompt a vložte ho do nového chatu v tomto Prostředí. Agent nástroj srovná na jeho místo; nic se nepřeinstaluje a přihlášení zůstane.",
  toolsFixPrompt:
    "Úkol: nástroj `{command}` v tomto Prostředí funguje, ale nespouští se ze standardního místa `~/.local/bin/{command}`; teď se spouští z `{path}`. Srovnej to: do `~/.local/bin` dej jen link nebo wrapper na fungující program, aby se `{command}` spouštěl odtud. Nic nepřeinstalovávej, neměň verzi a nesahej na přihlášení ani nastavení. Když to bez změny mimo domovský adresář nejde, nic neměň a řekni mi proč. Důkaz: `command -v {command}` vypíše `~/.local/bin/{command}` (rozbalené na domovský adresář), `{command} --version` odpoví stejnou verzí jako předtím a `lazurio tools status --json` u něj ukáže `standardPath: true`.",
  toolsSetupLaunchpad: "Nastavení v Lazuriu",
  toolsSetupAgent: "Nastavení s agentem",
  toolsEnabled: "Zapnuto",
  toolsDisabled: "Vypnuto",
  toolsAlwaysOn: "Vždy zapnuto",
  toolsOrganizationOff: "{name} tu nepovoluje Organizace.",
  toolsOrganizationKept:
    "Volba zůstává uložená: až ho Organizace povolí, agenti ho začnou zase používat.",
  toolsOrganizationAllows: "Organizace ho povoluje.",
  toolsOrganizationLocked: "Nastavuje Organizace",
  toolsOrganizationLockedNamed: "Nastavuje Organizace: {name}",
  toolsOrganizationDetails: "Nastavení Organizace",
  toolsOrganizationHow:
    "Změnit to může jen Admin Organizace, v jejím nastavení.",
  toolsOrganizationFromDashboard:
    "Toto Prostředí si je každé dvě minuty načítá z Přehledu Organizace.",
  toolsOrganizationFromRepository:
    "Toto Prostředí je čte z repozitáře Organizace, který tu má.",
  toolsOrganizationVersion: "Verze {version}, použitá {time}.",
  toolsOrganizationNotApplied: "Zatím se nic nepoužilo.",
  toolsOrganizationChecked: "Naposledy ověřeno {time}.",
  toolsOrganizationNotChecked: "Zatím neověřeno.",
  toolsOrganizationUnreachable:
    "Přehled Organizace teď neodpovídá; platí naposledy použité nastavení.",
  toolsOrganizationIdentity:
    "Toto Prostředí se teď Přehledu Organizace nemůže prokázat; platí naposledy použité nastavení.",
  toolsOrganizationInvalid:
    "Nastavení Organizace je teď neplatné a musí ho opravit její Admin; platí naposledy použité nastavení.",
  toolsOrganizationRepository:
    "Repozitář Organizace se tu nepodařilo přečíst; platí naposledy použité nastavení.",
  toolsOrganizationState:
    "Záznam o naposledy použitém nastavení se nedal přečíst; ověří se znovu.",
  toolsOrganizationUnapplied:
    "Některá nastavení Organizace se tu nepodařilo použít; proč, zjistí agent.",
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
    "Dřívější změna tohoto Folderu nedoběhla. Dokončete ji v CLI příkazem lazurio profile-resume a načtěte znovu.",
  toolsBlockedOther:
    "Nic se neuložilo: tuto změnu tu teď nejde udělat. Důvod zjistí agent.",
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
  toolsUsageCatalog: "Co o tomto nástroji agentům říká Lazurio:",
  toolsNoteLabel: "Vaše poznámka pro agenty",
  toolsNoteHint:
    "Napište sem záměr, se kterým nástroj používáte. Agenti ji čtou v manual/this-machine.md tohoto Folderu; neuděluje žádný přístup.",
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
    "{name}: odhlášeno v tomto Prostředí. Poskytovatel přihlášení eviduje, dokud ho nezrušíte v nastavení účtu u něj.",
  toolsSignedOutRemote:
    "{name}: odhlášeno; propojené zařízení bylo z účtu odebráno.",
  toolsSignOutFailed:
    "{name}: odhlášení nedoběhlo. Obnovte stav a uvidíte, jak to je.",
  toolsSignOutFailedDetail: "Důvod: {reason}.",
  toolsLoginTitleInstall: "Připojit {name}",
  toolsLoginTitle: "Připojit {name}",
  toolsLoginContinue: "Pokračovat",
  toolsStepInstalling: "Instalace",
  toolsStepWaiting: "Čeká se na vás",
  toolsStepSignedIn: "Připojeno",
  toolsStepDone: "{step}: hotovo",
  toolsStepCurrent: "{step}: probíhá",
  toolsStepTodo: "{step}: následuje",
  toolsStepFailed: "{step}: nedoběhlo",
  toolsInstalling:
    "{name} se instaluje z oficiálního zdroje. Může to chvíli trvat.",
  toolsInstalledNow: "{name} {version} je nainstalovaný.",
  toolsAlreadyInstalled:
    "{name} v tomto Prostředí už funguje; nic se neměnilo.",
  toolsInstallFailed:
    "Instalace nedoběhla. Nic, co už fungovalo, se nezměnilo.",
  toolsInstallFailedDetail: "Krok {stage}: {reason}.",
  toolsInstallUnsupported:
    "Instalátor zabudovaný v Lazuriu toto Prostředí nepokrývá.",
  toolsInstallUnsupportedDetail: "Systém {platform}, architektura {arch}.",
  toolsInstallNotOnPath:
    "~/.local/bin není na PATH Lazuria, takže ho agenti nemusí najít, dokud se nepřidá do profilu shellu.",
  toolsInstallBusy:
    "Tento nástroj se už instaluje. Počkejte, až instalace skončí, a obnovte stav.",
  toolsUpdateAction: "Aktualizovat",
  toolsUpdateActionNamed: "Aktualizovat {name}",
  toolsUpdating:
    "{name} se aktualizuje na sestavení, které Lazurio používá. Může to chvíli trvat.",
  toolsUpdatedNow: "{name} {version} je nainstalovaný; přihlášení zůstává.",
  toolsUpdateFailed:
    "Aktualizace nedoběhla. Obnovte stav a uvidíte, která verze teď běží.",
  toolsUpdateFailedDetail: "Proč: {reason}",
  toolsFinishWithAgent: "Dokončit s agentem",
  toolsAgentFallback:
    "Nastavení může dokončit agent podle sepsaného cílového stavu tohoto nástroje.",
  toolsLoginStarting: "Spouštím připojení…",
  toolsLoginStartingDetail: "Obvykle to trvá pár sekund.",
  toolsLoginGhText: "Zkopírujte kód a potvrďte ho na GitHubu.",
  toolsLoginGhLink: "Otevřít GitHub",
  toolsLoginCodeLabel: "Jednorázový kód",
  toolsLoginComposioText: "Přihlaste se do Composia v prohlížeči.",
  toolsLoginComposioLink: "Otevřít Composio",
  toolsLoginQrText:
    "V telefonu otevřete WhatsApp, pak Nastavení, Propojená zařízení, Propojit zařízení, a namiřte fotoaparát na tento kód. Kód se každých pár sekund mění; tady je vždy ten nejnovější.",
  toolsLoginQrAlt:
    "QR kód, který propojí WhatsApp s tímto Prostředím. Naskenujte ho ve WhatsAppu v telefonu v Nastavení, Propojená zařízení, Propojit zařízení. Když ho naskenovat nejde, spárujte telefonním číslem níže.",
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
    "WhatsApp teď na pozadí kopíruje vaše nedávné zprávy do tohoto Prostředí. Okno můžete zavřít.",
  toolsLoginFailureNotInstalled:
    "Nástroj v tomto Prostředí není nainstalovaný. Zavřete okno a na jeho kartě zvolte Nainstalovat a přihlásit.",
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
    "Nástroj do minuty neukázal odkaz, kód ani QR kód, a proto se jeho přihlášení zastavilo. Ověřte, že se toto Prostředí dostane na internet, a zkuste to znovu; když se to zopakuje, dokončete to s agentem.",
  toolsLoginNoAnswer:
    "Lazurio včas neodpovědělo. Zkuste to znovu; když zase neodpoví, obnovte stránku.",
  toolsLoginExpired:
    "Přihlášení vypršelo dřív, než bylo dokončeno. Spusťte ho znovu, až se vám to bude hodit.",
  toolsLoginEnded:
    "Přihlášení už neběží. Když ho pořád potřebujete, spusťte ho znovu.",
  toolsLoginUnreadable:
    "Odpověď Lazuria se nepodařilo přečíst. Zavřete okno a zkuste to znovu.",
  toolsLoginTryAgain: "Zkusit znovu",
  toolsSshLinked: "SSH klíč propojený",
  toolsSshNotLinked: "SSH klíč nepropojený",
  toolsSshUnknown: "SSH klíč neověřený",
  toolsSshTeam: capitalized(teamGithubPhrase.cs),
  toolsWorksAs: capitalized(teamGithubWorksAs.cs),
  toolsLinkSshAction: "Propojit SSH klíč",
  toolsLinkSshNamed: "Propojit SSH klíč tohoto Prostředí s účtem {name}",
  toolsLoginTitleSsh: "Propojit SSH klíč: {name}",
  toolsStepLinking: "Propojení SSH klíče",
  toolsStepLinked: "SSH klíč propojený",
  toolsLoginLinking: "Připojeno. Propojuji SSH klíč tohoto Prostředí…",
  toolsLoginRefreshText:
    "Vaše přihlášení gh zatím nesmí spravovat SSH klíče vašeho účtu. Povolíte to na libovolném zařízení (tomto počítači, jiném nebo telefonu): otevřete stránku zařízení GitHubu a zadejte tento kód:",
  toolsSshLinkedDone: "Připojeno jako {account}.",
  toolsGitIdentitySet:
    "Vaše commity v tomto Prostředí ponesou jméno {name} <{email}>.",
  toolsGitIdentityCompleted:
    "Git v tomto Prostředí už zná vaše jméno i e-mail pro commity; co chybělo, doplnil z vašeho účtu GitHubu.",
  toolsGitIdentityNotSet:
    "Git v tomto Prostředí zatím nezná vaše jméno a e-mail pro commity, takže publikování změn odsud selže. Požádejte agenta, ať vaši identitu v Gitu nastaví.",
  toolsSshKeyCreated:
    "Vytvořil se nový klíč bez hesla, aby ho agenti mohli používat: {path} ({fingerprint}).",
  toolsSshKeyReused:
    "Používá se stávající klíč {path} ({fingerprint}) beze změny.",
  toolsSshNotLinkedDone:
    "gh je přihlášený jako {account}, ale SSH klíč tohoto Prostředí propojený není, takže git přes SSH zatím nefunguje.",
  toolsSshFailureNotSignedIn: "gh v tomto Prostředí není přihlášený.",
  toolsSshFailureScopeMissing:
    "Přihlášení gh nesmí spravovat SSH klíče vašeho účtu.",
  toolsSshFailureKeygenMissing:
    "V tomto Prostředí není nainstalovaný ssh-keygen.",
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
  toolsSshFailureSshMissing: "V tomto Prostředí není nainstalované ssh.",
  toolsSshFailureProofFailed:
    "Zkušební spojení s GitHubem přes SSH neodpovědělo pozdravem GitHubu.",
  toolsSshFailureProofOtherAccount:
    "GitHub přes SSH pozdravil jiný účet ({account}): toto Prostředí nabízí nejdřív jiný klíč.",
  toolsLoginFailureNotSignedIn:
    "gh v tomto Prostředí není přihlášený. Nejdřív se přihlaste; SSH klíč se propojí jako součást přihlášení.",
  toolsLoginFailureEnvironment:
    "Druh tohoto Prostředí se nepodařilo přečíst, proto se přihlášení zastavilo dřív, než by cokoli dalšího změnilo.",
  toolsSshRemoved:
    "SSH klíč tohoto Prostředí byl z vašeho účtu GitHubu odebrán; soubory klíče v tomto Prostředí zůstávají.",
  toolsSshRemovalNotRegistered:
    "SSH klíč tohoto Prostředí u vašeho účtu GitHubu registrovaný nebyl.",
  toolsSshRemovalNoKey:
    "Toto Prostředí nemá žádný SSH klíč; z GitHubu se nic neodebralo.",
  toolsSshRemovalKept:
    "SSH klíč tohoto Prostředí zůstává registrovaný u vašeho účtu GitHubu, protože ho neregistrovalo Lazurio. Odeberte ho v Nastavení GitHubu, SSH and GPG keys (github.com/settings/keys), pokud má toto Prostředí přístup ztratit.",
  toolsSshKeyFingerprint: "Otisk klíče: {fingerprint}.",
  toolsSshRemovalFailed:
    "SSH klíč tohoto Prostředí může být u vašeho účtu GitHubu pořád registrovaný: gh ho nedokázal odebrat. Odeberte ho v Nastavení GitHubu, SSH and GPG keys (github.com/settings/keys), pokud má toto Prostředí přístup ztratit.",
  toolsComposioOrgLabel: "Organizace v Composiu",
  toolsComposioOrgCurrent: "{name} (aktuální)",
  toolsComposioOrgHint:
    "Aplikace, které v Composiu napojíte, patří tomuto účtu a organizaci: účtu, který používají agenti tohoto Prostředí.",
  toolsComposioOrgSaved:
    "Organizace Composia pro toto Prostředí je teď {name}.",
  toolsComposioOrgFailed:
    "Organizaci se nepodařilo změnit. Změnit ji můžete později příkazem lazurio tools composio-org.",
  toolsComposioOrgLoading: "Načítají se vaše organizace v Composiu…",
  toolsComposioOrgUnavailable:
    "Organizace se nepodařilo načíst. Vybrat ji můžete později příkazem lazurio tools composio-org.",
  toolsComposioOrgMatches:
    "Toto Prostředí používá vaši organizaci v Composiu „{name}“, pojmenovanou stejně jako jeho Organizace.",
  toolsComposioOrgMissing:
    "Ve vašem účtu Composia chybí organizace „{name}“, pojmenovaná jako Organizace tohoto Prostředí. Dokud ji nezaložíte, připojuje se toto Prostředí v organizaci, kterou máte vybranou. Založte ji v Composiu jen pro sebe a klikněte na Zkontrolovat znovu.",
  toolsComposioOrgAmbiguous:
    "Ve vašem účtu Composia je víc organizací se jménem „{name}“. Dokud nezůstane jen jedna, připojuje se toto Prostředí v organizaci, kterou máte vybranou. Nechte jen jednu a klikněte na Zkontrolovat znovu.",
  toolsComposioOrgElsewhere:
    "Composio se nepodařilo přepnout do vaší organizace „{name}“. Klikněte na Zkontrolovat znovu.",
  toolsComposioOrgCheckAgain: "Zkontrolovat znovu",
  toolsComposioOrgUnverified:
    "Jméno Organizace tohoto Prostředí se nepodařilo přečíst, a tak nejde ověřit jeho organizaci v Composiu. Klikněte na Zkontrolovat znovu; když to nepomůže, požádejte agenta v Chatu, ať zkontroluje Folder tohoto Prostředí.",
  toolsComposioOrgPersonal:
    "V Osobním Prostředí vyberte svou výchozí organizaci, tu, kterou Composio založilo při vaší registraci.",
  toolsPromptTitle: "Připojit {name} s pomocí agenta",
  toolsPromptHint:
    "Zkopírujte tento prompt a vložte ho do nového chatu v T3 Code v tomto Prostředí. Agent nástroj nainstaluje a provede vás přihlášením v prohlížeči. Žádný API klíč nikdy nekopírujete.",
  toolsPromptLabel: "Připravený prompt",
  toolsCopy: "Zkopírovat prompt",
  toolsCopied: "Zkopírováno.",
  toolsCopyFailed:
    "Kopírování tady není dostupné. Text je označený; zkopírujte ho klávesnicí.",
  toolsClose: "Zavřít",
  toolsMcpTitle: "Vlastní MCP server",
  toolsMcpText:
    "Vlastní MCP servery přidáte v Apps → Integrace → Vlastní; agent ho přidá na váš výslovný pokyn.",
  toolsMcpAction: "Přidat s agentem",
  toolsMcpPromptHint:
    "Zkopírujte tento prompt a vložte ho do nového chatu v T3 Code v tomto Prostředí. Agent se zeptá, který server chcete, a přidá ho do Executoru tohoto Prostředí; klíč pak zadáte v Integracích.",
  // The Apps home and its left column (decision F36).
  appsTitle: "Apps",
  appsAll: "Všechny moduly",
  appsPersonal: "Osobní",
  appsOrganizationDashboard: "Přehled Organizace",
  appsModulesOne: "{count} modul",
  appsModulesFew: "{count} moduly",
  appsModulesMany: "{count} modulů",
  // An Owner's Workspace before its first module (#376).
  appsModulesNone: "zatím žádné moduly",
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
    "Lazurio log zatím neukazuje. Jeho poslední řádky přečtete v příkazové řádce tohoto Prostředí:",
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
  appsDescriptionDashboard:
    "Přehled Organizace, výsledků a důležitých ukazatelů.",
  appsDescriptionProfitability: "Marže, náklady a finanční zdraví zakázek.",
  appsDescriptionMarketing: "Marketingové aktivity, kampaně a podklady.",
  appsDescriptionWebsite: "Webový obsah, stránky a veřejná prezentace.",
  appsDescriptionExamples: "Ukázky, vzory a referenční řešení.",
  appsDescriptionDatabase: "Data, záznamy a jejich bezpečná správa.",
  appsDescriptionApp: "Pracovní podklady a soubory tohoto modulu.",
  appsDescriptionSystem: "Provozní nástroje a technické zázemí.",
  appsDescriptionDefault: "Aplikace pro každodenní práci v modulu {module}.",
  // The personal space's links after its modules (root decision 0185's
  // addendum of 2026-10-13); the names are the switch's and the column's.
  appsStartsTitle: "Co dalšího tu můžete dělat",
  appsStartsChat: "Zadejte agentovi první úkol",
  appsStartsAutomate: "Nastavte, co se má dít samo",
  appsStartsIntegrations: "Připojte poštu a kalendář",
  appsStartsFiles: "Nahrajte podklady pro agenty",
  // The Apps home and column of the Organization rail (decision F36
  // addendum of 2026-10-04): the wireframe's words.
  appsSayNoApp: "Modul {name} zatím nemá aplikaci.",
  appsSayCannotStart: "Aplikace modulu {name} teď nejde spustit.",
  appsSayRepository: "Repozitář {name} nemá aplikaci.",
  appsMore: "Další volby pro {name}",
  appsFavorites: "Oblíbené",
  appsFavoritesLoading: "Načítání oblíbených…",
  appsFavoritesHint: "Hvězdičkou u modulu si ho připnete sem.",
  appsFavoriteAdd: "Přidat do oblíbených",
  appsFavoriteRemove: "Odebrat z oblíbených",
  appsFavoriteMark: "V oblíbených",
  appsFavoriteFailed: "Oblíbené se nepodařilo uložit. Zkuste to znovu.",
  appsModuleAccess: "Přístup k modulu",
  appsInfoModule: "Informace o modulu",
  appsInfoRepository: "Informace o repozitáři",
  appsNewModule: "Nový modul",
  appsNewModuleSub: "Vytvořit s agentem",
  appsNewModuleOpened:
    "Chat se otevírá v nové záložce se zadáním nového modulu v poli zprávy, neodeslaným.",
  appsNewModuleCopied:
    "Zadání nového modulu je ve schránce: vložte ho v Chatu do nového vlákna.",
  appsNewModuleCopyFailed:
    "Zadání se nepodařilo zkopírovat; otevřete Chat a popište agentovi nový modul.",
  appsNewModulePrompt:
    "Chci postavit nový modul do Workspace Lazuria.\nBude v Organizaci {name} (GitHub {login}).\n\nPoužij skill `new-module`. Nejdřív se mě vyptej, k čemu modul bude a co mi má vyřešit, technické věci zvol sám a než začneš stavět, ukaž mi plán k potvrzení.",
  // The personal space's "+ Nový modul" (root decision 0185's addendum of
  // 2026-10-13); in Czech the person's own words, so tykání (0199).
  appsNewPersonalModulePrompt:
    "Chci postavit nový modul do Workspace Lazuria.\nBude v mém osobním prostoru, jako soukromý repozitář na mém GitHub účtu {login}.\n\nPoužij skill `new-module`. Nejdřív se mě vyptej, k čemu modul bude a co mi má vyřešit, technické věci zvol sám a než začneš stavět, ukaž mi plán k potvrzení.",
  appsGuide: "Guide",
  appsMarketplace: "Marketplace",
  appsSoon: "již brzy",
  appsMarketplaceSoon: "Již brzy",
  appsMarketplaceText:
    "Tady si do Prostředí budete přidávat další moduly. Připravujeme to.",
  appsMarketplaceOrganization:
    " Do té doby přibývají moduly v Přehledu Organizace {name}.",
  title: "Lazurio",
  homeTitle: "Apps",
  catalogBreadcrumb: "Kde v Lazuriu jste",
  catalogLoading: "Načítám Organizace…",
  catalogLoadFailed:
    "Organizace nelze načíst. Zkuste Načíst znovu; když to nepomůže, spusťte v CLI lazurio organization list.",
  catalogEmpty: "V tomto Prostředí zatím nejsou žádné aplikace.",
  catalogNotFound:
    "Tato Organizace nebo modul v tomto Folderu není. Možná byl přejmenován nebo odstraněn; podívejte se na všechny Organizace.",
  chat: "Chat",
  mausbot: "Lazurio MausBot",
  catalogModules: "Moduly",
  catalogNoModules:
    "Zatím tu nemáte žádné moduly. O přístup požádejte Admina Organizace.",
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
    "Jiná složka v tomto Folderu deklaruje stejnou Organizaci.",
  catalogReasonPersonalspaceAmbiguous:
    "V personalspace/ je víc než jedna složka; smí tam být jen ta Operátorova a žádná se nečte, dokud nezůstane jediná.",
  catalogReasonPersonalspaceUnavailable:
    "Personalspace nelze přečíst: jeho složky musí být skutečné složky, které vlastníte.",
  catalogReasonPersonalspaceForeign:
    "V personalspace/ je checkout, který není osobním prostorem účtu GitHub přihlášeného v tomto Prostředí. Proto se nečte a žádná jeho aplikace se nespustí. Zůstal, jak byl.",
  catalogReasonPersonalspaceNotOwned:
    "GitHub tento osobní prostor nezná jako repozitář účtu přihlášeného v tomto Prostředí, proto se nečte.",
  catalogReasonPersonalspacePublic:
    "Repozitář tohoto osobního prostoru je na GitHubu veřejný. Osobní prostor musí být soukromý, proto se nečte, dokud jím nebude.",
  catalogReasonGithubSignedOut:
    "GitHub tu není přihlášený, proto nejde ověřit, že je tento osobní prostor váš. Přihlaste GitHub v Nastavení → Nástroje.",
  catalogReasonGithubUnavailable:
    "GitHub neodpověděl, proto teď nejde ověřit, že je tento osobní prostor váš. Ověří se znovu, jakmile GitHub odpoví.",
  catalogReasonGithubIdentityMismatch:
    "GitHub je tu přihlášený jiným účtem, než má vlastník tohoto Prostředí, proto se osobní prostor nečte.",
  catalogReasonPersonalspaceUnverified:
    "Ověřujeme na GitHubu, že je tento osobní prostor váš…",
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
    "{file} patří jinému účtu v tomto Prostředí, takže to není soubor vašeho vlastního checkoutu. Vraťte ho do svého vlastnictví (například chown) nebo ho znovu checkoutněte.",
  catalogReasonDeclarationTooLarge:
    "{file} je větší, než smí soubor checkoutu být (1 MiB; 16 MiB pro lockfile).",
  catalogReasonDirectoryNotRegular:
    "{file} není skutečná složka (například je to symlink); Lazurio čte checkout jen přes jeho vlastní složky.",
  catalogReasonDirectoryOwner:
    "Složka {file} patří jinému účtu v tomto Prostředí, takže to není váš vlastní checkout. Vraťte ji do svého vlastnictví (například chown) nebo ji znovu checkoutněte.",
  preparationReasonOwnerInvalid:
    "{file} nemůže tuto aplikaci připravit: chybí, není to balíček, nebo aplikace není deklarovaným členem jeho workspace.",
  preparationReasonScriptMissing:
    "Příprava deklarovaná v aplikaci jmenuje skript, který {file} nemá.",
  preparationReasonLockfileMissing:
    "Vedle {file} není Bun lockfile (bun.lock), takže jeho závislosti nejde nainstalovat přesně. Commitněte lockfile spolu s aplikací.",
  preparationReasonLockfileAmbiguous:
    "Vedle {file} je bun.lock i bun.lockb; nechte jen ten, ze kterého Bun instaluje.",
  preparationReasonLockfileUnused:
    "{file} leží vedle balíčku, který nedeklaruje nic k instalaci: takový balíček lockfile nepotřebuje a Bun pro něj žádný nedrží, takže tento tu zůstal navíc. Odstraňte ho z modulu, nebo deklarujte závislosti, které zamyká.",
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
  moduleReasonRequiredSlotUndeclared:
    "Aplikace potřebuje {file}, který manifest Organizace nedeklaruje, proto nebyla spuštěna. Opravte required_module_slots aplikace nebo manifest Organizace.",
  moduleReasonRequiredSlotPlanned:
    "Aplikace potřebuje {file}, který manifest Organizace vede jako plánovaný, proto v tomto Prostředí zatím spustit nejde.",
  moduleReasonRequiredSlotMissing:
    "Aplikace potřebuje {file}, který v tomto Prostředí vedle ní není, proto nebyla spuštěna. Synchronizujte Organizaci nebo si požádejte o přístup k tomu modulu a spusťte ji znovu.",
  moduleReasonRuntimeSecretUnavailable:
    "Aplikace nebyla spuštěna: potřebuje tajné údaje, které jí trezor tohoto Prostředí nedal. {secrets}. Hodnoty se nikdy nezobrazují; v trezoru Prostředí přidejte nebo opravte položku pojmenovanou přesně jako ten údaj a spusťte ji znovu.",
  moduleSecretsNotProvided:
    "Spuštěno bez těchto volitelných tajných údajů, takže schopnosti, které je potřebují, jsou vypnuté: {secrets}.",
  runtimeSecretPersonalspace:
    "aplikace z Personalspace čte tajné údaje jen v Osobním Prostředí svého člověka",
  runtimeSecretPersonalEnvironment:
    "trezor Osobního Prostředí slouží jen aplikacím z Personalspace",
  runtimeSecretWorkstation: "tento počítač zatím trezor Prostředí nemá",
  runtimeSecretNoVaultIdentity: "toto Prostředí zatím trezor nemá",
  runtimeSecretOtherOrganization:
    "aplikace patří jiné Organizaci, než která vlastní toto Prostředí a jeho trezor",
  runtimeSecretNotConnected:
    "trezor ještě není nastavený (Nastavení → Nástroje → bitwarden)",
  runtimeSecretLocked: "trezor se nepodařilo odemknout",
  runtimeSecretBusy: "trezor je právě zaneprázdněný; zkuste to znovu",
  runtimeSecretUnreachable: "trezor není dostupný",
  runtimeSecretVaultFailed: "trezor neodpověděl tak, jak má",
  runtimeSecretMissing: "v trezoru Prostředí není položka tohoto názvu",
  runtimeSecretAmbiguous: "v trezoru Prostředí je víc položek tohoto názvu",
  runtimeSecretEmpty: "jeho položka nemá heslo",
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
    "Běží dál i po restartu Lazuria; restart Prostředí ji ukončí.",
  moduleSessionBound: "Skončí spolu s Lazuriem.",
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
    "Bez odkazu: zaznamenaný vstup tohoto Prostředí zatím neuvádí hostname pro moduly.",
  moduleNoLinkApp:
    "Bez odkazu: gateway tohoto Prostředí obsluhuje jen výchozí aplikaci modulu.",
  moduleNoLinkBrowser: "Bez odkazu: aplikace nedeklaruje vstup pro prohlížeč.",
  moduleNoLink: "Bez odkazu: {reason}.",
  recoveryTitle: "Obnova",
  recoveryModeTitle: "Lazurio je v režimu obnovy (Recovery mode)",
  recoveryModeText:
    "Nepodařilo se ho normálně spustit, a tak ukazuje jen tuto stránku. T3 Code, vaše nástroje, Folder i repozitáře fungují dál.",
  recoveryCheckLabel: "Kontrola",
  recoveryReasonLabel: "Důvod",
  recoveryReasonFolderStateUnreadable:
    "Tato verze nedokáže přečíst Folder nebo jeho stav: nepatří vašemu účtu, nebo obsahuje položky, klíče či schéma, které tato verze nezná.",
  recoveryReasonFolderTransactionPending:
    "Změna profilu nebo nástrojů ve Folderu byla přerušena a není dokončená.",
  recoveryReasonFolderLockUnavailable: "Zámek operací Folderu nejde získat.",
  recoveryReasonHostedEntryInvalid:
    "Hostovaný vstup zaznamenaný ve Folderu tato verze nepřijímá.",
  recoveryReasonAssetMissing:
    "Stránka, kterou tento program nese, se neservíruje celá.",
  recoveryReasonUnknown: "Důvod, který tato stránka nezná.",
  recoveryLoading: "Kontroluji…",
  recoveryAgain: "Zkontrolovat znovu",
  recoveryLoadFailed:
    "Výsledek kontroly tady nejde načíst. Agent v tomto Prostředí může spustit lazurio recover.",
  recoveryHealthy: "Lazurio v tomto Prostředí je v pořádku.",
  recoveryBroken: "Lazurio v tomto Prostředí potřebuje opravu.",
  recoveryNotInstalled:
    "Lazurio v tomto Prostředí není nainstalované; není co kontrolovat.",
  recoveryChecksTitle: "Kontroly",
  recoveryOutcomeOk: "v pořádku",
  recoveryOutcomeFailed: "selhala",
  recoveryOutcomeSkipped: "přeskočena",
  recoveryEvidenceTitle: "Důkazy",
  recoveryEvidenceText:
    "Jen sanitizovaná strukturovaná pole, přesně jak je nese připravené issue.",
  recoveryJournalShow: "Zobrazit journal (zůstává v tomto Prostředí)",
  recoveryJournalHide: "Skrýt journal",
  recoveryJournalText:
    "Sanitizovaný konec journalu Lazuria. Nikdy automaticky neopouští toto Prostředí.",
  recoveryPromptTitle: "Opravný agent",
  recoveryPromptText:
    "Zkopírujte prompt a vložte ho do nového chatu své agentní aplikace v tomto Prostředí (v Prostředí na serveru do T3 Code). Agent opraví Lazurio směrem dopředu, nebo závadu zapíše na GitHub.",
  recoveryPromptCopy: "Zkopírovat prompt",
  recoveryPromptOpenT3: "Otevřít T3 Code",
  recoveryIssueTitle: "Připravené issue",
  recoveryIssueText:
    "Pro veřejný repozitář {repository}. Opravný agent ho založí, až ověří, že neexistuje duplicita.",
  recoveryIssueCopy: "Zkopírovat příkaz gh",
  recoveryIssueLink: "Otevřít předvyplněné issue v prohlížeči",
  recoveryIssueLinkPaste:
    "Otevřít formulář issue v prohlížeči (tělo do něj vložte)",
  recoveryIssueRefused:
    "Tělo issue se nepřipravilo: po sanitizaci v něm zůstalo {kinds}. Nic nesmí toto Prostředí opustit automaticky.",
  recoveryNothingFiled:
    "Nic nebylo odesláno. Tato stránka issue jen připraví; nic automaticky neopouští toto Prostředí.",
  settingsTitle: "Nastavení",
  settingsGeneral: "Obecné",
  settingsBack: "Zpět",
  settingsBreadcrumb: "Kde v nastavení jste",
  navigationOpen: "Otevřít navigaci",
  technicalDetails: "Technické podrobnosti",
  presetHint:
    "Druh Prostředí, pro který je tento Folder nastavený. Nabízejí se jen presety, které dovoluje jeho handover.",
  localeHint:
    "Jazyk této stránky a instrukcí pro agenty v tomto Folderu. Změní se, až změnu použijete.",
  detailHint:
    "Jak agenti vysvětlují svou práci: stručně, nebo s technickým vysvětlením a důkazy.",
  coordinationHint:
    "Zda agenti pracují přímo, nebo delegují v rozsahu zadání a výsledek ověří.",
  profileHint:
    "Náhled ukáže, co by se v tomto Folderu změnilo; nic se nezapíše, dokud změnu nepoužijete.",
  toolsDetails: "Podrobnosti",
  toolsDetailsNamed: "Podrobnosti o {name}",
  toolsPathLabel: "Umístění",
  legend: "Profil Prostředí",
  machineTitle: "Toto Prostředí",
  machineKind: "Druh",
  machineName: "Technický název",
  machineOwner: "Owner",
  machineTeam: "Team",
  machineAssignment: "Přiřazení",
  machineAssignmentTeam: "Týmové",
  machineAssignmentAutomation:
    "Automatizované Prostředí persony Organizace; odpovědný operátor {operator}",
  machineTailnet: "Uzel tailnetu",
  machineHost: "Host",
  machineRelationships: "Vztahy (vynucuje Headscale, ne tato stránka)",
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
    "Složka Dokumenty tohoto Prostředí. Agenti sem ukládají hotové soubory; stáhněte si je, nebo sem nahrajte soubory pro agenty.",
  filesShared:
    "Toto Prostředí je sdílené: celý Team vidí a mění stejnou složku.",
  filesRoot: "Dokumenty",
  filesPath: "Cesta ke složce",
  filesUpload: "Nahrát soubory",
  filesZip: "Stáhnout složku (ZIP)",
  filesRefresh: "Načíst znovu",
  filesLoading: "Načítám složku…",
  filesLoadFailed: "Složku se nepodařilo načíst. Zkuste Načíst znovu.",
  filesUnavailable:
    "Složku Dokumenty tohoto Prostředí nejde použít: není to složka, nebo je to link na domovskou složku či Lazurio Folder. Na požádání to opraví agent.",
  filesEmpty: "Tato složka je prázdná.",
  filesEmptyRoot:
    "Toto je složka Dokumenty vašeho Prostředí. Agenti sem ukládají hotové soubory a dorazí sem i soubory, které nahrajete. Zatím tu nic není.",
  filesNotFound: "Tato složka nebo soubor neexistuje.",
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
  filesUploadDiskFull: "V tomto Prostředí není dost volného místa.",
  filesUploadIncomplete: "Nahrávání se přerušilo. Zkuste to znovu.",
  filesUploadName:
    "Toto jméno tu použít nejde. Soubor přejmenujte a zkuste to znovu.",
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
  tourLabel: "Prohlídka Prostředí",
  tourGearTitle: "Nejdřív připojte GitHub",
  tourGearText: "Bez něj tu nic nefunguje.",
  tourSettingsToolsTitle: "Tady se připojují služby",
  tourGithubTitle: "Připojte GitHub",
  tourGithubText: "Uvidíte své moduly a agenti budou pracovat za vás.",
  tourComposioTitle: "Připojte své aplikace",
  tourComposioText: "Pošta, kalendář, Slack. Klidně až později.",
  tourGearPersonalTitle: "Ještě připravte osobní prostor",
  tourPersonalText: "Místo pro vaše vlastní věci.",
  tourGearOrganizationTitle: "Ještě stáhněte {name}",
  tourOrganizationText: "Pak tu uvidíte její moduly.",
  tourOrganization: "Organizaci",
  tourSettingsEnvironmentTitle: "Obsah Prostředí je tady",
  tourPrepareFailedTitle: "Něco se nepovedlo",
  tourPrepareFailedText: "Zkuste to znovu, nebo to vyřeší agent v Chatu.",
  tourPreparePersonalTitle: "Připravte osobní prostor",
  tourPrepareOrganizationTitle: "Stáhněte {name}",
  tourAppsTitle: "Apps",
  tourAppsText: "Tady otevíráte aplikace svých modulů.",
  tourChatTitle: "Chat",
  tourChatText: "Tady zadáváte práci agentům.",
  tourChatMissingText: "Práce pro agenty. Tady zatím neběží.",
  tourAutomateTitle: "Automate",
  tourAutomateText: "Tady nastavíte, co se má dít samo.",
  tourAutomateMissingText: "Co se má dít samo. Tady zatím neběží.",
  tourSettingsTitle: "Nastavení je vždycky tady",
  tourNext: "Další",
  tourDone: "Hotovo",
  tourNotNow: "Teď ne",
  tourQuit: "Ukončit",
  contentTitle: "Obsah Prostředí",
  contentPersonalspace: "Osobní prostor",
  contentAbsent: "Ještě tu není",
  contentPresent: "Připraveno",
  contentRunning: "Stahuji…",
  contentWaiting: "Na řadě",
  contentStopped: "Zastavilo se",
  contentBlocked: "Teď to připravit nejde",
  contentDownloadAll: "Stáhnout vše",
  contentNeedsGithub: "Nejdřív připojte GitHub v Nástrojích.",
  contentNotAllowed: "Tady se obsah připravit nedá.",
  contentRefused: "Tady to připravit nejde.",
  contentStartFailed: "Přípravu se nepodařilo spustit. Zkuste to znovu.",
  contentLost: "Průběh přípravy se nepodařilo zjistit.",
  contentAgentFixes: "Agent v Chatu to opraví.",
  contentDetails: "Podrobnosti",
  contentStepAccess: "Ověřuji přístup",
  contentStepRoot: "Stahuji Organizaci",
  contentStepModules: "Stahuji moduly",
  contentStepPreparation: "Instaluji",
  contentStepCheck: "Kontroluji",
  contentStepFind: "Hledám váš osobní prostor",
  contentStepCreate: "Zakládám",
  contentStepClone: "Stahuji",
  contentStepBootstrap: "Nastavuji",
  contentStepPush: "Ukládám na GitHub",
  contentStepOther: "Připravuji",
  contentFailedAccess: "Přístup k Organizaci se nepodařilo ověřit.",
  contentFailedRoot: "Organizaci se nepodařilo stáhnout.",
  contentFailedModules: "Moduly se nepodařilo stáhnout.",
  contentFailedPreparation: "Moduly se nepodařilo nainstalovat.",
  contentFailedCheck: "Kontrola po přípravě neprošla.",
  contentFailedFind: "Osobní prostor se nepodařilo najít.",
  contentFailedCreate: "Osobní prostor se nepodařilo založit.",
  contentFailedClone: "Osobní prostor se nepodařilo stáhnout.",
  contentFailedBootstrap: "Osobní prostor se nepodařilo nastavit.",
  contentFailedPush:
    "Nastavení osobního prostoru se nepodařilo uložit na GitHub.",
  contentFailedOther: "Příprava se nedokončila.",
  contentResolveOpened:
    "Chat se otevírá v nové záložce se zadáním v poli zprávy, neodeslaným.",
  contentResolveCopied:
    "Zadání je ve schránce: vložte ho v Chatu do nového vlákna.",
  contentResolveCopyFailed:
    "Zadání se nepodařilo zkopírovat; otevřete Chat a řekněte agentovi, co se zastavilo.",
  preparePromptWhatPersonal:
    "Příprava mého osobního prostoru (Personalspace) v tomto Prostředí",
  preparePromptWhatOrganization:
    "Příprava Organizace {name} (GitHub {login}) v tomto Prostředí",
  preparePromptStoppedAt: "{what} se zastavila u kroku „{step}“:",
  preparePromptStopped: "{what} se zastavila.",
  preparePromptBody:
    "Dotáhni prosím instalaci se vším všudy:\n1. Zjisti příčinu chyby a oprav ji v tomto Prostředí.\n2. Dokonči přípravu stejným příkazem, jaký spouští Lazurio: `{command}`.\n3. Ověř výsledek: `lazurio doctor`, a u modulů, které mají testy, jejich testy.\n4. Řekni mi stručně, co bylo špatně, co jsi udělal a co jsi ověřil. Kdyby oprava potřebovala změnu mimo toto Prostředí (třeba v repozitáři), nejdřív se zeptej.",
  toolsDescriptionGh:
    "Připojení na GitHub, kde jsou uložené vaše moduly. Bez něj tu nic nefunguje.",
  toolsDescriptionComposio:
    "Snadná cesta k mnoha aplikacím přes Composio, s vaším vlastním účtem. Aplikace připojíte v Apps → Integrace.",
  toolsDescriptionWacli:
    "Připojení na WhatsApp: agenti čtou a posílají vaše zprávy.",
  toolsDescriptionGogcli:
    "Připojení na Google: Gmail, Kalendář a Disk, když nechcete Composio.",
  toolsDescriptionNeon:
    "Připojení na databáze Neon, hlavně pro vývoj aplikací.",
  toolsDescriptionBitwarden: "Hesla a další položky pro agenty.",
  toolsDescriptionExecutor:
    "Přes něj agenti používají aplikace připojené přímo z tohoto Prostředí. Instaluje ho a udržuje v chodu Lazurio.",
  toolsNotOffered: "V tomto Prostředí se nenabízí; agenti ho nepoužívají.",
  vaultRowChecking: "Zjišťuji stav…",
  vaultRowConnected: "Připojeno",
  vaultRowNotSetUp: "Zatím nenastaveno",
  vaultRowCreating: "Trezor se zakládá",
  vaultRowNotAllowed: "Síť zatím účet trezoru nepovolila",
  vaultRowRemoved: "Trezor byl odebrán",
  vaultRowRevoked: "Přístup odebrán v trezoru",
  vaultRowUnreachable: "Trezor neodpovídá",
  vaultRowFailed: "Nastavení se nedokončilo",
  vaultRowNoVault: "Toto Prostředí zatím trezor nemá",
  vaultRowSecondWave: "Brzy · druhá vlna",
  vaultRowUnavailable: "V tomto Prostředí není k dispozici",
  vaultPhaseInstall: "Instaluje se Bitwarden…",
  vaultPhaseAccount: "Připravuje se účet trezoru…",
  vaultPhaseVault: "Připravuje se trezor…",
  vaultPhaseSignIn: "Přihlašuje se…",
  vaultActionSetUp: "Nastavit",
  vaultActionRetry: "Zkusit znovu",
  vaultActionNamed: "{action}: bitwarden",
  vaultOpen: "Otevřít trezor",
  vaultLoadFailed: "Stav trezoru se nepodařilo přečíst.",
  vaultPageTitle: "Trezor",
  vaultPageRule: "Kdo má přístup do Prostředí, má všechna jeho hesla.",
  vaultPageWorkstation: "Trezor na tomto počítači zatím není.",
  vaultPageNoVault: "Toto Prostředí zatím trezor nemá.",
  vaultPageAgentsOnly:
    "Trezor tohoto Prostředí zatím používají jen jeho agenti.",
  vaultPageCreating: "Zakládání trezoru…",
  vaultPageUnreachable: "Neodpovídá",
  vaultPageItemsOne: "{count} položka",
  vaultPageItemsFew: "{count} položky",
  vaultPageItemsMany: "{count} položek",
  vaultPageAddItem: "Přidat položku",
  vaultPageOpen: "Otevřít trezor",
  vaultPageCreateAccount: "Vytvořit účet v trezoru",
  vaultRequestsTitle: "Žádosti agentů",
  vaultRequestTitle: "Žádost agenta",
  vaultRequestAnswer: "Zadat",
  vaultRequestAnd: "a",
  vaultRequestItem: "Uloží se do trezoru Prostředí jako položka {item}.",
  vaultRequestSave: "Uložit do trezoru",
  vaultRequestDecline: "Odmítnout",
  vaultRequestShow: "Zobrazit",
  vaultRequestHide: "Skrýt",
  vaultRequestSaving: "Ukládá se…",
  vaultRequestSaved: "Uloženo do trezoru.",
  vaultRequestDeclined: "Odmítnuto.",
  vaultRequestMissing: "Žádost neexistuje.",
  vaultRequestNoVault: "Toto Prostředí zatím trezor nemá.",
  vaultRequestNotReady: "Trezor Prostředí zatím není připravený.",
  vaultRequestFill: "Vyplňte všechna pole.",
  vaultRequestBusy: "Trezor teď neodpovídá. Zkuste to prosím za chvíli.",
  vaultRequestFailed: "Uložení se nepodařilo. Zkuste to znovu.",
  vaultRequestLoadFailed: "Žádost se nepodařilo načíst.",
  executorRowChecking: "Zjišťuji stav…",
  executorRowRunning: "Běží",
  executorRowNotInstalled: "Není nainstalovaný",
  executorRowOutdated: "Čeká na aktualizaci",
  executorRowNotRunning: "Neběží",
  executorRowIncomplete: "Běží, nastavení není dokončené",
  executorRowConflict: "Koliduje s jinou instalací",
  executorRowSecondWave: "Brzy · druhá vlna",
  executorRowUnavailable: "V tomto Prostředí není k dispozici",
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
  executorAddressLocal: "{address} (jen toto Prostředí)",
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
    "Úkol: v tomto Prostředí koliduje Executor Lazuria s jinou instalací. Příkazem `lazurio executor status --json` zjisti, co koliduje: `entry` je `~/.local/bin/executor`, `agents` MCP server jménem `executor` v Codexu nebo Claude Code. Ukaž Operátorovi, co tam je, a jen s jeho souhlasem to odstraň nebo přejmenuj; pak spusť `lazurio executor setup --json` a ověř, že hlásí `running`. Nic dalšího neměň.",
  toolsNotAdded: "Ještě není přidané",
  toolsLoginTitleGh: "Připojit GitHub",
  toolsLoginTitleComposio: "Připojit aplikace",
  toolsLoginCopyCode: "Kopírovat",
  toolsLoginCodeCopied: "Zkopírováno",
  toolsLoginGhHint: "Platí 15 minut, klidně z telefonu.",
  toolsLoginDone: "Hotovo",
  toolsInstallLabel: "Instalace",
  machineBelongs: "Patří",
  machineBelongsYou: "vám (@{login})",
  machineWorks: "Pracuje v něm",
  machineWorksTeam: "Team {team}",
  machineWorksAutomation: "automatizace, odpovídá @{login}",
  machineKindPersonal: "Osobní Prostředí",
  machineKindWork: "Pracovní Prostředí",
  machineKindTeam: "Týmové Prostředí",
  machineKindAutomated: "Automatizované Prostředí",
  machineKindWorkstation: "Váš počítač",
  machineTechnicalKind: "Technický druh",
  machineSupport: "Pro podporu",
  browserToggle: "Prohlížeč",
  browserTitle: "Prohlížeč Prostředí",
  browserReload: "Načíst znovu",
  browserOpenTab: "Otevřít samostatně",
  browserTabClose: "Zavřít",
  browserTabCloseOthers: "Zavřít ostatní",
  browserTabCloseRight: "Zavřít vpravo",
  browserClose: "Zavřít",
  browserFrame: "Záložka prohlížeče Prostředí",
  browserFailed: "Tuto záložku prohlížeče Prostředí tu nejde zobrazit.",
  browserWidth: "Šířka prohlížeče",
  dividerHint: "Táhněte pro změnu šířky, dvojklik vrátí výchozí",
  columnHide: "Skrýt navigaci",
  columnShow: "Zobrazit navigaci",
  columnWidth: "Šířka navigace",
  integrationsTitle: "Integrace",
  integrationsSubtitle:
    "Co tu připojíte, používají všichni agenti a boti tohoto Prostředí.",
  integrationsHelp: "Jak to funguje",
  integrationsSearch: "Hledat aplikace",
  integrationsRefresh: "Zkontrolovat připojení",
  integrationsTabsLabel: "Zobrazit",
  integrationsTabAll: "Vše",
  integrationsTabConnected: "Připojené",
  integrationsTabCustom: "Vlastní",
  integrationsAvailable: "Dostupné aplikace · {count}",
  integrationsYours: "Vaše připojení",
  integrationsResults: "Výsledky hledání",
  integrationsLoading: "Načítám Integrace…",
  integrationsChecking: "Kontroluji připojení…",
  integrationsLoadFailed: "Integrace se nepodařilo načíst.",
  integrationsNoneConnected: "Zatím žádné připojené aplikace.",
  integrationsPick: "Vybrat aplikaci",
  integrationsNoneFound: "Žádné aplikace jsme nenašli.",
  integrationsShowAll: "Zobrazit všech {count} aplikací",
  integrationsPopupBlocked:
    "Prohlížeč zablokoval okno s připojením. Povolte vyskakovací okna a zkuste to znovu.",
  integrationsExecutorUnavailable:
    "Executor v tomto Prostředí teď neběží, takže nic nejde připojit přímo.",
  integrationsExecutorAbsent:
    "Toto Prostředí nemá Executor, aplikace se tu proto připojují přes Composio nebo svým nástrojem.",
  integrationsExecutorUnreadable:
    "Executor odpověděl nečekaně, přímá připojení se nepodařilo načíst.",
  integrationsComposioUnreadable:
    "Připojení přes Composio se nepodařilo načíst.",
  integrationsComposioOrganizationMissing:
    "Ve vašem účtu Composia chybí organizace „{name}“. Toto Prostředí patří Organizaci {name} a má se přes Composio připojovat ve vaší vlastní organizaci stejného jména; dokud ji nezaložíte, připojuje se v organizaci, kterou máte vybranou. Založte ji v Composiu a klikněte na Zkontrolovat připojení.",
  integrationsComposioOrganizationAmbiguous:
    "Ve vašem účtu Composia je víc organizací se jménem „{name}“. Dokud nezůstane jen jedna, připojuje se toto Prostředí v organizaci, kterou máte vybranou. Nechte jen jednu a klikněte na Zkontrolovat připojení.",
  integrationsComposioOrganizationElsewhere:
    "Composio se nepodařilo přepnout do vaší organizace „{name}“, a tak se přes něj teď nic nepřipojí. Klikněte na Zkontrolovat připojení a zkuste to znovu.",
  integrationsComposioOrganizationUnverified:
    "Jméno Organizace tohoto Prostředí se nepodařilo přečíst, a tak nejde ověřit jeho organizaci v Composiu a přes Composio se teď nic nepřipojí. Klikněte na Zkontrolovat připojení; když to nepomůže, požádejte agenta v Chatu, ať zkontroluje Folder tohoto Prostředí.",
  integrationsComposioOpen: "Otevřít Composio",
  integrationsComposioApps: "Aplikace v Composiu",
  integrationsComposioMissing: "Aplikaci tu nenajdete?",
  integrationsComposioConnectThere: "Připojte ji v Composiu",
  integrationsOutsideCatalog: "Z Composia, mimo katalog Lazuria.",
  integrationsComposioOrganizationChanged:
    "Composio teď nepracuje v organizaci tohoto Prostředí. Klikněte na Zkontrolovat připojení.",
  composioModelTitle: "Jak toto Prostředí používá Composio",
  composioModelAccount: "Váš účet Composia",
  composioModelAccountNote: "přihlášení přes GitHub",
  composioModelOrganization: "organizace „{name}“",
  composioModelOthers: "organizace pro každou vaši další Organizaci",
  composioModelDefault: "vaše výchozí organizace",
  composioModelEnvironments: "Prostředí Organizace {name}",
  composioModelOtherEnvironments: "jejich Prostředí",
  composioModelPersonal: "vaše Osobní Prostředí",
  composioModelCaption:
    "Do svých organizací nikoho nezvete a žádný klíč nesdílíte.",
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
  integrationsFinishInBrowser: "Dokončete připojení v prohlížeči",
  integrationsFinishInEnvironment:
    "Dokončete přihlášení v prohlížeči Prostředí vpravo.",
  integrationsWaiting: "Čekám na přihlášení…",
  integrationsConnectedNow: "Připojeno: {app}.",
  integrationsReturnTitle: "Přihlášení",
  integrationsReturnConnected:
    "Připojeno: {app}. Toto okno můžete zavřít a vrátit se do Lazuria.",
  integrationsReturnFailed:
    "Přihlášení k aplikaci {app} se nepodařilo dokončit. Vraťte se do Lazuria a zkuste to znovu.",
  integrationsReturnPending:
    "Přihlášení k aplikaci {app} se dokončuje. Jak dopadlo, uvidíte v Lazuriu; toto okno můžete zavřít.",
  integrationsReturnUnknown:
    "Toto přihlášení už neplatí. Spusťte připojení znovu v Lazuriu.",
  integrationsConnectFailed: "Připojení se nepodařilo spustit.",
  integrationsIntegrationConflict:
    "V Executoru je pod jménem této aplikace jiný server. Najdete ho ve Vlastní: odeberte ho tam a aplikaci připojte znovu.",
  integrationsStillFailing:
    "Pořád to nefunguje: Executor tento účet použít neumí. Zkuste to později, nebo účet odpojte.",
  integrationsConnectEnded: "Připojení se nedokončilo.",
  integrationsNameTaken: "Tento název už má jiný účet aplikace.",
  integrationsAccountUnnamed: "účet",
  integrationsAccountExpired: "Přihlášení vypršelo",
  integrationsAccountPending:
    "Dokončete připojení v prohlížeči, nebo účet odpojte",
  integrationsAccountFailed: "Připojení se nepovedlo",
  integrationsAccountSpareDirect: "Navíc přímo, nepoužívá se",
  integrationsAccountSpareComposio: "Navíc přes Composio, nepoužívá se",
  integrationsSignInAgain: "Přihlásit znovu",
  integrationsAccountMore: "Další volby pro {account} v aplikaci {app}",
  integrationsManageInComposio: "Spravovat v Composiu",
  integrationsDisconnect: "Odpojit",
  integrationsDisconnectTitle: "Odpojit {account} od aplikace {app}?",
  integrationsDisconnectDirect: "Odpojí se jen v tomto Prostředí.",
  integrationsDisconnectComposio:
    "Odpojí se z účtu Composia {account}, takže ve všech Prostředích, které ho používají.",
  integrationsDisconnectComposioAny:
    "Odpojí se z vašeho účtu Composia, takže ve všech Prostředích, které ho používají.",
  integrationsDisconnectPending:
    "Odvolá se jen tento účet; ostatní účty aplikace {app} zůstanou připojené.",
  integrationsDisconnectUnsupported:
    "Composio odsud zatím odpojit nejde: účet odpojte v Composiu.",
  integrationsDisconnectFailed: "Účet se nepodařilo odpojit.",
  integrationsDisconnecting: "Odpojuji…",
  integrationsDisconnectStillListed:
    "Odpojeno, ale ještě se tu ukazuje. Za chvíli zkontrolujte připojení.",
  integrationsComposioUpdate:
    "Aktualizujte Composio, ať tu můžete účty odpojovat a vidět jejich jména.",
  integrationsComposioUpdating: "Aktualizuji Composio…",
  integrationsComposioUpdated: "Composio je aktualizované.",
  integrationsComposioUpdateFailed: "Aktualizace nedoběhla. Zkuste to znovu.",
  integrationsOpenComposio: "Otevřít Composio",
  integrationsMissingPath: "Tady se zatím připojit nedá.",
  integrationsMissingTool: "Připojuje se nástrojem {tool}.",
  integrationsOpenTools: "Otevřít Nástroje",
  integrationsMissingCompanyApp:
    "Firemní aplikace {provider} ještě není nastavená.",
  integrationsComposioOffOrganization: "Composio je v Organizaci vypnuté.",
  integrationsComposioOffHere: "Composio je tu vypnuté.",
  integrationsAskAdmin: "Požádat Admina",
  integrationsAskAdminCopied: "Zprávu pro Admina máte ve schránce.",
  integrationsAskAdminText:
    "Prosím o zpřístupnění aplikace {app} v Integracích našich Prostředí: {line}",
  integrationsSetUpInDashboard: "Nastavit v Přehledu Organizace",
  integrationsAllowComposio: "Povolit Composio",
  integrationsAdminWhere:
    "Nastavíte to v Přehledu Organizace, v jejím nastavení.",
  integrationsComposioSignIn:
    "Nejdřív se přihlaste do Composia: otevře se v Nastavení → Nástroje.",
  integrationsBrowserMissing:
    "Přímé přihlášení potřebuje prohlížeč, který v tomto Prostředí teď není.",
  integrationsKeyTitle: "Klíč pro {app}",
  integrationsKeyText:
    "Klíč jde jen do Executoru tohoto Prostředí a už se nikde nezobrazí.",
  integrationsKeyLabel: "Klíč",
  integrationsMcpTitle: "MCP servery",
  integrationsMcpAdd: "Přidat MCP server",
  integrationsMcpNone: "Zatím žádné MCP servery.",
  integrationsMcpWhereCommand: "Příkaz v tomto Prostředí",
  integrationsMcpReady: "Přidáno",
  integrationsMcpTools: "Připojeno · {tools}",
  integrationsMcpPending: "Spouštím…",
  integrationsMcpFailed: "Nepodařilo se spustit",
  integrationsMcpEdit: "Upravit",
  integrationsMcpRemove: "Odebrat",
  integrationsMcpRemoveTitle: "Odebrat MCP server „{name}“?",
  integrationsMcpRemoveText: "Agenti a boti přijdou o jeho nástroje.",
  integrationsMcpNameTaken: "Integrace s tímto názvem už existuje.",
  integrationsMcpPageTitle: "Připojit vlastní MCP server",
  integrationsMcpEditTitle: "Upravit vlastní MCP server",
  integrationsMcpBack: "Zpět",
  integrationsMcpDocs: "Návod",
  integrationsMcpName: "Název",
  integrationsMcpNamePlaceholder: "Název MCP serveru",
  integrationsMcpType: "Typ",
  integrationsMcpTypeFixed:
    "Uložený server si typ nechává: když ho chcete změnit, server odeberte a přidejte znovu.",
  integrationsMcpCommand: "Příkaz ke spuštění",
  integrationsMcpArgs: "Argumenty",
  integrationsMcpAddArg: "Přidat argument",
  integrationsMcpRemoveArg: "Odebrat argument",
  integrationsMcpEnv: "Proměnné prostředí",
  integrationsMcpAddEnv: "Přidat proměnnou prostředí",
  integrationsMcpRemoveEnv: "Odebrat proměnnou",
  integrationsMcpCwd: "Pracovní složka",
  integrationsMcpUrl: "URL",
  integrationsMcpBearer: "Bearer token",
  integrationsMcpRemoveBearer: "Odebrat Bearer token",
  integrationsMcpHeaders: "Hlavičky",
  integrationsMcpAddHeader: "Přidat hlavičku",
  integrationsMcpRemoveHeader: "Odebrat hlavičku",
  integrationsMcpKey: "Klíč",
  integrationsMcpValue: "Hodnota",
  integrationsMcpStored: "Uloženo",
  integrationsMcpEnterAgain: "Zadejte znovu",
  integrationsMcpSave: "Uložit",
  integrationsMcpSaving: "Ukládám…",
  integrationsMcpLoading: "Načítám nastavení serveru…",
  integrationsMcpLoadFailed: "Nastavení serveru se nepodařilo načíst.",
  integrationsMcpAdded: "MCP server „{name}“ je přidaný.",
  integrationsMcpSaved: "Změny serveru „{name}“ jsou uložené.",
  integrationsMcpSaveFailed: "MCP server se nepodařilo uložit.",
  integrationsMcpGone: "Tento MCP server už v Executoru není.",
  integrationsMcpInvalid: "Některé údaje nesedí, zkontrolujte je.",
  integrationsMcpNameInvalid: "Název má nejvýš 64 znaků na jednom řádku.",
  integrationsMcpTextInvalid:
    "Tento text nejde použít: má řídicí znak, nebo je moc dlouhý.",
  integrationsMcpUrlInvalid:
    "Zadejte celou adresu, třeba https://mcp.example.com/mcp.",
  integrationsMcpUrlInsecure:
    "Adresa musí začínat https://. http:// jde jen v tomto Prostředí (localhost).",
  integrationsMcpCwdInvalid: "Zadejte celou cestu, třeba ~/code nebo /srv/mcp.",
  integrationsMcpEnvNameInvalid:
    "Jen písmena, číslice a podtržítko, na začátku ne číslice.",
  integrationsMcpHeaderNameInvalid: "Název hlavičky je bez mezer a dvojteček.",
  integrationsMcpKeyRequired: "Doplňte klíč.",
  integrationsMcpValueRequired: "Doplňte hodnotu.",
  integrationsMcpValueInvalid:
    "Hodnota má nejvýš 4 096 znaků, u hlavičky na jednom řádku.",
  integrationsMcpDuplicate: "Tento klíč je tu dvakrát.",
  integrationsMcpBearerTaken: "Tuto hlavičku už posílá Bearer token.",
  integrationsToolsOne: "{count} nástroj",
  integrationsToolsFew: "{count} nástroje",
  integrationsToolsMany: "{count} nástrojů",
  // Settings → SSH from your devices (decision F49).
  sshTitle: "SSH ze zařízení",
  sshIntro:
    "Připojte se do tohoto Prostředí přes SSH z terminálu na svém počítači. Každý počítač má vlastní klíč a tady ho můžete kdykoli odebrat.",
  sshShared:
    "Toto je společné Prostředí celého Teamu: zařízení přidané tady se přihlašuje do účtu Teamu a každý z Teamu ho vidí a může odebrat.",
  sshUnsupported:
    "SSH ze zařízení je dostupné v Prostředích s Linuxem a macOS.",
  sshRefresh: "Obnovit",
  sshLoading: "Načítá se přístup přes SSH…",
  sshLoadFailed: "Přístup přes SSH se nepodařilo načíst. Zkuste Obnovit.",
  sshPromptTitle: "Prompt pro vašeho agenta",
  sshPromptNote:
    "Předejte ho agentovi na svém počítači, třeba Codexu. Otevře si tuto stránku ve svém panelu prohlížeče, kde se jen přihlásíte; zbytek nastaví sám.",
  sshPromptCopy: "Zkopírovat prompt",
  sshPromptUnavailable:
    "Prompt se objeví, jakmile budou známá nastavení pro váš počítač (níže).",
  sshPromptText:
    "Připoj tento počítač přes SSH k mému Prostředí „{alias}“ v Lazuriu a přidej jeho Lazurio Folder do Codexu jako projekt.\n\nAdresu, účet a klíč hostu najdeš na stránce Prostředí: {url}\n\n1. Použij klíč {keyPath} (ve Windows {windowsKeyPath}). Když ještě neexistuje, vytvoř klíč ed25519. Soukromý klíč z počítače nikdy neodchází, ven smí jen soubor .pub.\n2. Na stránce v části „Přidat zařízení“ zaregistruj jeho veřejný klíč.\n3. Doplň nastavení SSH a řádek known_hosts ze stránky pro {alias}. Ostatní připojení nech, jak jsou. Když stejný záznam už existuje, použij ho; když pro {alias} existuje jiný, nic neměň a řekni mi to.\n4. Ověř, že SSH funguje: ssh {alias} true\n5. Pak otevři odkaz do Codexu ze stránky: {desktopLink}. Když ho aplikace neotevře, přidej alias a cestu k Folderu ze stránky sám v Settings → Connections → SSH.\n\nProfil Tailscale nepřepínej. Zaregistrovaný klíč přístup do sítě nedává, ten povoluje správce sítě. Nakonec mi napiš, jak připojení dopadlo.",
  sshDevicesTitle: "Vaše zařízení",
  sshDevicesNone: "Zatím tu není přidané žádné zařízení.",
  sshAddedBy: "Přidáno {date}, účet {who}",
  sshAddedLocal: "Přidáno {date} bez účtu Lazurio",
  sshRemove: "Odebrat",
  sshRemoveNamed: "Odebrat {device}",
  sshRemoveConfirm: "Odebrat {device}? Už se nebude moct přihlásit přes SSH.",
  sshRemoveYes: "Odebrat",
  sshRemoveCancel: "Zrušit",
  sshRemoved: "Zařízení {device} je odebrané a už se nepřihlásí.",
  sshRemovedStillAllowed:
    "Zařízení {device} je tady odebrané, ale stejný klíč dál povoluje řádek přidaný mimo Lazurio.",
  sshRemoveFailed:
    "Zařízení se nepodařilo odebrat. Zkuste Obnovit a odeberte ho znovu.",
  sshRemoveNotFound: "Tento klíč už tu není. Zkuste Obnovit.",
  sshRemoveNotOwn: "Tento klíč byl přidaný mimo Lazurio; Lazurio ho neodebírá.",
  sshOutsideTitle: "Přidané mimo Lazurio",
  sshOutsideNote:
    "Tyto klíče Lazurio nikdy nemění ani neodebírá, třeba klíč, se kterým bylo toto Prostředí zřízené. Odebírá je ten, kdo se o Prostředí stará.",
  sshOutsideUnreadable: "Řádek, kterému Lazurio nerozumí",
  sshOutsideUntitled: "Klíč bez názvu",
  sshProblemDirectory:
    "~/.ssh v tomto Prostředí není běžná složka, proto ji Lazurio nemění.",
  sshProblemSymlink:
    "~/.ssh/authorized_keys je odkaz, proto ho Lazurio nemění. Agent v tomto Prostředí ho může nahradit běžným souborem.",
  sshProblemNotFile:
    "~/.ssh/authorized_keys není běžný soubor, proto ho Lazurio nemění.",
  sshProblemForeignOwner:
    "~/.ssh/authorized_keys patří jinému účtu, proto ho Lazurio nemění.",
  sshProblemTooLarge:
    "~/.ssh/authorized_keys je větší než 1 MB, proto ho Lazurio nemění.",
  sshAddTitle: "Přidat zařízení",
  sshAddNote:
    "Jeho název a veřejný klíč: jeden řádek ze souboru .pub, který začíná ssh-ed25519. Nikdy ne soukromý klíč.",
  sshDeviceName: "Název zařízení",
  sshDeviceNameHint: "Třeba alex-notebook.",
  sshPublicKey: "Veřejný klíč",
  sshAdd: "Přidat zařízení",
  sshAdding: "Přidávám…",
  sshAdded:
    "Zařízení {device} se teď může přihlásit. Nastavení pro váš počítač je níže.",
  sshAlreadyPresent:
    "Tento klíč se tu už přihlásit může; nic se nezměnilo. Nastavení pro váš počítač je níže.",
  sshAddFailed:
    "Zařízení se nepodařilo přidat. Zkuste to znovu; když to nepomůže, požádejte o pomoc agenta v tomto Prostředí.",
  sshRefusedKeyMissing: "Vložte veřejný klíč.",
  sshRefusedPrivateKey:
    "Toto je soukromý klíč. Nikam ho nevkládejte; vložte veřejný klíč ze souboru .pub.",
  sshRefusedMultipleLines: "Vložte právě jeden klíč na jednom řádku.",
  sshRefusedOptions:
    "Vložte klíč bez voleb před ním, třeba command= nebo from=.",
  sshRefusedKeyRestricted:
    "Tento klíč už je tu povolený s omezením přidaným mimo Lazurio (třeba from= nebo command=), takže se jím toto zařízení přihlásit nemůže. Vytvořte pro toto zařízení nový klíč, nebo se obraťte na toho, kdo se o Prostředí stará.",
  sshRefusedType:
    "Přijímáme jen klíče ed25519 (ssh-ed25519 nebo sk-ssh-ed25519@openssh.com). Vytvoříte ho příkazem ssh-keygen -t ed25519.",
  sshRefusedInvalidKey:
    "Klíč je poškozený nebo neúplný. Zkopírujte znovu celý řádek ze souboru .pub.",
  sshRefusedNotKey:
    "Toto není veřejný klíč SSH. Je to jeden řádek, který začíná ssh-ed25519.",
  sshRefusedName: "Pojmenujte zařízení písmeny nebo číslicemi.",
  sshRefusedAddedBy:
    "Přihlášený účet se nepodařilo zaznamenat. Načtěte stránku znovu a zkuste to ještě jednou.",
  sshCodexLink: "Přidat Prostředí do Codexu",
  sshComputerTitle: "Nastavení pro váš počítač",
  sshComputerNote:
    "Váš agent je zapíše do vašeho počítače. Klíč hostu je vlastní klíč tohoto Prostředí, takže si počítač ověří, že opravdu mluví s ním.",
  sshConfigLabel: "SSH config",
  sshConfigNote: "Přidejte do ~/.ssh/config",
  sshKnownHostsLabel: "known_hosts",
  sshKnownHostsNote: "Přidejte do ~/.ssh/known_hosts_lazurio",
  sshCopy: "Kopírovat",
  sshCopied: "Zkopírováno.",
  sshNetworkNote:
    "Přidaný klíč zařízení sám přístup do sítě nedá. Když SSH selže, dejte agentovi přesnou chybovou hlášku. Pokud zařízení do sítě zatím nesmí, povolí mu to správce sítě.",
  sshComputerMissing: "Nastavení pro váš počítač zatím není k dispozici:",
  sshMissingTailscale: "V tomto Prostředí není nainstalovaný Tailscale.",
  sshMissingTailscaleFailed: "Tailscale v tomto Prostředí neodpověděl.",
  sshMissingNotRunning: "Tailscale v tomto Prostředí není připojený.",
  sshMissingDnsName: "Toto Prostředí nemá ve svém tailnetu jméno (MagicDNS).",
  sshMissingHostKey:
    "Toto Prostředí nemá klíč hostu ed25519 (/etc/ssh/ssh_host_ed25519_key.pub).",
  sshMissingUser:
    "Účet tohoto Prostředí nemá jméno, které by šlo použít v SSH config.",
};
export function messages(
  locale: unknown,
): Readonly<Record<MessageKey, string>> {
  return locale === "cs" ? cs : en;
}
