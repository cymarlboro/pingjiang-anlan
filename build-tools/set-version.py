"""Advance an independent release without changing algorithms or question IDs."""
from pathlib import Path
import sys,json,re
root=Path(__file__).resolve().parents[1]
if len(sys.argv)!=3:raise SystemExit('Usage: python build-tools/set-version.py 1.0.1 2')
name,code=sys.argv[1],int(sys.argv[2]);old=json.loads((root/'version.json').read_text(encoding='utf-8'))
if not re.fullmatch(r'\d+\.\d+\.\d+',name) or code<=old['versionCode']:raise SystemExit('Use a semantic version and a strictly increasing versionCode')
changes={
 'preview/app.js':[(r'const APP_VERSION = "[^"]+";',f'const APP_VERSION = "{name}";')],
 'desktop/src/main/main.cjs':[(r'APP_VERSION_CODE = \d+',f'APP_VERSION_CODE = {code}'),(r'APP_VERSION_NAME = "[^"]+"',f'APP_VERSION_NAME = "{name}"')],
 'desktop/src/main/native-store.cjs':[(r'versionCode = \d+',f'versionCode = {code}'),(r'versionName = "[^"]+"',f'versionName = "{name}"')],
 'desktop/src/main/backup.cjs':[(r'versionCode = \d+',f'versionCode = {code}'),(r'versionName = "[^"]+"',f'versionName = "{name}"')],
 'android/app/build.gradle':[(r'getOrElse\("\d+"\)',f'getOrElse("{code}")'),(r'getOrElse\("\d+\.\d+\.\d+"\)',f'getOrElse("{name}")')]
}
for rel,rules in changes.items():
 p=root/rel;s=p.read_bytes().decode('utf-8')
 for pattern,replacement in rules:s,n=re.subn(pattern,lambda _:replacement,s);assert n==1,(rel,pattern,n)
 p.write_bytes(s.encode('utf-8'))
for rel in ['desktop/package.json','desktop/package-lock.json']:
 p=root/rel;v=json.loads(p.read_text(encoding='utf-8'));v['version']=name
 if 'packages' in v:v['packages']['']['version']=name
 p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
(root/'version.json').write_text(json.dumps({'versionName':name,'versionCode':code})+'\n',encoding='utf-8')
print('Version advanced. Rebuild question bank, both installers, signed manifest and checksums before publication.')
