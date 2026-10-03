src=open('desk.src.html').read()
head=src.split('<script>')[0]
head=head.replace('__LOGO__','data:image/png;base64,'+open('logo.b64').read().strip())
head=head.replace('<div class="avatar" title="Matt Goff">MG</div>','<div class="avatar" id="me" title="Signed in">··</div>')
old='<span class="env-pill" title="Data read from the Dynamics sandbox. Buttons on this page change this preview only."><svg class="ico"><use href="#i-alert"/></svg>Preview<span class="long">&nbsp;· sandbox orgcad402f2 · changes stay on this page</span></span>'
assert old in head
head=head.replace(old,'<span class="env-pill" title="Live Dynamics data. Every change asks for confirmation before it is saved."><svg class="ico"><use href="#i-alert"/></svg>Sandbox<span class="long">&nbsp;· live data · changes save to Dynamics</span></span>')
head=head.replace('</style>', """.confirm { display: flex; gap: 12px; align-items: center; justify-content: space-between; flex-wrap: wrap; padding: 12px 16px; border-color: color-mix(in srgb, var(--orange) 55%, transparent); background: var(--orange-soft); }
.confirm > span:first-child { display: inline-flex; gap: 8px; align-items: center; font-weight: 600; }
.decision { display: flex; gap: 8px; flex-wrap: wrap; }
.toast.err { background: var(--crit); color: #fff; }
</style>""",1)
t=head.index('</title>')+len('</title>')
doc='<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n'+head[:t]+'\n'+head[t:].split('<svg width="0"')[0]+'</head>\n<body>\n<svg width="0"'+head.split('<svg width="0"',1)[1]
mk=open('matchkey.js').read().replace("if (typeof module !== 'undefined') module.exports = { normalizeStreet, addressMatchKey, normalizeEin, zip5 };\n","")
doc+='<script>\n'+open('live.js').read().replace('__MATCHKEY__',mk)+'\n</script>\n</body>\n</html>\n'
open('index.html','w').write(doc)
print(len(doc))
