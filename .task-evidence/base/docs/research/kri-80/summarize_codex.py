#!/usr/bin/env python3
"""Print a readable timeline from a codex_steer.py transcript."""
import json, sys
SKIP = ('mcpServer', 'account', 'thread/tokenUsage', 'rawResponse', 'thread/settings', 'skills', 'app/', 'hook/', 'remoteControl')
for l in open(sys.argv[1]):
    r = json.loads(l); m = r['msg']; meth = m.get('method')
    if meth and meth.startswith(SKIP): continue
    if not meth:
        print(r['t'], r['dir'], 'response', m.get('id'), str(m.get('result', m.get('error')))[:100]); continue
    p = m.get('params', {}); it = p.get('item') or {}
    extra = ''
    if it: extra = it.get('type', '') + ' ' + str(it.get('command') or it.get('text') or it.get('content') or '')[:90]
    elif meth == 'turn/completed': extra = 'status=' + p['turn']['status']
    elif r['dir'] == '->': extra = json.dumps(p)[:110]
    print(r['t'], r['dir'], meth, extra)
