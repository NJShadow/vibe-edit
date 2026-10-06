#!/usr/bin/env python3
"""Splice dev/*.js and dev/*.css into vibe-edit.html (single-file delivery)."""
import re, os, sys
D = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(D)
HTML = os.path.join(ROOT, 'vibe-edit.html')
JS = ['ai-core.js', 'ai-audio.js', 'ai-speech.js', 'ai-transcript.js', 'ai-pauses.js', 'ai-scenes.js', 'ai-beats.js', 'ai-reframe.js', 'ai-ui.js', 'pro-duck.js', 'pro-proxy.js', 'pro-ge2e.js', 'pro-speakers.js', 'pro-compound.js', 'pro-campp.js', 'pro-lut.js', 'pro-lutlib.js', 'pro-curves.js', 'pro-ramp.js', 'pro-blend.js', 'pro-scopes.js', 'pro-ui.js']
CSS = ['ui-refresh.css', 'ai.css', 'export.css', 'pro.css']
s = open(HTML, encoding='utf-8').read()
js = '\n'.join(open(os.path.join(D, f), encoding='utf-8').read().rstrip('\n') for f in JS if os.path.exists(os.path.join(D, f)))
css = '\n'.join(open(os.path.join(D, f), encoding='utf-8').read().rstrip('\n') for f in CSS if os.path.exists(os.path.join(D, f)))
JB, JE = '/* ==== AI-JS BEGIN ==== */', '/* ==== AI-JS END ==== */'
CB, CE = '/* ==== V46-CSS BEGIN ==== */', '/* ==== V46-CSS END ==== */'
block = '<script>\n' + JB + '\n' + js + '\n' + JE + '\n</script>'
if JB in s:
    s = re.sub(re.escape('<script>\n' + JB) + r'.*?' + re.escape(JE + '\n</script>'), lambda m: block, s, flags=re.S)
else:
    i = s.rindex('</body>'); s = s[:i] + block + '\n' + s[i:]
cblock = CB + '\n' + css + '\n' + CE
if CB in s:
    s = re.sub(re.escape(CB) + r'.*?' + re.escape(CE), lambda m: cblock, s, flags=re.S)
else:
    i = s.index('</style>'); s = s[:i] + cblock + '\n' + s[i:]
# speaker model (GE2E, float16) as base64 in a non-executing <script> block
import base64
MB, ME = '<script type="text/plain" id="vibeSpeakerModel">', '</script><!-- /vibeSpeakerModel -->'
mp = os.path.join(D, 'speaker-ge2e.bin')
if os.path.exists(mp):
    mblock = MB + base64.b64encode(open(mp, 'rb').read()).decode() + ME
    if MB in s:
        i = s.index(MB); j = s.index(ME, i) + len(ME); s = s[:i] + mblock + s[j:]
    else:
        i = s.rindex('</body>'); s = s[:i] + mblock + '\n' + s[i:]
assert s.count(JB) == 1 and s.count(CB) == 1
open(HTML, 'w', encoding='utf-8').write(s)
print('built', HTML, len(s), 'bytes; js', len(js), 'css', len(css))
