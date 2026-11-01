"""Publish only cymarlboro/pingjiang-anlan. Never persist or print credentials."""
from pathlib import Path
import sys,json,subprocess,os,hashlib,time
from urllib.parse import urlsplit,quote
ROOT=Path(__file__).resolve().parents[1];REL=ROOT/'release';REPO='cymarlboro/pingjiang-anlan';API='https://api.github.com'
V=json.loads((ROOT/'version.json').read_text(encoding='utf-8'));NAME=V['versionName'];CODE=V['versionCode'];TAG='v'+NAME
sys.stdout.reconfigure(encoding='utf-8')
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def git(*args):
 cp=subprocess.run(['git','-C',str(ROOT),*args],capture_output=True,text=True,encoding='utf-8',errors='replace')
 if cp.returncode:raise RuntimeError('Git operation failed: '+args[0]+'; no credential output logged')
 return cp.stdout.strip()
def credential():
 env=os.environ.copy();env.update(GIT_TERMINAL_PROMPT='0',GCM_INTERACTIVE='never')
 cp=subprocess.run(['git','-C',str(ROOT),'-c','credential.interactive=never','credential','fill'],input='protocol=https\nhost=github.com\npath='+REPO+'.git\n\n',text=True,encoding='utf-8',capture_output=True,env=env,timeout=30)
 if cp.returncode:raise RuntimeError('GitHub credential unavailable; complete Git Credential Manager browser login')
 fields=dict(x.split('=',1) for x in cp.stdout.splitlines() if '=' in x);token=fields.get('password','')
 if not token:raise RuntimeError('GitHub credential unavailable')
 return token
TOKEN=None
def request(url,method='GET',payload=None,file=None,missing=False):
 host=urlsplit(url).hostname
 if host not in {'api.github.com','uploads.github.com','raw.githubusercontent.com'}:raise RuntimeError('Unapproved release host')
 cfg=['header = "Accept: application/vnd.github+json"','header = "X-GitHub-Api-Version: 2022-11-28"','user-agent = "PingjiangAnlan-release"']
 if TOKEN and host in {'api.github.com','uploads.github.com'}:cfg.append('header = "Authorization: Bearer '+TOKEN.replace('"','')+'"')
 args=['curl.exe','--config','-','--silent','--show-error','--max-time','420','--request',method,'--write-out','\n%{http_code}',url]
 if file is not None:cfg.append('header = "Content-Type: application/octet-stream"');args+=['--data-binary','@'+str(file)]
 elif payload is not None:
  cfg.append('header = "Content-Type: application/json"');tmp=ROOT/'tmp/release-request.json';tmp.parent.mkdir(exist_ok=True);tmp.write_text(json.dumps(payload,ensure_ascii=False),encoding='utf-8');args+=['--data-binary','@'+str(tmp)]
 cp=subprocess.run(args,input='\n'.join(cfg)+'\n',capture_output=True,text=True,encoding='utf-8',errors='replace')
 if cp.returncode:raise RuntimeError('Release transport failure '+str(cp.returncode))
 body,_,status=cp.stdout.rpartition('\n');code=int(status or 0)
 if missing and code==404:return None
 if not 200<=code<300:raise RuntimeError('GitHub HTTP '+str(code)+' for '+method+' '+host+urlsplit(url).path)
 return json.loads(body) if body else None
def inspect():
 remote=request(API+'/repos/'+REPO,missing=True)
 if remote is None:return {'repositoryExists':False,'credentialAvailable':bool(TOKEN)}
 latest=request(API+'/repos/'+REPO+'/releases/latest',missing=True)
 return {'repositoryExists':True,'pushPermission':remote.get('permissions',{}).get('push',False),'latestTag':latest['tag_name'] if latest else None}
