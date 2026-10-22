#!/usr/bin/env python3
"""Contract tests for budicek with fake `openmausbot`, `hermes`, `ssh` and `t3`.

A "wake" is what reaches Buddy. In Telegram it is a `completed` event on a
Kanban card that has a `wake` subscription; the fake `hermes` records exactly
those, so the tests count wakes the way the real gateway would see them. In
his chat in Lazurio (channel `t3`) it is a message in his one T3 Code thread;
the fake `t3` keeps one message per idempotency key, as T3 Code does with the
key's command id, and records every send. It is installed as Machines install
Buddy's own runtime, named by the unit of his T3 Code; the `t3` on PATH is a
decoy that only records being run.
"""

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
BUDICEK = os.path.join(HERE, "budicek")

FAKE_HERMES = r'''
import fcntl, json, os, sys
d = os.environ["FAKE_DIR"]
path = os.path.join(d, "hermes.json")
lock = open(os.path.join(d, "hermes.lock"), "w")
fcntl.flock(lock, fcntl.LOCK_EX)
st = json.load(open(path)) if os.path.exists(path) else {"tasks": {}, "events": [], "sends": [], "n": 0}
a = sys.argv[1:]
st.setdefault("acting", []).append(os.environ.get("T3CODE_ACTING_SENDER"))
def opt(name):
    return a[a.index(name) + 1] if name in a else None
def done(code=0, out=None):
    json.dump(st, open(path, "w"), indent=1)
    if out is not None:
        print(out if isinstance(out, str) else json.dumps(out))
    sys.exit(code)
fail = os.environ.get("FAKE_HERMES_FAIL", "")
if a[0] == "kanban":
    verb = a[1]
    if verb in fail.split(","):
        print("fake failure", file=sys.stderr); done(1)
    if verb == "create":
        key = opt("--idempotency-key")
        for tid, t in st["tasks"].items():
            if key and t["key"] == key and t["status"] != "archived":
                done(0, {"id": tid, "status": t["status"]})
        st["n"] += 1
        tid = "t_%d" % st["n"]
        st["tasks"][tid] = {"title": a[2], "key": key, "status": "ready", "subs": []}
        done(0, {"id": tid, "status": "ready"})
    if verb == "notify-subscribe":
        t = st["tasks"][a[2]]
        t["subs"] = [s for s in t["subs"] if s["chat"] != opt("--chat-id")]
        t["subs"].append({"chat": opt("--chat-id"), "mode": opt("--delivery-mode"), "type": opt("--chat-type")})
        done(0, "subscribed")
    if verb == "show":
        t = st["tasks"].get(a[2])
        if not t:
            done(1, "no such task")
        done(0, {"task": dict(t, id=a[2])})
    if verb == "complete":
        t = st["tasks"][a[2]]
        if t["status"] not in ("ready", "running", "blocked", "review"):
            print("cannot complete", file=sys.stderr); done(1)
        t["status"] = "done"
        if any(s["mode"] == "wake" for s in t["subs"]):
            st["events"].append({"task": a[2], "key": t["key"], "title": t["title"], "summary": opt("--summary")})
        done(0, "completed")
    if verb == "archive":
        st["tasks"][a[2]]["status"] = "archived"
        done(0, "archived")
if a[0] == "send":
    if "send" in fail.split(","):
        done(1)
    st["sends"].append({"to": opt("--to"), "text": a[-1]})
    done(0)
done(2, "unknown")
'''

FAKE_MAUSBOT = r'''
import fcntl, json, os, sys
d = os.environ["FAKE_DIR"]
lock = open(os.path.join(d, "mausbot.lock"), "w")
fcntl.flock(lock, fcntl.LOCK_EX)
cfg_path = os.path.join(d, "mausbot.json")
cfg = json.load(open(cfg_path)) if os.path.exists(cfg_path) else {}
a = sys.argv[1:]
stdin = sys.stdin.read() if "-" in a else None
with open(os.path.join(d, "mausbot-calls.jsonl"), "a") as fh:
    fh.write(json.dumps({"argv": a, "stdin": stdin, "omb_port": os.environ.get("OMB_PORT"),
                         "acting": os.environ.get("T3CODE_ACTING_SENDER")}) + "\n")
verb = a[0]
if verb == "run":
    r = cfg.get("run", {"exit": 0, "out": {"ok": True, "exitCode": 0, "threadId": "th-1", "since": 1234}})
elif verb == "wait":
    q = cfg.get("wait", [{"exit": 4, "out": {"ok": False, "exitCode": 4, "state": "timed-out"}}])
    r = q[0]
    if len(q) > 1:
        cfg["wait"] = q[1:]
        json.dump(cfg, open(cfg_path, "w"))
elif verb == "interrupt":
    r = cfg.get("interrupt", {"exit": 0, "out": {"ok": True}})
else:
    r = {"exit": 2, "out": {"ok": False, "error": "unknown verb"}}
print(json.dumps(r.get("out", {})))
sys.exit(r["exit"])
'''

FAKE_T3 = r'''
import fcntl, json, os, sys
d = os.environ["FAKE_DIR"]
path = os.path.join(d, "t3.json")
lock = open(os.path.join(d, "t3.lock"), "w")
fcntl.flock(lock, fcntl.LOCK_EX)
st = json.load(open(path)) if os.path.exists(path) else {"calls": [], "sends": [], "messages": [], "keys": {}, "refused": {}, "n": 0}
a = sys.argv[1:]
def opt(name):
    return a[a.index(name) + 1] if name in a else None
def done(code, out):
    json.dump(st, open(path, "w"), indent=1, ensure_ascii=False)
    print(json.dumps(out))
    sys.exit(code)
def refuse(code, message):
    done(1, {"error": {"code": code, "message": message}})
# Who the command acts as, by T3 Code's rules (Lazurio/t3code#106): empty is unset.
var = lambda name: os.environ.get(name, "").strip()
sender, named = var("T3CODE_ACTING_SENDER"), bool(var("T3CODE_ACTING_FOR") or var("T3CODE_ACTING_FOR_ACCUSATIVE"))
st["calls"].append({"argv": a, "acting": sender or None, "named": named})
if (not sender and named) or sender not in ("", "buddy", "budicek") or (sender == "budicek" and named) \
        or (sender == "buddy" and not var("T3CODE_ACTING_FOR")):
    refuse("invalid_request", "T3CODE_ACTING_SENDER and its names do not fit.")
if os.environ.get("FAKE_T3_DOWN"):
    done(3, {"error": {"code": "server_not_running", "message": "T3 Code is not running for this T3 home."}})
if a[:3] == ["lazurio", "buddy", "thread"]:
    if os.environ.get("FAKE_T3_NO_THREAD"):
        refuse("not_found", "No Buddy thread.")
    done(0, {"threadId": "buddy-thread-1", "projectId": "buddy-project"})
if a[:2] == ["thread", "send"] and opt("--message-file") == "-" and opt("--idempotency-key"):
    key = opt("--idempotency-key")
    text = sys.stdin.read()
    st["sends"].append({"key": key, "text": text, "acting": sender})
    # T3 Code keeps a command's receipt (Lazurio/t3code#105): a key it refused
    # stays refused, and a sent one sends nothing more.
    if key in st["refused"]:
        refuse(st["refused"][key], "T3 Code refused the message for this key.")
    if key in st["keys"]:
        done(0, st["keys"][key])
    passing = os.environ.get("FAKE_T3_FAIL")
    if passing:  # a failure that may pass: nothing sent, nothing kept
        refuse(passing, "T3 Code could not take the message now.")
    final = os.environ.get("FAKE_T3_REFUSE")
    if final:  # a final refusal; the two that spend the key stay with it
        if final in ("command_rejected", "idempotency_conflict"):
            st["refused"][key] = final
        refuse(final, "T3 Code refused the message.")
    st["n"] += 1
    result = {"threadId": a[2], "runId": "run-%d" % st["n"], "status": "queued", "delivery": "queued"}
    st["keys"][key] = result
    st["messages"].append({"thread": a[2], "key": key, "argv": a, "text": text, "acting": sender})
    lost = os.environ.get("FAKE_T3_LOSE_ANSWER")
    if lost:  # it went out, but the answer that came back says only that something failed
        refuse(lost, "T3 Code did not complete the request.")
    done(0, result)
refuse("invalid_request", "unknown command")
'''

