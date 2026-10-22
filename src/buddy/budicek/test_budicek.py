#!/usr/bin/env python3
"""Contract tests for budicek with fake `openmausbot`, `hermes` and `ssh` on PATH.

A "wake" is what Hermes delivers to Buddy: a `completed` event on a Kanban card
that has a `wake` subscription. The fake `hermes` records exactly those, so the
tests count wakes the way the real gateway would see them.
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
    fh.write(json.dumps({"argv": a, "stdin": stdin, "omb_port": os.environ.get("OMB_PORT")}) + "\n")
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
        for name, src in (("hermes", FAKE_HERMES), ("openmausbot", FAKE_MAUSBOT), ("ssh", FAKE_SSH)):
            path = os.path.join(bindir, name)
            with open(path, "w") as fh:
                fh.write(f"#!{sys.executable}\n{src}")
            os.chmod(path, 0o755)
        self.env = {
            "PATH": bindir + os.pathsep + os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": root,
            "FAKE_DIR": self.fake,
            "BUDICEK_STATE_DIR": self.state,
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
