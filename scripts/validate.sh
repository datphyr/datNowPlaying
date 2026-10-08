#!/usr/bin/env bash
# Static validation for the extension: JSON, referenced files, JS syntax.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== manifest json =="
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('ok')"

echo "== referenced files exist =="
node -e '
const fs=require("fs"), p=require("path");
const m=JSON.parse(fs.readFileSync("manifest.json","utf8"));
const paths=new Set();
paths.add(m.background.service_worker);
paths.add(m.action.default_popup);
paths.add(m.options_page);
(m.content_scripts||[]).forEach(cs=>(cs.js||[]).forEach(f=>paths.add(f)));
Object.values(m.icons||{}).forEach(f=>paths.add(f));
Object.values((m.action&&m.action.default_icon)||{}).forEach(f=>paths.add(f));
let bad=0;
for (const f of paths){ if(!fs.existsSync(f)){ console.log("MISSING",f); bad++; } }
if(bad) process.exit(1);
console.log(paths.size+" files referenced, all present");
'

echo "== javascript syntax =="
for f in src/background.js src/content.js src/offscreen.js src/options.js src/popup.js src/lib/metadata.js src/lib/idb.js src/lib/components.js src/lib/values.js src/lib/cover.js src/lib/api.js scripts/make-icons.js tests/run.js; do
  node --check "$f" && echo "  ok   $f"
done

echo "== html script refs exist =="
node -e '
const fs=require("fs"),p=require("path");
let bad=0;
for (const h of ["src/popup.html","src/options.html","src/offscreen.html"]) {
  const html=fs.readFileSync(h,"utf8");
  const dir=p.dirname(h);
  for (const m of html.matchAll(/<script[^>]+src="([^"]+)"/g)) {
    const f=p.join(dir,m[1]);
    if(!fs.existsSync(f)){ console.log("MISSING",f); bad++; } else console.log("  ok   "+f);
  }
}
if(bad) process.exit(1);
'

echo "== all good =="
