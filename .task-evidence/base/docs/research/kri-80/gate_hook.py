#!/usr/bin/env python3
"""PostToolUse hook: tell TED a tool-call boundary is here, and wait while TED delivers a held message.

Usage (from per-Run --settings): gate_hook.py <queue-file>
If the queue file exists, write <queue-file>.boundary and wait up to 10 s for <queue-file>.delivered.
The real TED would ask the daemon over `ted` instead of using files.
"""
import json, os, sys, time

path = sys.argv[1]
json.load(sys.stdin)
if not os.path.exists(path):
    sys.exit(0)
open(path + ".boundary", "w").close()
end = time.time() + 10
while time.time() < end and not os.path.exists(path + ".delivered"):
    time.sleep(0.05)
for p in (path, path + ".boundary", path + ".delivered"):
    if os.path.exists(p):
        os.remove(p)
