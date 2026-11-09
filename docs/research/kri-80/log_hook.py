#!/usr/bin/env python3
"""Hook that appends the event name, the prompt or tool input, and a timestamp to a log file."""
import json, sys, time

e = json.load(sys.stdin)
keep = {k: e.get(k) for k in ("hook_event_name", "prompt", "tool_input", "last_assistant_message") if e.get(k)}
keep["unix"] = round(time.time(), 2)
with open(sys.argv[1], "a") as f:
    f.write(json.dumps(keep) + "\n")
