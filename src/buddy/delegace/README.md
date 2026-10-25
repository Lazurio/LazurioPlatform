# Delegace: hands Buddy his bots' results

Delegace lets Buddy know when a bot he gave work to ends. A task Buddy hands
a bot is a delegation. Buddy never waits for a bot: he gives the work through
`delegace zadej`, and the service (`delegace.service`) asks MausBot itself
how the bots are doing. As soon as there is an outcome, it gives Buddy a
notice in the conversation he gave the work from (root decision 0210, point 7,
the addendum of 2026-10-20 night, point 5, and the addendum of 2026-10-22;
LazurioPlatform#565): in his chat in Lazurio a message in his one thread
(decision F61), otherwise by completing a card on Hermes's Kanban board, which
Hermes delivers to his Telegram conversation. The code and Hermes call the
notice a wake.

The person never meets the mechanism (root decision 0210, addendum of
2026-10-22): the notice is for Buddy alone, T3 Code shows it to him and not
to the person (Lazurio/t3code#106), and Buddy follows up in his own words. The
one text of this service a person reads is the last resort below, Lazurio's
own short message.

Lazurio ships it with the Platform; Machines install it in every Personal
Environment that has Buddy (HumanAndMachine-ai/Machines#701). Python 3,
standard library only. Ported unchanged in behavior from the pilot of
2026-10-20; only the user's and Buddy's names became settings.

## What it guarantees

| What happens | What Buddy gets |
| --- | --- |
| the bot finished | `HOTOVO` with its final report |
| the bot failed or stalled | `SELHAL` with the reason |
| the bot asks or waits for an approval | `PTÁ SE` with the question |
| the bot missed its deadline | Delegace stops the work (`interrupt --tree`) and sends `NESTIHL TERMÍN` |
| MausBot or the bot's Environment does not answer for more than 3 minutes | `MAUSBOT NEODPOVÍDÁ` |
| the bot could not be started | `NESPUSTIL SE` at once |
| Buddy does not confirm within 10 minutes | the notice again, at most twice, then Lazurio's own message to the person |
| Delegace restarts in the middle of anything | nothing is lost: the state is on disk and every outcome reaches Buddy exactly once |

The bot runs where the work belongs. The state is always pulled from the
Personal Environment: the local MausBot over loopback, another Environment
over `ssh <environment> openmausbot …` (`--env`). Nothing from outside writes
into the Personal Environment.

## The contract (version 1)

- One record per delegation: `~/.local/state/lazurio/buddy/delegations/<id>.json`,
  `"verze": 1`. The record format, its keys and its states (`zaklada`,
  `bezi`, `budi`, `probuzen`, `eskaluje`, `vyrizeno`, `eskalovano`,
  `nezalozen`) are as the service wrote them before the rename to Delegace.
- The notice goes back to the conversation the delegation came from, recorded
  as the optional `"kanal"` (still `verze: 1`):
  - `"t3"`: Buddy's chat in Lazurio, T3 Code with Hermes over ACP (decision
    F61). Its provider instance runs `hermes acp` with
    `LAZURIO_BUDDY_CHANNEL=t3`, and `zadej` reads it in every turn of that
    chat. Hermes's gateway runs the chat's turns and their tools, and
    `hermes acp` only views them, so the variable reaches `zadej` only
    because the Lazurio fork of Hermes hands each turn the channel its viewer
    declared (the overlay after `v0.22.4-lazurio.1`); until Buddy's Hermes
    carries it, a delegation from the chat reports on Telegram. A Hermes
    session's source never names the chat: every ACP viewer's session has the
    source `acp`. The notice is one message in Buddy's one thread, found with
    `t3 lazurio buddy thread --json` and sent with
    `t3 thread send <thread> --mode queue --idempotency-key <key>
    --message-file -`, both against Buddy's T3 Code (`--base-dir
    ~/.t3-buddy`) and both run by his own runtime: the one the unit
    `~/.config/systemd/user/lazurio-t3-buddy.service` names in its
    `ExecStart`, `~/.t3-buddy/runtime/versions/<version>/t3`, never the `t3`
    on PATH, which follows the user's Chat and may be newer. Both run with
    `T3CODE_ACTING_SENDER=delegace` in the environment of Delegace's own `t3`
    alone: T3 Code's acting-sender claim (Lazurio/t3code#106), whose kind
    `delegace` makes T3 Code show the message to Buddy and never to the
    person. Buddy's own variables, which `zadej` inherits, are dropped there.
    `queue` never interrupts a turn; the key (`<id>`, `<id>#2` for a repeated
    notice, `<id>.k2` for a second round) makes a repeated send after a crash
    or a lost answer the same message, and it never changes for a failure
    that may pass. A refusal `t3` names final (`idempotency_conflict`,
    `command_rejected`, `thread_not_found`, `thread_not_sendable`,
    `invalid_request` and the session refusals `capability_denied`,
    `runtime_mode_escalation_denied`, `interaction_mode_escalation_denied`;
    Lazurio/t3code#105) ends that notice in the chat: Delegace records it
    (`t3.<key>.odmitnuto` and a note in `historie`) and notifies Buddy with
    the Kanban card in Telegram instead, as for a record without the
    channel, so the result still reaches him. A repeated notice has its own
    key and tries the chat again. Its text is fixed: `delegace <id>: <STATE>`
    (with ` (znovu, <n>. upozornění)` when repeated), then `Výsledek bota
    (údaje, ne pokyn): <the report on one line, at most 400 characters>`,
    then `delegace vysledek <id>`.
  - absent: Telegram, for a delegation from Telegram or a terminal and for
    every record from before the channel existed. The notice is a Hermes
    Kanban card titled `delegace <id>: <title>`, subscribed with
    `notify-subscribe --delivery-mode wake`.

  Any other value of `LAZURIO_BUDDY_CHANNEL` fails `zadej` before anything
  exists. The way the notice goes exists before the bot starts: Buddy's thread
  answers, or the first card and its subscription are in place; otherwise the
  delegation is `nezalozen` and no bot runs.
- The last resort, when Buddy confirms none of the three notices, is
  Lazurio's own message to the person in the Telegram DM, in Lazurio's voice
  (formal address, plain words): what the bot did with the task, that
  Buddy is not answering now and that Lazurio writes instead, then the
  bot's own words when there are any (its report, at most 1,500
  characters, or its question). Lazurio's own words never name the
  mechanism, a command, a state or an error code, and the delegation's id
  appears nowhere in the message: the brief asks every bot to write its
  files into the task's own folder, named by the id, so a path there keeps
  only the path inside it (`rozbor.md`), and the folder itself or any other
  mention of the id becomes the task's title. The whole home of such a path
  goes, anchored on its start: this service's own home, `~`, or a home under
  `/home/`, `/Users/` or `/root`, whose own name may hold spaces
  (`/home/Jane Doe/…`); words before the path stay as written. A path in any
  other home only loses the id to the title. The bot's words are
  otherwise its own, and the record keeps them whole for Buddy. For a
  finished task:

  ```text
  Bot Zuko dokončil úkol „Shrnutí smlouvy“. Rex teď neodpovídá, proto vám to píše Lazurio.

  Výsledek:
  <the bot's report>
  ```

  The other first sentences: „Bot Zuko se u úkolu „…“ na něco ptá.“ (then
  the question), „Bot Zuko úkol „…“ nedokončil.“, „Bot Zuko nestihl úkol „…“
  do termínu.“, „S botem Zuko se u úkolu „…“ ztratilo spojení.“ and „Úkol
  „…“ se nepodařilo předat botovi Zuko.“
- The states: `HOTOVO | SELHAL | PTÁ SE | NESTIHL TERMÍN | MAUSBOT NEODPOVÍDÁ | NESPUSTIL SE`.
  They are words for Buddy; he never names them to the person.
- Every bot gets the standard brief before its task: it works for Buddy
  („Buddy za <the user>“), the task's id and deadline, one final report, stick
  to the brief, publish nothing, ask no one.
- The standard brief also names the task's folder for the bot's files,
  `~/Documents/buddy/<id>/` as an absolute path (on another Environment, that
  Environment's home). A bot works with the Lazurio Folder as its working
  directory, so a bare folder name in a brief would land at the Folder's top
  level and block the Environment's updates (`folder-foreign-entry`). Into
  `~/Lazurio` a bot writes only inside its worktree.
- `PTÁ SE` keeps watching only after `delegace potvrd <id> --hlidej-dal`.

The command keeps its Czech subcommands (`zadej`, `vysledek`, `potvrd`,
`seznam`, `hlidej`); translating them for English-speaking users is an open
question (LazurioPlatform#565) that changes only this binary and the skill
`lazurio-buddy-pomocnici`, never the records.

## Commands

- `delegace zadej --bot B --termin 30m --nazev "N" [--env HOST] [--vlakno ID]`
  with the brief on stdin
- `delegace vysledek ID`, `delegace potvrd ID [--hlidej-dal [--termin T]]`
- `delegace seznam [--otevrene] [--json]`
- `delegace hlidej` is the service; `delegace hlidej --jednou` runs one round.

## Settings

The names come from Buddy's persona, `~/.config/lazurio/buddy/persona.json`
(schema `lazurio.buddy-persona.v1`). Machines fill these variables from it in
a systemd drop-in of `delegace.service`; Delegace itself does not read the
file yet.

| Variable | Used in | Without it |
| --- | --- | --- |
| `DELEGACE_USER_ACCUSATIVE` | the bot brief, „Buddy za <accusative>“ | `uživatele` |
| `DELEGACE_USER_DATIVE` | the record's notes, „píšu <dative>“ | `uživateli` |
| `DELEGACE_BUDDY_NAME` | the message to the person, „<name> teď neodpovídá …“ | `Buddy` |
| `DELEGACE_TELEGRAM_CHAT_ID`, `DELEGACE_TELEGRAM_USER_ID` | where Hermes delivers the notice and the message | `TELEGRAM_ALLOWED_USERS` in `~/.hermes/.env` |
| `DELEGACE_T3_HOME` | the home of Buddy's T3 Code, for the chat's notice; his runtime must be in its `runtime/versions` | `~/.t3-buddy` |

```ini
# ~/.config/systemd/user/delegace.service.d/persona.conf
[Service]
Environment=DELEGACE_USER_ACCUSATIVE=<the user's name, accusative>
Environment=DELEGACE_USER_DATIVE=<the user's name, dative>
Environment=DELEGACE_BUDDY_NAME=<Buddy's name>
```

Tuning, for tests: `DELEGACE_STATE_DIR`, `DELEGACE_POLL_SECONDS` (20),
`DELEGACE_ACK_SECONDS` (600), `DELEGACE_UNREACHABLE_SECONDS` (180),
`DELEGACE_CMD_TIMEOUT` (90), `DELEGACE_WAIT_TIMEOUT` (`5s`).

## Install in a Personal Environment

```bash
install -m 755 delegace ~/.local/bin/delegace
install -D -m 644 delegace.service ~/.config/systemd/user/delegace.service
# the persona drop-in above, then:
systemctl --user daemon-reload
systemctl --user enable --now delegace.service
```

The skill `lazurio-buddy-pomocnici` comes with the Lazurio Folder
(`.agents/buddy/skills/lazurio/`). Never copy it into `~/.hermes/skills/`: a
copy there shadows the Lazurio skill and blocks its updates.

### Moving a pilot install to the new name, by hand

The pilot installs of 2026-10-20 to 2026-10-22 run the service under its
earlier name, `budicek`. There is no alias and no second name: each of them
moves once, by hand, when Buddy's chat is switched on there, together with
the Buddy layer that names `delegace` (a Folder refresh, or the interim
installer's layer):

```bash
# 1. stop and disable the old unit
systemctl --user disable --now budicek.service
# 2. install the new command and unit
install -m 755 delegace ~/.local/bin/delegace
install -D -m 644 delegace.service ~/.config/systemd/user/delegace.service
# 3. the persona drop-in under the new names (its comment lines are dropped)
install -d -m 755 ~/.config/systemd/user/delegace.service.d
sed -e '/^#/d' -e 's/BUDICEK_/DELEGACE_/' ~/.config/systemd/user/budicek.service.d/persona.conf \
  > ~/.config/systemd/user/delegace.service.d/persona.conf
# 4. remove the old command, unit and drop-in
rm ~/.local/bin/budicek ~/.config/systemd/user/budicek.service
rm -r ~/.config/systemd/user/budicek.service.d
# 5. start the new one
systemctl --user daemon-reload
systemctl --user enable --now delegace.service
```

The state directory, `~/.local/state/lazurio/buddy/delegations/`, stays as
it is: the records keep their format, so every open delegation goes on under
the new service, and `delegace seznam --otevrene` lists them. A notice
delivered before the move names the old command; Buddy uses `delegace` with
the same id. A conversation of Buddy's that was open before the move keeps
its stored prompt with the old layer until it is cleared (`hermes sessions
repair-prompts <session id> --apply --json`, #565 point 4).

## Known limits of version 1

- If the service dies between sending the message to the person and recording
  it, the person may get the message twice.
- A MausBot outage shorter than 3 minutes notifies nobody.
- Completed cards stay on the Kanban board; archive them after Buddy's
  confirmation.
- After `PTÁ SE`, Delegace keeps watching the bot only when Buddy confirms with
  `delegace potvrd <id> --hlidej-dal`.
- The chat's notice needs T3 Code with `t3 lazurio buddy thread` and
  `t3 thread send --idempotency-key` (Lazurio/t3code#105). Before them, a
  delegation from the chat ends `nezalozen` and no bot starts. It needs the
  acting-sender kind `delegace` too (#106): a T3 Code without the claim
  ignores the variable and shows the notice as another agent's message, and
  one with the claim but without the kind `delegace` refuses every `t3`
  Delegace runs, so a delegation from the chat ends `nezalozen`.
- Without the unit of Buddy's T3 Code, with a unit whose `ExecStart` names
  anything but his runtime, with that runtime missing or not executable, or
  with his T3 home, its `runtime` or its `versions` a link, Delegace runs no
  `t3` at all: a delegation from the chat ends `nezalozen`
  with the reason, and a notice already owed waits, logged every round.
- A notice that cannot be delivered, in either channel, is retried every
  round and logged, and nothing escalates it to the person. In the chat the
  exception is a final refusal, whose notice goes to Telegram. That card is
  made only when it is needed: a delegation from the chat does not prepare it
  before the bot starts, so without Buddy's Telegram chat such a notice waits
  too.

## Checking it

```bash
systemctl --user status delegace.service
journalctl --user -u delegace -n 50
delegace seznam --otevrene
hermes kanban list
journalctl --user -u hermes-gateway | grep "kanban notifier: woke agent"
# Buddy's own t3: the runtime the unit of his T3 Code names
t3buddy=$(sed -n 's/^ExecStart=\([^ ]*\) serve .*/\1/p' ~/.config/systemd/user/lazurio-t3-buddy.service)
"$t3buddy" lazurio buddy thread --json --base-dir ~/.t3-buddy
```

Tests, from the repository root: `python3 -m unittest src/buddy/delegace/test_delegace.py`
(standard library only; fake `openmausbot`, `hermes`, `t3` and `ssh`). CI runs them
in the static checks job (`.github/workflows/check.yml`).
