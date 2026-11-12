#!/usr/bin/env python3
"""Print a readable timeline from a claude_stream.py transcript."""
import json, sys

for l in open(sys.argv[1]):
    r = json.loads(l); m = r["msg"]; t = m.get("type"); st = m.get("subtype", "")
    if t == "system" and st == "init":
        print(r["t"], r["dir"], "system/init", "claude_code_version=" + str(m.get("claude_code_version"))); continue
    if t in ("assistant", "user") and isinstance(m.get("message"), dict):
        content = m["message"]["content"]
        if isinstance(content, str):
            content = [{"type": "text", "text": content}]
        for c in content:
            ct = c.get("type")
            if ct == "text": s = "text: " + c["text"][:100]
            elif ct == "tool_use": s = "tool_use: " + json.dumps(c.get("input"))[:80]
            elif ct == "tool_result": s = "tool_result: " + str(c.get("content"))[:60]
            else: s = ct
            print(r["t"], r["dir"], t, s)
        continue
    if t == "system" and "hook" in st:
        print(r["t"], r["dir"], "system/" + st, m.get("hook_event", m.get("hook_name", "")),
              str(m.get("output") or m.get("stdout") or "")[:120]); continue
    print(r["t"], r["dir"], t, st, json.dumps(m)[:160])
