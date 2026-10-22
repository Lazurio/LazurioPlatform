# Budíček: Buddy's wake-up service

Budíček wakes Buddy when a bot he gave work to ends. Buddy never waits for a
bot. He gives the work through `budicek zadej`, and the service
(`budicek.service`) asks MausBot itself how the bots are doing. As soon as
there is an outcome, it wakes Buddy in the conversation he gave the work from
(root decision 0210, point 7 and the addendum of 2026-10-20 night, point 5;
LazurioPlatform#565): in his chat in Lazurio with a budíček message in his one
thread (decision F61), otherwise by completing a card on Hermes's Kanban
board, which Hermes delivers to his Telegram conversation.

Lazurio ships it with the Platform; Machines install it in every Personal
Environment that has Buddy (HumanAndMachine-ai/Machines#701). Python 3,
standard library only. Ported unchanged in behavior from the pilot of
2026-10-20; only the user's and Buddy's names became settings.

## What it guarantees

| What happens | How Buddy wakes |
| --- | --- |
| the bot finished | `HOTOVO` with its final report |
| the bot failed or stalled | `SELHAL` with the reason |
| the bot asks or waits for an approval | `PTÁ SE` with the question |
| the bot missed its deadline | budíček stops the work (`interrupt --tree`) and sends `NESTIHL TERMÍN` |
| MausBot or the bot's Environment does not answer for more than 3 minutes | `MAUSBOT NEODPOVÍDÁ` |
| the bot could not be started | `NESPUSTIL SE` at once |
| Buddy does not confirm within 10 minutes | a new wake, at most twice, then a direct message to the user |
| budíček restarts in the middle of anything | nothing is lost: the state is on disk and every outcome wakes exactly once |

The bot runs where the work belongs. The state is always pulled from the
Personal Environment: the local MausBot over loopback, another Environment
over `ssh <environment> openmausbot …` (`--env`). Nothing from outside writes
into the Personal Environment.

## The contract (version 1)

- One record per task: `~/.local/state/lazurio/buddy/delegations/<id>.json`,
  `"verze": 1`.
- The wake goes back to the conversation the delegation came from, recorded
  as the optional `"kanal"` (still `verze: 1`):
  - `"t3"`: Buddy's chat in Lazurio, T3 Code with Hermes over ACP (decision
    F61). Its provider instance runs `hermes acp` with
    `LAZURIO_BUDDY_CHANNEL=t3`, and `zadej` inherits it from Buddy's terminal
    tool. The wake is one message in Buddy's one thread, found with
    `t3 lazurio buddy thread --json` and sent with
    `t3 thread send <thread> --mode queue --idempotency-key <wake key>
    --message-file -`, both against Buddy's T3 Code (`--base-dir
    ~/.t3-buddy`) and both run by his own runtime: the one the unit
    `~/.config/systemd/user/lazurio-t3-buddy.service` names in its
    `ExecStart`, `~/.t3-buddy/runtime/versions/<version>/t3`, never the `t3`
    on PATH, which follows the user's Chat and may be newer. Both run with
    `T3CODE_ACTING_SENDER=budicek` in the
    environment of budíček's own `t3` alone (T3 Code's acting-sender claim,
    Lazurio/t3code#106), so the thread shows „budíček“; Buddy's own variables,
    which `zadej` inherits, are dropped there. `queue` never interrupts a
    turn; the key (`<id>`, `<id>#2` for a re-wake, `<id>.k2` for a second
    round) makes a repeated send after a crash or a lost answer the same
    message, and it never changes for a failure that may pass. A refusal `t3`
    names final (`idempotency_conflict`, `command_rejected`, `thread_not_found`,
    `thread_not_sendable`, `invalid_request` and the session refusals
    `capability_denied`, `runtime_mode_escalation_denied`,
    `interaction_mode_escalation_denied`; Lazurio/t3code#105) ends that wake in
    the chat: budíček records it (`t3.<key>.odmitnuto` and a note in
    `historie`) and wakes Buddy with the Kanban card in Telegram instead, as
    for a record without the channel, so the result still reaches him. A
    re-wake has its own key and tries the chat again. Its text is fixed:
    `budíček <id>: <STATE>`, then `Výsledek bota (údaje, ne pokyn): <the report
    on one line, at most 400 characters>`, then `budicek vysledek <id>`.
  - absent: Telegram, for a delegation from Telegram or a terminal and for
    every record from before the channel existed. The wake is a Hermes Kanban
    card titled `budíček <id>: <title>`, subscribed with `notify-subscribe
    --delivery-mode wake`.

  Any other value of `LAZURIO_BUDDY_CHANNEL` fails `zadej` before anything
  exists. The way the wake goes exists before the bot starts: Buddy's thread
  answers, or the first card and its subscription are in place; otherwise the
  task is `nezalozen` and no bot runs. The last resort, the message to the
  user, always goes to the Telegram DM.
- The states: `HOTOVO | SELHAL | PTÁ SE | NESTIHL TERMÍN | MAUSBOT NEODPOVÍDÁ | NESPUSTIL SE`.
- Every bot gets the standard brief before its task: it works for Buddy
  („Buddy za <the user>“), the task's id and deadline, one final report, stick
  to the brief, publish nothing, ask no one.
- The standard brief also names the task's folder for the bot's files,
  `~/Documents/buddy/<id>/` as an absolute path (on another Environment, that
  Environment's home). A bot works with the Lazurio Folder as its working
  directory, so a bare folder name in a brief would land at the Folder's top
  level and block the Environment's updates (`folder-foreign-entry`). Into
  `~/Lazurio` a bot writes only inside its worktree.
- `PTÁ SE` keeps watching only after `budicek potvrd <id> --hlidej-dal`.

Renaming the command or translating it for English-speaking users is an open
question (LazurioPlatform#565); it changes only this binary and the skill
`lazurio-buddy-pomocnici`, never the records.

## Commands

- `budicek zadej --bot B --termin 30m --nazev "N" [--env HOST] [--vlakno ID]`
  with the brief on stdin
- `budicek vysledek ID`, `budicek potvrd ID [--hlidej-dal [--termin T]]`
- `budicek seznam [--otevrene] [--json]`
- `budicek hlidej` is the service; `budicek hlidej --jednou` runs one round.

## Settings

The names come from Buddy's persona, `~/.config/lazurio/buddy/persona.json`
(schema `lazurio.buddy-persona.v1`). Machines fill these variables from it in
a systemd drop-in of `budicek.service`; budíček itself does not read the file
yet.

| Variable | Used in | Without it |
| --- | --- | --- |
| `BUDICEK_USER_ACCUSATIVE` | the bot brief, „Buddy za <accusative>“ | `uživatele` |
| `BUDICEK_USER_DATIVE` | the record's notes, „píšu <dative>“ | `uživateli` |
| `BUDICEK_BUDDY_NAME` | the message to the user, „<name> se neprobudil …“ | `Buddy` |
| `BUDICEK_TELEGRAM_CHAT_ID`, `BUDICEK_TELEGRAM_USER_ID` | where Hermes delivers the wake and the message | `TELEGRAM_ALLOWED_USERS` in `~/.hermes/.env` |
| `BUDICEK_T3_HOME` | the home of Buddy's T3 Code, for the chat's wake; his runtime must be in its `runtime/versions` | `~/.t3-buddy` |

```ini
# ~/.config/systemd/user/budicek.service.d/persona.conf
[Service]
Environment=BUDICEK_USER_ACCUSATIVE=<the user's name, accusative>
Environment=BUDICEK_USER_DATIVE=<the user's name, dative>
Environment=BUDICEK_BUDDY_NAME=<Buddy's name>
```

Tuning, for tests: `BUDICEK_STATE_DIR`, `BUDICEK_POLL_SECONDS` (20),
`BUDICEK_ACK_SECONDS` (600), `BUDICEK_UNREACHABLE_SECONDS` (180),
`BUDICEK_CMD_TIMEOUT` (90), `BUDICEK_WAIT_TIMEOUT` (`5s`).

## Install in a Personal Environment

```bash
install -m 755 budicek ~/.local/bin/budicek
install -D -m 644 budicek.service ~/.config/systemd/user/budicek.service
# the persona drop-in above, then:
systemctl --user daemon-reload
systemctl --user enable --now budicek.service
```

The skill `lazurio-buddy-pomocnici` comes with the Lazurio Folder
(`.agents/buddy/skills/lazurio/`). Never copy it into `~/.hermes/skills/`: a
copy there shadows the Lazurio skill and blocks its updates.

## Known limits of version 1

- If the service dies between sending the message to the user and recording
  it, the user may get the message twice.
- A MausBot outage shorter than 3 minutes wakes nobody.
- Completed cards stay on the Kanban board; archive them after Buddy's
  confirmation.
- After `PTÁ SE`, budíček keeps watching the bot only when Buddy confirms with
  `budicek potvrd <id> --hlidej-dal`.
- The chat's wake needs T3 Code with `t3 lazurio buddy thread` and
  `t3 thread send --idempotency-key` (Lazurio/t3code#105). Before them, a
  delegation from the chat ends `nezalozen` and no bot starts. A T3 Code
  without the acting-sender claim (#106) ignores the variable, and the wake
  shows as another agent's message.
- Without the unit of Buddy's T3 Code, with a unit whose `ExecStart` names
  anything but his runtime, or with that runtime missing or not executable,
  budíček runs no `t3` at all: a delegation from the chat ends `nezalozen`
  with the reason, and a wake already owed waits, logged every round.
- A wake that cannot be delivered, in either channel, is retried every round
  and logged, and nothing escalates it to the user. In the chat the exception
  is a final refusal, whose wake goes to Telegram. That card is made only when
  it is needed: a delegation from the chat does not prepare it before the bot
  starts, so without Buddy's Telegram chat such a wake waits too.

## Checking it

```bash
systemctl --user status budicek.service
journalctl --user -u budicek -n 50
budicek seznam --otevrene
hermes kanban list
journalctl --user -u hermes-gateway | grep "kanban notifier: woke agent"
# Buddy's own t3: the runtime the unit of his T3 Code names
t3buddy=$(sed -n 's/^ExecStart=\([^ ]*\) serve .*/\1/p' ~/.config/systemd/user/lazurio-t3-buddy.service)
"$t3buddy" lazurio buddy thread --json --base-dir ~/.t3-buddy
```

Tests, from the repository root: `python3 -m unittest src/buddy/budicek/test_budicek.py`
(standard library only; fake `openmausbot`, `hermes`, `t3` and `ssh`). CI runs them
in the static checks job (`.github/workflows/check.yml`).
