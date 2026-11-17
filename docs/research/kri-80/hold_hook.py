#!/usr/bin/env python3
"""PostToolUse hook: deliver a message Ted is holding, if any, as additionalContext.

Usage (from per-Run --settings): hold_hook.py <queue-file>
The queue file stands in for Ted's own store. Deleting it before the hook runs is "Delete".
"""
import json, os, sys

path = sys.argv[1]
json.load(sys.stdin)
if not os.path.exists(path):
    sys.exit(0)
text = open(path).read()
os.remove(path)
print(json.dumps({"hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "Message from the human, sent while you were working: " + text}}))
