#!/usr/bin/env python3
"""Drive `claude -p --input-format stream-json --output-format stream-json` and log every line.

Usage: claude_stream.py direct|hook|hook-delete|gate|now|interrupt|hold <transcript.jsonl>

direct:      write the second user message to stdin during the first Bash call.
hook:        put the message in a queue file during the first Bash call; a PostToolUse hook
             (hold_hook.py, passed with --settings) delivers it at the next tool-call boundary.
hook-delete: like hook, but remove the queue file before the boundary (Delete).
gate:        put the message in a queue file; a PostToolUse hook (gate_hook.py) signals the boundary
             and waits; the driver then writes the message to stdin as a normal user message.
now:         write the message with priority "now" and origin human during the first Bash call.
interrupt:   send a control_request interrupt during the first Bash call, then a user message.
hold:        keep the message in this script until the `result` event, then write it.
"""
import json, os, queue, subprocess, sys, threading, time

MODE, OUT = sys.argv[1], sys.argv[2]
HERE = os.path.dirname(os.path.abspath(__file__))
QUEUE_FILE = os.path.join(HERE, f"queue-{MODE}.txt")
PROMPT = ("Run these three shell commands one at a time, each as its own Bash tool call: "
          "`sleep 4; echo one`, `sleep 4; echo two`, `sleep 4; echo three`. "
          "Then reply with one short line.")
STEER = "New instruction from the human: after the commands, reply with the single word PINEAPPLE."

settings = {}
if MODE == "gate":
    settings = {"hooks": {"PostToolUse": [{"matcher": "*", "hooks": [
        {"type": "command", "command": f"python3 {HERE}/gate_hook.py {QUEUE_FILE}"}]}]}}
if MODE.startswith("hook"):
    settings = {"hooks": {"PostToolUse": [{"matcher": "*", "hooks": [
        {"type": "command", "command": f"python3 {HERE}/hold_hook.py {QUEUE_FILE}"}]}]}}

cmd = ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json",
       "--verbose", "--replay-user-messages", "--include-hook-events",
       "--model", "haiku", "--setting-sources", "project", "--strict-mcp-config",
       "--no-session-persistence", "--allowedTools", "Bash(sleep:*)", "Bash(echo:*)", "--settings", json.dumps(settings)]

t0 = time.time()
log = open(OUT, "w")
proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                        stderr=subprocess.DEVNULL, text=True, bufsize=1, cwd=HERE)
inbox = queue.Queue()

def rec(direction, msg):
    log.write(json.dumps({"t": round(time.time() - t0, 2), "dir": direction, "msg": msg}) + "\n")
    log.flush()

def send(msg):
    rec("->", msg)
    proc.stdin.write(json.dumps(msg) + "\n")
    proc.stdin.flush()

def user(text):
    return {"type": "user", "message": {"role": "user", "content": text}}

def reader():
    for line in proc.stdout:
        try:
            m = json.loads(line)
        except ValueError:
            continue
        if m.get("type") == "stream_event":
            continue
        rec("<-", m)
        inbox.put(m)

threading.Thread(target=reader, daemon=True).start()

def wait_for(pred, timeout=180):
    end = time.time() + timeout
    while time.time() < end:
        try:
            m = inbox.get(timeout=1)
        except queue.Empty:
            continue
        if pred(m):
            return m
    raise SystemExit("timeout")

def is_tool_use(m):
    return m.get("type") == "assistant" and any(
        c.get("type") == "tool_use" for c in m["message"]["content"])

is_result = lambda m: m.get("type") == "result"

send(user(PROMPT))
wait_for(is_tool_use)
time.sleep(1)

if MODE == "direct":
    send(user(STEER))
    wait_for(is_result)
    try:
        wait_for(is_result, timeout=30)
    except SystemExit:
        pass
elif MODE in ("hook", "hook-delete"):
    rec("--", {"note": "TED queues the message", "file": QUEUE_FILE})
    open(QUEUE_FILE, "w").write(STEER)
    if MODE == "hook-delete":
        time.sleep(1)
        os.remove(QUEUE_FILE)
        rec("--", {"note": "human deletes the queued message"})
    wait_for(is_result)
elif MODE == "gate":
    rec("--", {"note": "TED queues the message", "file": QUEUE_FILE})
    open(QUEUE_FILE, "w").write(STEER)
    while not os.path.exists(QUEUE_FILE + ".boundary"):
        time.sleep(0.05)
    rec("--", {"note": "hook reports a tool-call boundary; TED writes the message"})
    send(user(STEER))
    time.sleep(0.3)
    open(QUEUE_FILE + ".delivered", "w").close()
    wait_for(is_result)
    try:
        wait_for(is_result, timeout=20)
    except SystemExit:
        pass
elif MODE == "now":
    m = user(STEER)
    m.update({"parent_tool_use_id": None, "priority": "now", "origin": {"kind": "human"}})
    send(m)
    wait_for(is_result)
    try:
        wait_for(is_result, timeout=30)
    except SystemExit:
        pass
elif MODE == "interrupt":
    send({"type": "control_request", "request_id": "int-1", "request": {"subtype": "interrupt"}})
    wait_for(is_result)
    send(user(STEER))
    wait_for(is_result)
elif MODE == "hold":
    wait_for(is_result)
    send(user(STEER))
    wait_for(is_result)

time.sleep(1)
proc.stdin.close()
proc.terminate()
