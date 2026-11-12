#!/usr/bin/env python3
"""Drive interactive `claude` in a PTY. Hooks passed with --settings log events to a file.

Usage: claude_pty.py hook|gate|type|interrupt <events.jsonl>

hook:      queue the message in a file during the first Bash call; the PostToolUse hook delivers it.
type:      type the message into the TUI during the first Bash call (the CLI's own queue).
interrupt: press Esc during the first Bash call, then type the message.
gate:      queue the message in a file; the PostToolUse hook (gate_hook.py) signals the boundary and
           waits while the driver types the message into the TUI.
"""
import json, os, pty, select, subprocess, sys, time

MODE, EVENTS = sys.argv[1], os.path.abspath(sys.argv[2])
HERE = os.path.dirname(os.path.abspath(__file__))
QUEUE_FILE = os.path.join(HERE, f"queue-pty-{MODE}.txt")
PROMPT = ("Run these three shell commands one at a time, each as its own Bash tool call: "
          "`sleep 4; echo one`, `sleep 4; echo two`, `sleep 4; echo three`. "
          "Then reply with one short line.")
STEER = "New instruction from the human: after the commands, reply with the single word PINEAPPLE."
open(EVENTS, "w").close()

log_cmd = f"python3 {HERE}/log_hook.py {EVENTS}"
hooks = {e: [{"matcher": "*", "hooks": [{"type": "command", "command": log_cmd}]}]
         for e in ("UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop")}
hooks["PostToolUse"][0]["hooks"].append(
    {"type": "command", "command": f"python3 {HERE}/{'gate_hook' if MODE == 'gate' else 'hold_hook'}.py {QUEUE_FILE}"})

cmd = ["claude", "--model", "haiku", "--setting-sources", "project", "--strict-mcp-config",
       "--allowedTools", "Bash(sleep:*)", "Bash(echo:*)", "--settings", json.dumps({"hooks": hooks})]
master, slave = pty.openpty()
proc = subprocess.Popen(cmd, stdin=slave, stdout=slave, stderr=slave, cwd=HERE, close_fds=True)
screen = open(EVENTS.replace(".jsonl", ".screen.txt"), "wb")
os.close(slave)
t0 = time.time()

def note(s):
    with open(EVENTS, "a") as f:
        f.write(json.dumps({"t": round(time.time() - t0, 2), "driver": s}) + "\n")

def drain(seconds):
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([master], [], [], 0.2)
        if r:
            try:
                screen.write(os.read(master, 65536))
            except OSError:
                return

def type_line(text):
    os.write(master, text.encode())
    drain(0.5)
    os.write(master, b"\r")

def events():
    return [json.loads(l) for l in open(EVENTS)]

def wait_event(name, n=1, timeout=120):
    end = time.time() + timeout
    while time.time() < end:
        drain(0.3)
        if sum(1 for e in events() if e.get("hook_event_name") == name) >= n:
            return
    raise SystemExit("timeout waiting for " + name)

drain(10)
note("type prompt")
type_line(PROMPT)
wait_event("PreToolUse")
drain(1)
if MODE == "hook":
    note("TED queues the message in its store")
    open(QUEUE_FILE, "w").write(STEER)
    wait_event("Stop")
elif MODE == "gate":
    note("TED queues the message in its store")
    open(QUEUE_FILE, "w").write(STEER)
    while not os.path.exists(QUEUE_FILE + ".boundary"):
        drain(0.05)
    note("hook reports a tool-call boundary; TED types the message")
    type_line(STEER)
    wait_event("UserPromptSubmit", n=2, timeout=10)
    open(QUEUE_FILE + ".delivered", "w").close()
    wait_event("Stop")
    drain(8)
elif MODE == "type":
    note("type message into the TUI mid-turn")
    type_line(STEER)
    wait_event("Stop")
    drain(8)
elif MODE == "interrupt":
    note("press Esc")
    os.write(master, b"\x1b")
    drain(3)
    note("type message")
    type_line(STEER)
    wait_event("Stop")
drain(2)
proc.terminate()
