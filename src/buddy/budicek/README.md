# Budíček: Buddy's wake-up service

Budíček wakes Buddy when a bot he gave work to ends. Buddy never waits for a
bot. He gives the work through `budicek zadej`, and the service
(`budicek.service`) asks MausBot itself how the bots are doing. As soon as
there is an outcome, it completes a card on Hermes's Kanban board, and Hermes
wakes Buddy in his main conversation (root decision 0210, addendum of
2026-10-20 night, point 5; LazurioPlatform#565).

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
- The wake is a Hermes Kanban card titled `budíček <id>: <title>`, subscribed
  with `notify-subscribe --delivery-mode wake`.
- The states: `HOTOVO | SELHAL | PTÁ SE | NESTIHL TERMÍN | MAUSBOT NEODPOVÍDÁ | NESPUSTIL SE`.
- Every bot gets the standard brief before its task: it works for Buddy
  („Buddy za <the user>“), the task's id and deadline, one final report, stick
  to the brief, publish nothing, ask no one.
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

## Checking it

```bash
systemctl --user status budicek.service
journalctl --user -u budicek -n 50
budicek seznam --otevrene
hermes kanban list
journalctl --user -u hermes-gateway | grep "kanban notifier: woke agent"
```

Tests, from the repository root: `python3 -m unittest src/buddy/budicek/test_budicek.py`
(standard library only; fake `openmausbot`, `hermes` and `ssh`). CI runs them
in the static checks job (`.github/workflows/check.yml`).
