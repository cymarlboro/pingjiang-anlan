"""Prepare reproducible sources and the independent update manifest."""
from pathlib import Path
import json,hashlib,zipfile
root=Path(__file__).resolve().parents[1];rel=root/'release';v=json.loads((root/'version.json').read_text(encoding='utf-8'));name=v['versionName'];code=v['versionCode'];repo='cymarlboro/pingjiang-anlan'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
apk=rel/f'pingjianganlan-{name}-{code}.apk';exe=rel/f'pingjianganlan-{name}-windows-x64-setup.exe'
assert apk.is_file() and exe.is_file(),'Build both installers first'
notes=(rel/f'{name}-release-notes.md').read_text(encoding='utf-8')
bank=json.loads((root/'content/hydraulic-engineering-2026.json').read_text(encoding='utf-8'));assert bank['bankVersion']==name
(root/'base-question-bank.json').write_text(json.dumps(bank,ensure_ascii=False,indent=2)+'\n',encoding='utf-8');(root/'base-question-images.json').write_text('{}\n',encoding='utf-8')
url=f'https://github.com/{repo}/releases/download/v{name}/'
windows={'appId':'cn.pingjianganlan.study.desktop','versionCode':code,'versionName':name,'installerUrl':url+exe.name,'sha256':sha(exe),'notes':notes}
manifest={'versionCode':code,'versionName':name,'apkUrl':url+apk.name,'sha256':sha(apk),'notes':notes,'windows':windows};mp=root/'update.json'
if mp.exists():
 old=json.loads(mp.read_text(encoding='utf-8'))
 if old.get('windows')==windows and old.get('windowsSignature'):manifest['windowsSignature']=old['windowsSignature']
mp.write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
(root/'index.html').write_text(f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>平江安澜 · 水利工程概论</title><style>body{{max-width:760px;margin:8vh auto;padding:24px;background:#eff6f4;color:#183c3d;font:18px/1.8 system-ui}}a{{color:#096b73}}h1{{font-size:42px}}small{{color:#536b6b}}</style><h1>平江安澜</h1><p>水利工程概论复习 · Android / Windows</p><p>10章116题，覆盖86项课程考纲，保留出处、答案修订、间隔复习与资料分析。</p><p><a href="{url+apk.name}">下载 Android {name}</a></p><p><a href="{url+exe.name}">下载 Windows x64 {name}</a></p><p><a href="https://github.com/{repo}/releases/latest">版本说明与校验文件</a> · <a href="https://github.com/{repo}">项目源码</a></p><small>独立应用，可与自然地理学软件并存。参考答案不是教师标准答案；未确认内容保留待核对标记。云同步状态请查看仓库部署记录。</small></html>''',encoding='utf-8')
source=rel/f'pingjianganlan-{name}-source.zip';count=0
with zipfile.ZipFile(source,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
 for p in sorted(root.rglob('*')):
  parts=p.relative_to(root).parts
  if not p.is_file() or any(x in {'.git','node_modules','build','dist','.gradle','tmp','__pycache__'} for x in parts):continue
  if p.name in {'SHA256SUMS.txt','local.properties'} or p.suffix in {'.p12','.clixml','.keystore','.log','.apk','.exe','.zip'} or p.name.startswith('.env'):continue
  if parts[0]=='release' and p.suffix not in {'.py','.md','.pem'}:continue
  i=zipfile.ZipInfo('pingjiang-anlan/'+p.relative_to(root).as_posix(),(2026,1,1,0,0,0));i.compress_type=zipfile.ZIP_DEFLATED;i.external_attr=0o100644<<16;z.writestr(i,p.read_bytes());count+=1
assets=[apk,exe,source,root/'base-question-bank.json',root/'base-question-images.json',mp]
checksum=''.join(f'{sha(p)}  {p.name}\n' for p in assets)
(rel/f'SHA256SUMS-{name}.txt').write_text(checksum,encoding='utf-8');(root/'SHA256SUMS.txt').write_text(checksum,encoding='utf-8')
print(json.dumps({'version':v,'sourceFiles':count,'questions':len(bank['questions']),'windowsManifestSigned':bool(manifest.get('windowsSignature')),'apkSha256':sha(apk),'windowsSha256':sha(exe)},ensure_ascii=False))