def publish():
 manifest=json.loads((ROOT/'update.json').read_text(encoding='utf-8'));assert manifest['versionName']==NAME and manifest['versionCode']==CODE and manifest['windowsSignature']
 assert manifest['windows']['appId']=='cn.pingjianganlan.study.desktop'
 assets=[REL/f'pingjianganlan-{NAME}-{CODE}.apk',REL/f'pingjianganlan-{NAME}-windows-x64-setup.exe',REL/f'pingjianganlan-{NAME}-source.zip',REL/f'SHA256SUMS-{NAME}.txt',ROOT/'base-question-bank.json',ROOT/'base-question-images.json',ROOT/'update.json']
 for p in assets:assert p.is_file(),p.name
 assert digest(assets[0])==manifest['sha256'];assert digest(assets[1])==manifest['windows']['sha256']
 assert git('remote','get-url','origin')=='https://github.com/'+REPO+'.git','Wrong repository origin'
 state=inspect()
 if not state['repositoryExists']:
  remote=request(API+'/user/repos','POST',{'name':'pingjiang-anlan','description':'平江安澜 · 水利工程概论 Android / Windows 独立复习软件','private':False,'auto_init':False,'has_issues':True});assert remote['full_name']==REPO
 elif not state.get('pushPermission'):raise RuntimeError('Repository push permission unavailable')
 prior=request(API+'/repos/'+REPO+'/releases/tags/'+TAG,missing=True)
 if prior and not prior['draft']:raise RuntimeError('Version already published; never overwrite published assets')
 git('add','--','.')
 if git('diff','--cached','--name-only'):git('commit','-m','release: 平江安澜 '+NAME+' 独立水利工程概论双端版')
 commit=git('rev-parse','HEAD')
 if not state['repositoryExists']:git('push','-u','origin','main')
 else:git('push','origin','HEAD:refs/heads/codex/release-'+TAG)
 notes=(REL/f'{NAME}-release-notes.md').read_text(encoding='utf-8')
 release=prior or request(API+'/repos/'+REPO+'/releases','POST',{'tag_name':TAG,'target_commitish':commit,'name':'平江安澜 '+NAME+' · 水利工程概论独立双端版','body':notes,'draft':True,'prerelease':False})
 rid=release['id'];existing={x['name']:x for x in release.get('assets',[])}
 (REL/f'publication-{NAME}-draft.json').write_text(json.dumps({'id':rid,'tag':TAG}),encoding='utf-8')
 for p in assets:
  a=existing.get(p.name)
  if a and a.get('digest')!='sha256:'+digest(p):
   assert release['draft'];request(API+'/repos/'+REPO+'/releases/assets/'+str(a['id']),'DELETE');a=None
  if not a:print('Uploading '+p.name,flush=True);a=request('https://uploads.github.com/repos/'+REPO+'/releases/'+str(rid)+'/assets?name='+quote(p.name),'POST',file=p)
  assert a.get('digest')=='sha256:'+digest(p),'Draft asset digest differs: '+p.name
  print('Verified '+p.name,flush=True)
 if '--draft' in sys.argv:
  print(json.dumps({'draft':True,'url':release['html_url'],'verifiedAssets':len(assets)},ensure_ascii=False),flush=True);return
 request(API+'/repos/'+REPO+'/releases/'+str(rid),'PATCH',{'target_commitish':commit,'body':notes,'draft':False,'prerelease':False,'make_latest':'true'})
 git('push','-u','origin','main')
 final=request(API+'/repos/'+REPO+'/releases/tags/'+TAG);remote=request('https://raw.githubusercontent.com/'+REPO+'/main/update.json?verify='+str(int(time.time())))
 assert remote==manifest
 byName={a['name']:a for a in final['assets']}
 for p in assets:assert byName[p.name]['digest']=='sha256:'+digest(p)
 receipt={'release':final['html_url'],'tag':TAG,'commit':commit,'publishedAt':final['published_at'],'remoteManifestMatchesLocal':True,'assets':[{k:a.get(k) for k in ['name','size','digest','browser_download_url']} for a in final['assets']]}
 (REL/f'publication-{NAME}.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(receipt,ensure_ascii=False,indent=2),flush=True)
if __name__=='__main__':
 try:
  TOKEN=credential()
  if '--publish' in sys.argv or '--draft' in sys.argv:publish()
  else:print(json.dumps(inspect(),ensure_ascii=False),flush=True)
 except Exception as exc:print(type(exc).__name__+': '+str(exc),file=sys.stderr);sys.exit(1)