# The `t3` on PATH, as the user's Chat has it: budíček must never run it.
DECOY_T3 = r'''
import json, os, sys
with open(os.path.join(os.environ["FAKE_DIR"], "path-t3.jsonl"), "a") as fh:
    fh.write(json.dumps({"argv": sys.argv[1:]}) + "\n")
print(json.dumps({"error": {"code": "server_not_running", "message": "the Chat's t3"}}))
sys.exit(3)
'''

# Buddy's own runtime and the unit of his T3 Code that names it, as Machines
# render it (workloads/workspace-vm/buddy-t3.ts).
T3_VERSION = "0.1.1-lazurio.1"
T3_UNIT = """[Unit]
Description=Lazurio Buddy's T3 Code server

[Service]
Type=simple
WorkingDirectory=%h
Environment=T3CODE_LAZURIO_BUDDY=1
ExecStart={start}
Restart=always

[Install]
WantedBy=default.target
"""

FAKE_SSH = r'''
import json, os, subprocess, sys
d = os.environ["FAKE_DIR"]
a = sys.argv[1:]
with open(os.path.join(d, "ssh-calls.jsonl"), "a") as fh:
    fh.write(json.dumps({"argv": a}) + "\n")
if os.environ.get("FAKE_SSH_DOWN"):
    print("ssh: connect to host: Connection timed out", file=sys.stderr)
    sys.exit(255)
sys.exit(subprocess.run(["sh", "-c", a[-1]]).returncode)
'''

# `wait --json` as MausBot 0.1.115 prints it: no `reply`, the answer is the newest bot text message.
DONE = {"exit": 0, "out": {"status": "settled", "state": "completed", "taskId": "th-1",
                           "job": {"state": "completed", "reason": "budicek-test finished", "needsInput": []},
                           "messages": [{"role": "user", "kind": "text", "text": "Pracuješ pro Buddyho…"},
                                        {"role": "bot", "kind": "text", "text": "hotovo"},
                                        {"role": "bot", "kind": "digest", "text": "[digest] · reply:"}]}}
DONE_RUN_SHAPE = {"exit": 0, "out": {"ok": True, "exitCode": 0, "threadId": "th-1", "state": "completed",
                                     "reply": {"text": "hotovo z run", "files": ["report.md"]}}}
RUNNING = {"exit": 4, "out": {"ok": False, "exitCode": 4, "threadId": "th-1", "state": "timed-out"}}
FAILED = {"exit": 1, "out": {"status": "settled", "state": "failed", "taskId": "th-1",
                             "job": {"state": "failed", "reason": "the engine exited", "needsInput": []},
                             "messages": []}}
QUESTION = {"exit": 3, "out": {"ok": False, "exitCode": 3, "threadId": "th-1", "state": "needs-input",
                               "job": {"needsInput": [{"botName": "budicek-test",
                                                       "question": "Smím smazat složku tmp?"}]}}}
DOWN = {"exit": 5, "out": {"ok": False, "exitCode": 5, "error": "cannot reach OpenMausBot"}}


class BudicekTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = self.tmp.name
        self.fake = os.path.join(root, "fake")
        self.state = os.path.join(root, "state")
        bindir = os.path.join(root, "bin")
        for p in (self.fake, bindir):
            os.makedirs(p)
        self.bindir = bindir
        self.t3_home = os.path.join(root, "t3-buddy")
        self.t3_runtime = os.path.join(self.t3_home, "runtime", "versions", T3_VERSION, "t3")
        self.t3_unit = os.path.join(root, ".config", "systemd", "user", "lazurio-t3-buddy.service")
        os.makedirs(os.path.dirname(self.t3_runtime))
        os.makedirs(os.path.dirname(self.t3_unit))
        for path, src in (
            (os.path.join(bindir, "hermes"), FAKE_HERMES),
            (os.path.join(bindir, "openmausbot"), FAKE_MAUSBOT),
            (os.path.join(bindir, "ssh"), FAKE_SSH),
            (os.path.join(bindir, "t3"), DECOY_T3),
            (self.t3_runtime, FAKE_T3),
        ):
            with open(path, "w") as fh:
                fh.write(f"#!{sys.executable}\n{src}")
            os.chmod(path, 0o755)
        self.write_unit()
        self.env = {
            "PATH": bindir + os.pathsep + os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": root,
            "FAKE_DIR": self.fake,
            "BUDICEK_STATE_DIR": self.state,
            "BUDICEK_T3_HOME": self.t3_home,
            "BUDICEK_TELEGRAM_CHAT_ID": "111",
            "BUDICEK_POLL_SECONDS": "0",
            # A fictional user's persona: her name's two cases and her Buddy's name.
            "BUDICEK_USER_ACCUSATIVE": "Alenu",
            "BUDICEK_USER_DATIVE": "Aleně",
            "BUDICEK_BUDDY_NAME": "Rex",
        }

    def tearDown(self):
        self.tmp.cleanup()

    # -- helpers

    def write_unit(self, start=None):
        """The unit of Buddy's T3 Code with `ExecStart=<start>`, by default as
        Machines render it."""
        start = start or f"{self.t3_runtime} serve --base-dir {self.t3_home} --host 127.0.0.1 --port 3774"
        with open(self.t3_unit, "w") as fh:
            fh.write(T3_UNIT.format(start=start))

    def path_t3_runs(self):
        path = os.path.join(self.fake, "path-t3.jsonl")
        if not os.path.exists(path):
            return []
        with open(path) as fh:
            return [json.loads(line) for line in fh]

    def budicek(self, *args, stdin=None, **env):
        e = dict(self.env, **env)
        return subprocess.run([sys.executable, BUDICEK, *args], input=stdin, capture_output=True,
                              text=True, env=e, timeout=60)

    def mausbot_says(self, **cfg):
        with open(os.path.join(self.fake, "mausbot.json"), "w") as fh:
            json.dump(cfg, fh)

    def zadej(self, termin="30m", extra=(), **env):
        p = self.budicek("zadej", "--bot", "budicek-test", "--termin", termin, "--nazev", "TEST budíčku",
                         *extra, stdin="Odpověz jedním slovem: hotovo.", **env)
        return p

    def zadej_ok(self, **kw):
        p = self.zadej(**kw)
        self.assertEqual(p.returncode, 0, p.stderr)
        return json.loads(p.stdout)["id"]

    def hlidej(self, **env):
        p = self.budicek("hlidej", "--jednou", **env)
        self.assertEqual(p.returncode, 0, p.stderr)
        return p

    def rec(self, rec_id):
        with open(os.path.join(self.state, rec_id + ".json")) as fh:
            return json.load(fh)

    def only_id(self):
        ids = [n[:-5] for n in os.listdir(self.state) if n.endswith(".json")]
        self.assertEqual(len(ids), 1)
        return ids[0]

    def hermes_state(self):
        path = os.path.join(self.fake, "hermes.json")
        if not os.path.exists(path):
            return {"tasks": {}, "events": [], "sends": []}
        with open(path) as fh:
            return json.load(fh)

    def wakes(self):
        return self.hermes_state()["events"]

    def t3_state(self):
        path = os.path.join(self.fake, "t3.json")
        if not os.path.exists(path):
            return {"calls": [], "sends": [], "messages": []}
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)

    def messages(self):
        """What reached Buddy's thread: one message per key, as T3 Code keeps it."""
        return self.t3_state()["messages"]

    def calls(self, verb=None):
        path = os.path.join(self.fake, "mausbot-calls.jsonl")
        if not os.path.exists(path):
            return []
        with open(path) as fh:
            calls = [json.loads(line) for line in fh]
        return [c for c in calls if verb is None or c["argv"][0] == verb]

    # -- outcomes

    def test_done_wakes_exactly_once(self):
        self.mausbot_says(wait=[RUNNING, DONE])
        rid = self.zadej_ok()
        run = self.calls("run")[0]
        self.assertIn("--wait", run["argv"])
        self.assertEqual(run["argv"][run["argv"].index("--wait") + 1], "none")
        self.assertIn("Pracuješ pro Buddyho: Buddy za Alenu. Úkol " + rid, run["stdin"])
        self.assertIn("nic nepublikuj", run["stdin"])
        self.assertIn("Odpověz jedním slovem: hotovo.", run["stdin"])
        # files go to the task's own folder as an absolute path, never into the Folder
        self.assertIn(f"ukládej do `{self.tmp.name}/Documents/buddy/{rid}/`", run["stdin"])
        self.assertIn("do kořene ~/Lazurio nikdy nic", run["stdin"])
        self.assertFalse(os.path.exists(os.path.join(self.tmp.name, "Documents")))  # the bot creates it
        self.assertEqual(self.rec(rid)["stav"], "bezi")
        self.assertEqual(self.wakes(), [])
        # a broken record next to it must not stop the round
        with open(os.path.join(self.state, "rozbity.json"), "w") as fh:
            fh.write("{nope")
        self.hlidej()
        self.assertEqual(self.wakes(), [])
        self.hlidej()
        self.hlidej()
        self.hlidej()
        rec = self.rec(rid)
        self.assertEqual(rec["stav"], "probuzen")
        self.assertEqual(rec["vysledek_stav"], "HOTOVO")
        self.assertEqual(rec["vysledek"], "hotovo")
        wakes = self.wakes()
        self.assertEqual(len(wakes), 1)
        self.assertTrue(wakes[0]["summary"].startswith("HOTOVO: hotovo"))
        self.assertIn(rid, wakes[0]["title"])
        self.assertLessEqual(len(wakes[0]["summary"]), 200)
        p = self.budicek("vysledek", rid)
        self.assertIn("hotovo", p.stdout)
        p = self.budicek("potvrd", rid)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(self.rec(rid)["stav"], "vyrizeno")
        p = self.budicek("seznam", "--otevrene", "--json")
        self.assertEqual(json.loads(p.stdout), [])

    def test_done_with_reply_field(self):
        self.mausbot_says(wait=[DONE_RUN_SHAPE])
        rid = self.zadej_ok()
        self.hlidej()
        self.assertEqual(self.rec(rid)["vysledek"], "hotovo z run\n\nSoubory: report.md")

    def test_failed_wakes(self):
        self.mausbot_says(wait=[FAILED])
        rid = self.zadej_ok()
        self.hlidej()
        rec = self.rec(rid)
        self.assertEqual(rec["vysledek_stav"], "SELHAL")
        self.assertIn("the engine exited", rec["vysledek"])
        self.assertEqual(len(self.wakes()), 1)

    def test_needs_input_wakes_with_question(self):
        self.mausbot_says(wait=[QUESTION])
        rid = self.zadej_ok()
        self.hlidej()
        rec = self.rec(rid)
        self.assertEqual(rec["vysledek_stav"], "PTÁ SE")
        self.assertIn("Smím smazat složku tmp?", rec["vysledek"])
        wakes = self.wakes()
        self.assertEqual(len(wakes), 1)
        self.assertIn("Smím smazat složku tmp?", wakes[0]["summary"])
        # Buddy answered the bot and wants the end of the job too
        p = self.budicek("potvrd", rid, "--hlidej-dal", "--termin", "10m")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.mausbot_says(wait=[DONE])
        self.hlidej()
        self.assertEqual(self.rec(rid)["vysledek_stav"], "HOTOVO")
        self.assertEqual(len(self.wakes()), 2)

    def test_deadline_interrupts_and_wakes(self):
        self.mausbot_says(wait=[RUNNING])
        rid = self.zadej_ok(termin="2s")
        self.hlidej()
        self.assertEqual(self.rec(rid)["stav"], "bezi")
        self.assertEqual(self.calls("interrupt"), [])
        time.sleep(2.2)
        self.hlidej()
        interrupt = self.calls("interrupt")
        self.assertEqual(len(interrupt), 1)
        self.assertIn("--tree", interrupt[0]["argv"])
        self.assertIn("th-1", interrupt[0]["argv"])
        rec = self.rec(rid)
        self.assertEqual(rec["vysledek_stav"], "NESTIHL TERMÍN")
        self.assertEqual(len(self.wakes()), 1)
        self.hlidej()
        self.assertEqual(len(self.calls("interrupt")), 1)
        self.assertEqual(len(self.wakes()), 1)

    def test_unreachable_wakes_after_grace(self):
        self.mausbot_says(wait=[DOWN])
        rid = self.zadej_ok()
        env = {"BUDICEK_UNREACHABLE_SECONDS": "1"}
        self.hlidej(**env)
        rec = self.rec(rid)
        self.assertEqual(rec["stav"], "bezi")
        self.assertTrue(rec["nedostupny_od_ts"])
        self.assertEqual(self.wakes(), [])
        time.sleep(1.2)
        self.hlidej(**env)
        self.assertEqual(self.rec(rid)["vysledek_stav"], "MAUSBOT NEODPOVÍDÁ")
        self.assertEqual(len(self.wakes()), 1)

    def test_short_outage_does_not_wake(self):
        self.mausbot_says(wait=[DOWN, RUNNING, DONE])
        rid = self.zadej_ok()
        self.hlidej()
        self.hlidej()
        self.assertIsNone(self.rec(rid)["nedostupny_od_ts"])
        self.assertEqual(self.wakes(), [])
        self.hlidej()
        self.assertEqual(self.rec(rid)["vysledek_stav"], "HOTOVO")

    def test_start_failure_wakes_immediately(self):
        self.mausbot_says(run=DOWN)
        p = self.zadej()
        self.assertEqual(p.returncode, 1)
        rid = json.loads(p.stdout)["id"]
        rec = self.rec(rid)
        self.assertEqual(rec["vysledek_stav"], "NESPUSTIL SE")
        self.assertEqual(rec["stav"], "probuzen")
        wakes = self.wakes()
        self.assertEqual(len(wakes), 1)
        self.assertTrue(wakes[0]["summary"].startswith("NESPUSTIL SE: "))
        self.hlidej()
        self.assertEqual(len(self.wakes()), 1)

    def test_no_wake_path_means_no_bot(self):
        p = self.zadej(FAKE_HERMES_FAIL="create")
        self.assertEqual(p.returncode, 1)
        rid = json.loads(p.stdout)["id"]
        self.assertEqual(self.rec(rid)["stav"], "nezalozen")
        self.assertEqual(self.calls("run"), [])

    def test_no_ack_rewakes_twice_then_messages_the_user(self):
        self.mausbot_says(wait=[DONE])
        rid = self.zadej_ok()
        env = {"BUDICEK_ACK_SECONDS": "0"}
        self.hlidej(**env)  # first wake
        self.hlidej(**env)  # second
        self.hlidej(**env)  # third
        wakes = self.wakes()
        self.assertEqual(len(wakes), 3)
        self.assertEqual([w["key"] for w in wakes], [rid, rid + "#2", rid + "#3"])
        self.assertEqual(self.hermes_state()["sends"], [])
        self.hlidej(**env)  # no ack after the second re-wake: message the user
        sends = self.hermes_state()["sends"]
        self.assertEqual(len(sends), 1)
        self.assertEqual(sends[0]["to"], "telegram:111")
        self.assertEqual(
            sends[0]["text"],
            f"Rex se neprobudil k úkolu TEST budíčku ({rid}). Výsledek: budicek vysledek {rid}.",
        )
        self.assertEqual(self.rec(rid)["stav"], "eskalovano")
        self.hlidej(**env)
        self.assertEqual(len(self.wakes()), 3)
        self.assertEqual(len(self.hermes_state()["sends"]), 1)

    def test_ack_stops_rewakes(self):
        self.mausbot_says(wait=[DONE])
        rid = self.zadej_ok()
        self.hlidej(BUDICEK_ACK_SECONDS="0")
        self.budicek("potvrd", rid)
        self.hlidej(BUDICEK_ACK_SECONDS="0")
        self.hlidej(BUDICEK_ACK_SECONDS="0")
        self.assertEqual(len(self.wakes()), 1)
        self.assertEqual(self.rec(rid)["stav"], "vyrizeno")

    def test_archived_card_still_wakes(self):
        self.mausbot_says(wait=[DONE])
        rid = self.zadej_ok()
        card = self.rec(rid)["kanban"][rid]
        subprocess.run([os.path.join(self.tmp.name, "bin", "hermes"), "kanban", "archive", card],
                       env=self.env, check=True, capture_output=True)
        self.hlidej()
        self.assertEqual(self.rec(rid)["stav"], "probuzen")
        self.assertEqual(len(self.wakes()), 1)

    # -- restart between any two steps

    def assert_one_wake_after_restart(self, crash_at, phase):
        self.mausbot_says(wait=[DONE])
        crash = {"BUDICEK_TEST_CRASH_AT": crash_at}
        if phase == "zadej":
            p = self.zadej(**crash)
            self.assertEqual(p.returncode, 99, (crash_at, p.stderr))
            self.assertEqual(self.wakes(), [])
        else:
            self.zadej_ok()
            p = self.budicek("hlidej", "--jednou", **crash)
            self.assertEqual(p.returncode, 99, (crash_at, p.stderr))
        rid = self.only_id()
        for _ in range(3):
            self.hlidej()
        self.assertEqual(self.rec(rid)["stav"], "probuzen", crash_at)
        self.assertEqual(len(self.wakes()), 1, crash_at)

    def test_restart_during_zadej_after_record(self):
        self.assert_one_wake_after_restart("after_record", "zadej")
        self.assertEqual(self.calls("run"), [])
        self.assertEqual(self.rec(self.only_id())["vysledek_stav"], "NESPUSTIL SE")

    def test_restart_during_zadej_after_card(self):
        self.assert_one_wake_after_restart("after_create", "zadej")

    def test_restart_during_zadej_after_subscription(self):
        self.assert_one_wake_after_restart("after_subscribe", "zadej")

    def test_restart_during_zadej_after_bot_start(self):
        self.assert_one_wake_after_restart("after_run", "zadej")
        self.assertIn("už mohl začít", self.rec(self.only_id())["vysledek"])

    def test_restart_after_outcome_saved(self):
        self.assert_one_wake_after_restart("after_outcome", "hlidej")
        self.assertEqual(self.rec(self.only_id())["vysledek_stav"], "HOTOVO")

    def test_restart_after_card_completed(self):
        self.assert_one_wake_after_restart("after_complete", "hlidej")

    def test_restart_during_rewake(self):
        self.mausbot_says(wait=[DONE])
        rid = self.zadej_ok()
        self.hlidej()
        p = self.budicek("hlidej", "--jednou", BUDICEK_ACK_SECONDS="0", BUDICEK_TEST_CRASH_AT="after_rewake_saved")
        self.assertEqual(p.returncode, 99)
        self.assertEqual(len(self.wakes()), 1)
        self.hlidej()
        self.hlidej()
        self.assertEqual([w["key"] for w in self.wakes()], [rid, rid + "#2"])
        p = self.budicek("hlidej", "--jednou", BUDICEK_ACK_SECONDS="0", BUDICEK_TEST_CRASH_AT="after_complete")
        self.assertEqual(p.returncode, 99)
        self.hlidej()
        self.assertEqual([w["key"] for w in self.wakes()], [rid, rid + "#2", rid + "#3"])

    # -- another Environment

    def test_remote_environment_goes_over_ssh(self):
        self.mausbot_says(wait=[DONE])
        rid = self.zadej_ok(extra=("--env", "work-env"))
        self.hlidej()
        with open(os.path.join(self.fake, "ssh-calls.jsonl")) as fh:
            ssh = [json.loads(line)["argv"] for line in fh]
        self.assertEqual(len(ssh), 2)
        self.assertIn("work-env", ssh[0])
        self.assertTrue(ssh[0][-1].startswith("openmausbot run budicek-test - --wait none"))
        self.assertTrue(ssh[1][-1].startswith("openmausbot wait --thread th-1"))
        self.assertIn("Odpověz jedním slovem", self.calls("run")[0]["stdin"])
        # that Environment's home is not known here, so its own `~` and an absolute path
        self.assertIn(f"ukládej do `~/Documents/buddy/{rid}/`", self.calls("run")[0]["stdin"])
        self.assertNotIn(self.tmp.name, self.calls("run")[0]["stdin"])
        self.assertEqual(self.rec(rid)["vysledek_stav"], "HOTOVO")
        self.assertEqual(len(self.wakes()), 1)

    def test_remote_environment_unreachable(self):
        self.mausbot_says(wait=[DONE])
        rid = self.zadej_ok(extra=("--env", "work-env"))
        env = {"FAKE_SSH_DOWN": "1", "BUDICEK_UNREACHABLE_SECONDS": "0"}
        self.hlidej(**env)
        self.assertEqual(self.rec(rid)["vysledek_stav"], "MAUSBOT NEODPOVÍDÁ")
        self.assertEqual(len(self.wakes()), 1)

    def test_thread_watcher_brief(self):
        rid = self.zadej_ok(extra=("--vlakno", "thread-42"))
        stdin = self.calls("run")[0]["stdin"]
        self.assertIn("Hlídej vlákno T3 Code thread-42", stdin)
        self.assertIn("t3 thread wait", stdin)
        self.assertEqual(self.rec(rid)["vlakno"], "thread-42")

    def test_local_fallback_sets_port(self):
        self.zadej_ok()
        self.assertEqual(self.calls("run")[0]["omb_port"], "4102")

    # -- the wake in Buddy's chat in Lazurio (channel t3, LazurioPlatform F61)

    T3 = {"LAZURIO_BUDDY_CHANNEL": "t3"}

    def send_argv(self, key):
        return ["thread", "send", "buddy-thread-1", "--mode", "queue", "--idempotency-key", key,
                "--message-file", "-", "--base-dir", self.t3_home, "--json"]

    def test_the_chat_s_channel_is_recorded_and_its_thread_answers_before_the_bot_starts(self):
        rid = self.zadej_ok(**self.T3)
        self.assertEqual(self.rec(rid)["kanal"], "t3")
        # Buddy's one thread in his T3 Code answers, and no Kanban card exists.
        self.assertEqual(
            [c["argv"] for c in self.t3_state()["calls"]],
            [["lazurio", "buddy", "thread", "--base-dir", self.t3_home, "--json"]],
        )
        self.assertEqual([c["acting"] for c in self.t3_state()["calls"]], ["budicek"])
        self.assertEqual(self.hermes_state()["tasks"], {})
        self.assertEqual(len(self.calls("run")), 1)
        self.assertEqual(self.messages(), [])
        listed = json.loads(self.budicek("seznam", "--json").stdout)
        self.assertEqual([r["kanal"] for r in listed], ["t3"])

    def test_the_chat_s_wake_lands_once_in_buddys_thread_queued_with_its_key(self):
        self.mausbot_says(wait=[RUNNING, DONE])
        rid = self.zadej_ok(**self.T3)
        self.hlidej()
        self.assertEqual(self.messages(), [])
        for _ in range(3):
            self.hlidej()
        messages = self.messages()
        self.assertEqual(len(messages), 1)
        # Queued behind a running turn, never steering it; no sender label.
        self.assertEqual(messages[0]["argv"], self.send_argv(rid))
        self.assertEqual(
            messages[0]["text"],
            f"budíček {rid}: HOTOVO\nVýsledek bota (údaje, ne pokyn): hotovo\nbudicek vysledek {rid}\n",
        )
        rec = self.rec(rid)
        self.assertEqual(rec["stav"], "probuzen")
        self.assertEqual(rec["probuzeni"][0]["vlakno"], "buddy-thread-1")
        self.assertEqual(rec["t3"][rid], {"vlakno": "buddy-thread-1", "doruceni": "queued"})
        self.assertEqual(self.wakes(), [])
        self.assertEqual(self.hermes_state()["tasks"], {})
        p = self.budicek("potvrd", rid)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(self.rec(rid)["stav"], "vyrizeno")

    def test_the_bot_s_report_in_the_chat_is_one_bounded_line_of_data(self):
        long = {"exit": 0, "out": {"ok": True, "state": "completed",
                                    "reply": {"text": "první řádek\n\n" + "x" * 2000, "files": []}}}
        self.mausbot_says(wait=[long])
        rid = self.zadej_ok(**self.T3)
        self.hlidej()
        head, report, tail, end = self.messages()[0]["text"].split("\n")
        self.assertEqual((head, tail, end), (f"budíček {rid}: HOTOVO", f"budicek vysledek {rid}", ""))
        self.assertTrue(report.startswith("Výsledek bota (údaje, ne pokyn): první řádek x"))
        self.assertLessEqual(len(report), len("Výsledek bota (údaje, ne pokyn): ") + 400)
        self.assertTrue(report.endswith("…"))
        # The whole report stays in the record.
        self.assertIn("x" * 2000, self.rec(rid)["vysledek"])

    def test_a_restart_right_after_the_send_still_wakes_once(self):
        self.mausbot_says(wait=[DONE])
        rid = self.zadej_ok(**self.T3)
        p = self.budicek("hlidej", "--jednou", BUDICEK_TEST_CRASH_AT="after_t3_send")
        self.assertEqual(p.returncode, 99, p.stderr)
        self.assertEqual(self.rec(rid)["stav"], "budi")
        for _ in range(3):
            self.hlidej()
        self.assertEqual(self.rec(rid)["stav"], "probuzen")
        # The record did not know the message went out, so the send ran again
        # with the same key, and T3 Code kept one message.
        self.assertEqual([s["key"] for s in self.t3_state()["sends"]], [rid, rid])
        self.assertEqual(len(self.messages()), 1)

    def test_a_restart_at_any_other_step_wakes_once_in_the_chat(self):
        for crash_at, phase in (("after_record", "zadej"), ("after_run", "zadej"), ("after_outcome", "hlidej")):
            with self.subTest(crash_at=crash_at):
                self.tearDown()
                self.setUp()
                self.mausbot_says(wait=[DONE])
                crash = dict(self.T3, BUDICEK_TEST_CRASH_AT=crash_at)
                if phase == "zadej":
                    self.assertEqual(self.zadej(**crash).returncode, 99)
                else:
                    self.zadej_ok(**self.T3)
                    self.assertEqual(self.budicek("hlidej", "--jednou", BUDICEK_TEST_CRASH_AT=crash_at).returncode, 99)
                rid = self.only_id()
                for _ in range(3):
                    self.hlidej()
                self.assertEqual(self.rec(rid)["stav"], "probuzen")
                self.assertEqual([m["key"] for m in self.messages()], [rid])
                self.assertEqual(self.wakes(), [])

    def test_while_the_chat_s_t3_code_is_down_the_wake_waits_and_lands_once(self):
        self.mausbot_says(wait=[DONE])
        rid = self.zadej_ok(**self.T3)
        self.hlidej(FAKE_T3_DOWN="1")
        self.hlidej(FAKE_T3_DOWN="1")
        self.assertEqual(self.rec(rid)["stav"], "budi")
        self.assertEqual(self.messages(), [])
        self.hlidej()
        self.hlidej()
        self.assertEqual(self.rec(rid)["stav"], "probuzen")
        self.assertEqual(len(self.messages()), 1)

    def test_without_buddys_thread_no_bot_starts(self):
        p = self.zadej(FAKE_T3_NO_THREAD="1", **self.T3)
        self.assertEqual(p.returncode, 1)
        rid = json.loads(p.stdout)["id"]
        self.assertEqual(self.rec(rid)["stav"], "nezalozen")
        self.assertEqual(self.calls("run"), [])
        self.assertEqual(self.messages(), [])

    def test_a_bot_that_does_not_start_wakes_the_chat_at_once(self):
        self.mausbot_says(run=DOWN)
        p = self.zadej(**self.T3)
        self.assertEqual(p.returncode, 1)
        rid = json.loads(p.stdout)["id"]
        self.assertEqual([m["key"] for m in self.messages()], [rid])
        self.assertTrue(self.messages()[0]["text"].startswith(f"budíček {rid}: NESPUSTIL SE\n"))
        self.hlidej()
        self.assertEqual(len(self.messages()), 1)

    def test_a_question_and_watching_on_wake_the_chat_twice(self):
        self.mausbot_says(wait=[QUESTION])
        rid = self.zadej_ok(**self.T3)
        self.hlidej()
        self.assertIn("Smím smazat složku tmp?", self.messages()[0]["text"])
        p = self.budicek("potvrd", rid, "--hlidej-dal")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.mausbot_says(wait=[DONE])
        self.hlidej()
        self.assertEqual([m["key"] for m in self.messages()], [rid, rid + ".k2"])

    def test_the_chat_s_rewakes_follow_it_and_the_last_resort_is_telegram(self):
        self.mausbot_says(wait=[DONE])
        rid = self.zadej_ok(**self.T3)
        env = {"BUDICEK_ACK_SECONDS": "0"}
        for _ in range(4):  # the wake, two re-wakes, then the message
            self.hlidej(**env)
        messages = self.messages()
        self.assertEqual([m["key"] for m in messages], [rid, rid + "#2", rid + "#3"])
        self.assertTrue(messages[1]["text"].startswith(f"budíček {rid}: HOTOVO (znovu, 2. budík)\n"))
        self.assertEqual(self.wakes(), [])
        self.assertEqual([s["to"] for s in self.hermes_state()["sends"]], ["telegram:111"])
        self.assertEqual(self.rec(rid)["stav"], "eskalovano")

    def test_an_unknown_channel_starts_nothing(self):
        for wrong in ("lazurio_web", "T3", "telegram", "t3:buddy"):
            p = self.zadej(LAZURIO_BUDDY_CHANNEL=wrong)
            self.assertEqual(p.returncode, 2, wrong)
            self.assertIn("kanál", p.stderr)
        self.assertFalse(os.path.exists(self.state) and os.listdir(self.state))
        self.assertEqual(self.hermes_state()["tasks"], {})
        self.assertEqual(self.calls("run"), [])
        self.assertEqual(self.t3_state()["calls"], [])

    def test_budicek_acts_as_budicek_in_its_own_t3_only_even_inside_buddys_environment(self):
        # `zadej` runs in Buddy's environment, which names him (and the user);
        # T3 Code refuses `budicek` beside a name, so budíček's own `t3` drops them.
        buddy = dict(self.T3, T3CODE_ACTING_SENDER="buddy", T3CODE_ACTING_FOR="Ada",
                     T3CODE_ACTING_FOR_ACCUSATIVE="Adu")
        self.mausbot_says(wait=[DONE])
        rid = self.zadej_ok(**buddy)
        self.hlidej()
        calls = self.t3_state()["calls"]
        self.assertEqual([(c["acting"], c["named"]) for c in calls], [("budicek", False)] * 3)
        self.assertEqual([m["acting"] for m in self.messages()], ["budicek"])
        self.assertEqual(self.rec(rid)["stav"], "probuzen")
        # Nothing else budíček runs acts as budíček: not the bot's start that
        # came after the thread's lookup, not the service's MausBot or Hermes.
        self.assertEqual([c["acting"] for c in self.calls()], ["buddy", None])
        self.assertNotIn("budicek", self.hermes_state().get("acting", []))

    # The refusals `t3 thread send` names final (Lazurio/t3code#105, its
    # docs/user/agent-cli.md): sending the same key again never helps.
    FINAL = ("idempotency_conflict", "command_rejected", "thread_not_found", "thread_not_sendable",
             "invalid_request", "capability_denied", "runtime_mode_escalation_denied",
             "interaction_mode_escalation_denied")

    def test_a_final_refusal_ends_the_chat_s_wake_and_wakes_buddy_once_in_telegram(self):
        for refusal in self.FINAL:
            with self.subTest(refusal=refusal):
                self.tearDown()
                self.setUp()
                self.mausbot_says(wait=[DONE])
                rid = self.zadej_ok(**self.T3)
                self.hlidej(FAKE_T3_REFUSE=refusal)
                rec = self.rec(rid)
                self.assertEqual(rec["stav"], "probuzen")
                # Recorded with its code, in the record and in its history.
                self.assertEqual(rec["t3"][rid], {"vlakno": "buddy-thread-1", "odmitnuto": refusal})
                notes = [h["udalost"] for h in rec["historie"]]
                self.assertIn(
                    f"T3 Code natrvalo odmítl budík {rid} ({refusal}: T3 Code refused the message.), budím v Telegramu",
                    notes,
                )
                # The result still reaches Buddy: one Kanban wake, as without the channel.
                wakes = self.wakes()
                self.assertEqual([w["key"] for w in wakes], [rid])
                self.assertTrue(wakes[0]["summary"].startswith("HOTOVO: hotovo"))
                self.assertEqual(rec["probuzeni"], [{"budik": 1, "karta": rec["kanban"][rid], "at": rec["probuzen"]}])
                self.assertEqual(self.messages(), [])
                # Later rounds never send that wake to T3 Code again.
                self.hlidej()
                self.hlidej()
                self.assertEqual([s["key"] for s in self.t3_state()["sends"]], [rid])
                self.assertEqual(len(self.wakes()), 1)
                p = self.budicek("potvrd", rid)
                self.assertEqual(p.returncode, 0, p.stderr)
                self.assertEqual(self.rec(rid)["stav"], "vyrizeno")

    def test_a_restart_after_a_final_refusal_still_wakes_buddy_once_in_telegram(self):
        for crash_at in ("after_t3_refused", "after_create", "after_subscribe", "after_complete"):
            with self.subTest(crash_at=crash_at):
                self.tearDown()
                self.setUp()
                self.mausbot_says(wait=[DONE])
                rid = self.zadej_ok(**self.T3)
                p = self.budicek("hlidej", "--jednou", FAKE_T3_REFUSE="command_rejected",
                                 BUDICEK_TEST_CRASH_AT=crash_at)
                self.assertEqual(p.returncode, 99, (crash_at, p.stderr))
                for _ in range(3):
                    self.hlidej()
                self.assertEqual(self.rec(rid)["stav"], "probuzen")
                self.assertEqual([w["key"] for w in self.wakes()], [rid])
                # The refusal was recorded before the card: never sent again.
                self.assertEqual([s["key"] for s in self.t3_state()["sends"]], [rid])
                self.assertEqual(self.messages(), [])

    def test_a_failure_that_may_pass_keeps_its_key_and_the_wake_lands_once_in_the_chat(self):
        # Nothing went out, and nothing says sending again cannot help: the
        # same key every round until T3 Code takes it, and no Telegram wake.
        for passing in ("orchestration_error", "request_failed", "auth_unavailable", "a_code_of_tomorrow"):
            with self.subTest(passing=passing):
                self.tearDown()
                self.setUp()
                self.mausbot_says(wait=[DONE])
                rid = self.zadej_ok(**self.T3)
                self.hlidej(FAKE_T3_FAIL=passing)
                self.hlidej(FAKE_T3_FAIL=passing)
                self.assertEqual(self.rec(rid)["stav"], "budi")
                self.assertNotIn("odmitnuto", json.dumps(self.rec(rid)))
                self.hlidej()
                self.assertEqual(self.rec(rid)["stav"], "probuzen")
                self.assertEqual([s["key"] for s in self.t3_state()["sends"]], [rid, rid, rid])
                self.assertEqual([m["key"] for m in self.messages()], [rid])
                self.assertEqual(self.wakes(), [])

    def test_after_a_final_refusal_a_rewake_tries_the_chat_again_with_its_own_key(self):
        self.mausbot_says(wait=[DONE])
        rid = self.zadej_ok(**self.T3)
        env = {"BUDICEK_ACK_SECONDS": "0"}
        self.hlidej(FAKE_T3_REFUSE="command_rejected", **env)  # the wake: refused, so Telegram
        self.assertEqual([w["key"] for w in self.wakes()], [rid])
        self.hlidej(**env)  # no confirmation: the re-wake reaches the chat
        self.assertEqual([m["key"] for m in self.messages()], [rid + "#2"])
        self.assertEqual(len(self.wakes()), 1)
        self.assertEqual([("karta" in w, w["budik"]) for w in self.rec(rid)["probuzeni"]], [(True, 1), (False, 2)])

    def test_an_answer_that_never_said_what_happened_keeps_the_key_and_the_wake_lands_once(self):
        # The message went out, but its answer was lost (`request_failed`) or
        # had no code `t3` could read (`tool_failed`): the same key again.
        for lost in ("request_failed", "tool_failed", "orchestration_error"):
            with self.subTest(lost=lost):
                self.tearDown()
                self.setUp()
                self.mausbot_says(wait=[DONE])
                rid = self.zadej_ok(**self.T3)
                self.hlidej(FAKE_T3_LOSE_ANSWER=lost)
                self.assertEqual(self.rec(rid)["stav"], "budi")
                self.hlidej()
                self.assertEqual(self.rec(rid)["stav"], "probuzen")
                self.assertEqual([s["key"] for s in self.t3_state()["sends"]], [rid, rid])
                self.assertEqual(len(self.messages()), 1)

    def test_without_the_channel_the_wake_goes_to_telegram_as_before(self):
        self.mausbot_says(wait=[DONE])
        rid = self.zadej_ok(LAZURIO_BUDDY_CHANNEL="")
        self.assertNotIn("kanal", self.rec(rid))
        self.hlidej()
        self.assertEqual(len(self.wakes()), 1)
        self.assertEqual(self.t3_state()["calls"], [])

    def test_a_record_from_before_the_channel_still_wakes_telegram(self):
        # A `verze: 1` record exactly as `zadej` wrote it before `kanal`
        # existed, its outcome saved and its wake still to deliver.
        os.makedirs(self.state, exist_ok=True)
        rec = {
            "id": "20261020-210000-abcd", "verze": 1, "nazev": "starý úkol", "bot": "budicek-test",
            "env": None, "vlakno": None, "zadani": "x", "termin_s": 1800, "termin_ts": time.time() + 1800,
            "termin": "21:30", "zalozeno": "2026-10-20T21:00:00Z", "stav": "budi", "kolo": 1,
            "budik_pokus": 1, "threadId": "th-1", "since": 1234, "spusteni_zahajeno": True,
            "vysledek_stav": "HOTOVO", "vysledek": "hotovo", "historie": [],
        }
        with open(os.path.join(self.state, rec["id"] + ".json"), "w") as fh:
            json.dump(rec, fh)
        self.hlidej()
        self.assertEqual(self.rec(rec["id"])["stav"], "probuzen")
        self.assertEqual(len(self.wakes()), 1)
        self.assertEqual(self.t3_state()["calls"], [])

    # -- Buddy's own t3: the runtime the unit of his T3 Code names (F61's addendum of 2026-10-22)

    def test_budicek_runs_the_runtime_buddys_unit_names_never_the_t3_on_path(self):
        self.mausbot_says(wait=[DONE])
        rid = self.zadej_ok(**self.T3)
        self.hlidej()
        self.assertEqual(self.rec(rid)["stav"], "probuzen")
        self.assertEqual([m["key"] for m in self.messages()], [rid])
        # The thread's lookup at `zadej`, then the lookup and the send: all three
        # ran his runtime, and the Chat's `t3` on PATH never ran.
        self.assertEqual(len(self.t3_state()["calls"]), 3)
        self.assertEqual(self.path_t3_runs(), [])

    def broken_runtimes(self):
        """Ways Buddy's runtime is not there to run, each with the start of
        budíček's message."""
        unit_missing = "jednotka T3 Code Buddyho"
        elsewhere = os.path.join(self.tmp.name, "elsewhere.service")
        versions = os.path.join(self.t3_home, "runtime", "versions")

        def remove_unit():
            os.remove(self.t3_unit)

        def link_unit():
            os.replace(self.t3_unit, elsewhere)
            os.symlink(elsewhere, self.t3_unit)

        def runtime_not_executable():
            os.chmod(self.t3_runtime, 0o644)

        def runtime_missing():
            os.remove(self.t3_runtime)

        def version_leads_out():
            # The version's directory is a link to where the Chat's `t3` is.
            os.rename(os.path.dirname(self.t3_runtime), os.path.join(versions, ".old"))
            os.symlink(self.bindir, os.path.dirname(self.t3_runtime))

        return [
            ("no unit", remove_unit, f"{unit_missing} {self.t3_unit} chybí nebo se nedá přečíst"),
            ("a link to a unit", link_unit, f"{unit_missing} {self.t3_unit} chybí nebo se nedá přečíst"),
            ("the Chat's t3", lambda: self.write_unit(f"{self.bindir}/t3 serve"), f"{unit_missing} {self.t3_unit} nespouští t3"),
            ("~/.local/bin/t3", lambda: self.write_unit(os.path.join(self.tmp.name, ".local/bin/t3") + " serve"),
             f"{unit_missing} {self.t3_unit} nespouští t3"),
            ("no version", lambda: self.write_unit(f"{versions}/../../../bin/t3 serve"), f"{unit_missing} {self.t3_unit} nespouští t3"),
            ("not serve", lambda: self.write_unit(f"{self.t3_runtime} __service-launcher"),
             f"{unit_missing} {self.t3_unit} nespouští t3"),
            ("two ExecStart", lambda: self.write_unit(f"{self.t3_runtime} serve\nExecStart={self.t3_runtime} serve"),
             f"{unit_missing} {self.t3_unit} nespouští t3"),
            ("runtime missing", runtime_missing, f"t3 Buddyho {self.t3_runtime} chybí"),
            ("runtime not executable", runtime_not_executable, f"t3 Buddyho {self.t3_runtime} chybí"),
            ("a version leading out", version_leads_out, f"t3 Buddyho {self.t3_runtime} chybí"),
        ]

    def test_without_buddys_own_runtime_a_chat_delegation_starts_nothing_and_nothing_else_runs(self):
        for why, *_ in self.broken_runtimes():
            with self.subTest(why=why):
                self.tearDown()
                self.setUp()
                _, breaks, says = next(case for case in self.broken_runtimes() if case[0] == why)
                breaks()
                p = self.zadej(**self.T3)
                self.assertEqual(p.returncode, 1, (why, p.stderr))
                out = json.loads(p.stdout)
                self.assertTrue(out["error"].startswith(says), (why, out["error"]))
                self.assertEqual(self.rec(out["id"])["stav"], "nezalozen")
                self.assertEqual(self.calls("run"), [])
                self.assertEqual(self.t3_state()["calls"], [])
                self.assertEqual(self.path_t3_runs(), [])

    def test_when_buddys_runtime_goes_missing_the_wake_waits_and_lands_once_when_it_is_back(self):
        self.mausbot_says(wait=[DONE])
        rid = self.zadej_ok(**self.T3)
        os.chmod(self.t3_runtime, 0o644)
        p = self.hlidej()
        self.assertIn(f"t3 Buddyho {self.t3_runtime} chybí, nedá se spustit nebo vede mimo", p.stderr)
        self.assertEqual(self.rec(rid)["stav"], "budi")
        self.assertEqual(self.wakes(), [])
        self.assertEqual(self.path_t3_runs(), [])
        os.chmod(self.t3_runtime, 0o755)
        self.hlidej()
        self.assertEqual(self.rec(rid)["stav"], "probuzen")
        self.assertEqual([m["key"] for m in self.messages()], [rid])

    # -- the persona's names

    def everything_written(self):
        """Every text budíček produced (records, bot runs, Kanban cards, sends),
        with JSON decoded and written back with ensure_ascii=False: the fakes
        write escaped JSON, in which a name with diacritics would never match."""

        def readable(path):
            with open(path, encoding="utf-8") as fh:
                text = fh.read()
            try:
                return json.dumps(json.loads(text), ensure_ascii=False)
            except ValueError:
                pass
            lines = []
            for line in text.splitlines():
                try:
                    lines.append(json.dumps(json.loads(line), ensure_ascii=False))
                except ValueError:
                    lines.append(line)
            return "\n".join(lines)

        texts = [readable(os.path.join(self.state, n)) for n in sorted(os.listdir(self.state))]
        texts += [readable(os.path.join(self.fake, n)) for n in sorted(os.listdir(self.fake))]
        return "\n".join(texts)

    def escalate(self, **env):
        self.mausbot_says(wait=[DONE])
        rid = self.zadej_ok(**env)
        env = dict(env, BUDICEK_ACK_SECONDS="0")
        for _ in range(4):  # the wake, two re-wakes, then the message
            self.hlidej(**env)
        self.assertEqual(self.rec(rid)["stav"], "eskalovano")
        return rid

    def test_without_a_persona_the_texts_are_neutral(self):
        neutral = {"BUDICEK_USER_ACCUSATIVE": "", "BUDICEK_USER_DATIVE": "", "BUDICEK_BUDDY_NAME": ""}
        rid = self.escalate(**neutral)
        self.assertIn("Pracuješ pro Buddyho: Buddy za uživatele. Úkol " + rid, self.calls("run")[0]["stdin"])
        self.assertEqual(
            self.hermes_state()["sends"][0]["text"],
            f"Buddy se neprobudil k úkolu TEST budíčku ({rid}). Výsledek: budicek vysledek {rid}.",
        )
        written = json.dumps(self.rec(rid), ensure_ascii=False)
        self.assertIn("píšu uživateli", written)
        self.assertIn("zpráva uživateli odeslaná", written)
        written = self.everything_written()
        self.assertIn("Buddy za uživatele", written)
        for name in ("Buddy za Alenu", "píšu Aleně", "zpráva Aleně", "Rex se neprobudil"):
            self.assertNotIn(name, written)

    def test_another_users_persona_leaves_no_trace_of_the_first(self):
        other = {"BUDICEK_USER_ACCUSATIVE": "Boba", "BUDICEK_USER_DATIVE": "Bobovi", "BUDICEK_BUDDY_NAME": "Fido"}
        rid = self.escalate(**other)
        self.assertIn("Pracuješ pro Buddyho: Buddy za Boba. Úkol " + rid, self.calls("run")[0]["stdin"])
        self.assertTrue(self.hermes_state()["sends"][0]["text"].startswith("Fido se neprobudil"))
        self.assertIn("píšu Bobovi", json.dumps(self.rec(rid), ensure_ascii=False))
        written = self.everything_written()
        self.assertIn("Buddy za Boba", written)
        self.assertIn("píšu Bobovi", written)
        for phrase in (
            "Buddy za Alenu", "píšu Aleně", "zpráva Aleně", "Rex se neprobudil",
            "Buddy za uživatele", "píšu uživateli", "zpráva uživateli", "Buddy se neprobudil",
        ):
            self.assertNotIn(phrase, written)


if __name__ == "__main__":
    unittest.main()
