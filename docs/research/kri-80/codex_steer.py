#!/usr/bin/env python3
"""Drive `codex app-server` over stdio and log every message with a timestamp.

Usage: codex_steer.py steer|interrupt|hold <transcript.jsonl>

steer:     start a turn that runs three slow commands, send turn/steer during the first.
interrupt: start the same turn, send turn/interrupt during the first command, then turn/start.
hold:      start the same turn, keep the message in this script until turn/completed, then turn/start.
boundary:  send turn/steer the moment the first command's item/completed arrives.
late:      send turn/steer the moment the third command's item/completed arrives.
"""
import json, subprocess, sys, threading, time, os, queue

MODE, OUT = sys.argv[1], sys.argv[2]
MODEL = os.environ.get("CODEX_MODEL", "gpt-6-luna")
PROMPT = ("Run these three shell commands one at a time, each as its own tool call: "
          "`sleep 4; echo one`, `sleep 4; echo two`, `sleep 4; echo three`. "
          "Then reply with one short line.")
STEER = "New instruction from the human: after the commands, reply with the single word PINEAPPLE."

t0 = time.time()
log = open(OUT, "w")
proc = subprocess.Popen(
    ["codex", "app-server", "-c", f'model="{MODEL}"', "-c", 'model_reasoning_effort="low"'],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
inbox = queue.Queue()
next_id = [0]

def rec(direction, msg):
    log.write(json.dumps({"t": round(time.time() - t0, 2), "dir": direction, "msg": msg}) + "\n")
    log.flush()

def send(method, params, notify=False):
    msg = {"method": method, "params": params}
    if not notify:
        next_id[0] += 1
        msg["id"] = next_id[0]
    rec("->", msg)
    proc.stdin.write(json.dumps(msg) + "\n")
    proc.stdin.flush()
    return msg.get("id")

def reader():
    for line in proc.stdout:
        try:
            m = json.loads(line)
        except ValueError:
            continue
        if m.get("method") in ("item/agentMessage/delta", "item/commandExecution/outputDelta",
                               "item/reasoning/summaryTextDelta", "item/reasoning/textDelta"):
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

def response_to(i):
    return wait_for(lambda m: m.get("id") == i and "method" not in m)

i = send("initialize", {"clientInfo": {"name": "ted-kri80", "title": None, "version": "0"}, "capabilities": None})
response_to(i)
send("initialized", {}, notify=True)
i = send("thread/start", {"cwd": os.getcwd(), "approvalPolicy": "never", "sandbox": "read-only", "ephemeral": True})
thread_id = response_to(i)["result"]["thread"]["id"]
i = send("turn/start", {"threadId": thread_id, "input": [{"type": "text", "text": PROMPT, "text_elements": []}]})
turn_id = response_to(i)["result"]["turn"]["id"]

first_cmd = lambda m: (m.get("method") == "item/started"
                       and m["params"]["item"].get("type") == "commandExecution")
cmd_done = lambda n: (lambda m: m.get("method") == "item/completed"
                       and m["params"]["item"].get("type") == "commandExecution"
                       and n in str(m["params"]["item"].get("command")))
if MODE not in ("boundary", "late"):
    wait_for(first_cmd)
    time.sleep(1)
steer_input = [{"type": "text", "text": STEER, "text_elements": []}]

done = lambda m: m.get("method") == "turn/completed"
if MODE == "steer":
    i = send("turn/steer", {"threadId": thread_id, "input": steer_input, "expectedTurnId": turn_id})
    wait_for(done)
elif MODE == "interrupt":
    i = send("turn/interrupt", {"threadId": thread_id, "turnId": turn_id})
    wait_for(done)
    i = send("turn/start", {"threadId": thread_id, "input": steer_input})
    wait_for(done)
elif MODE in ("boundary", "late"):
    wait_for(cmd_done("one" if MODE == "boundary" else "three"))
    i = send("turn/steer", {"threadId": thread_id, "input": steer_input, "expectedTurnId": turn_id})
    wait_for(done)
elif MODE == "hold":
    wait_for(done)
    i = send("turn/start", {"threadId": thread_id, "input": steer_input})
    wait_for(done)
time.sleep(1)
proc.terminate()
