from pathlib import Path
import re,json,collections,hashlib,sys
sys.stdout.reconfigure(encoding='utf-8')
root=Path(__file__).resolve().parents[1];note=(root/'content/hydraulic-study-notes.md').read_text(encoding='utf-8')
parts=re.findall(r'^### (\d+)\.(\d+) (.*?)\n(.*?)(?=^### |^## |\Z)',note,re.M|re.S)
inv=json.loads((root/'content/hydraulic-source-inventory.json').read_text(encoding='utf-8'))
sources=[{'id':20000+x['id'],'name':x['file'],'format':'.pdf'} for x in inv]
sources += [{'id':20016,'name':'水工概论需掌握的知识点2026.doc','format':'.doc'},{'id':20101,'name':'水利工程概论 2026考纲详细知识点清单（学习整理稿）','format':'.md'}]
def plain(t):
 lines=[]
 for l in t.strip().splitlines():
  if l.startswith('- [ ]'):continue
  l=re.sub(r'\*\*(.*?)\*\*',r'\1',l).strip()
  if re.match(r'^\|[\s:|-]+\|$',l):continue
  if l.startswith('|'):l='；'.join(c.strip() for c in l.strip('|').split('|'))
  l=re.sub(r'^- ','• ',l)
  lines.append(l)
 return re.sub(r'\n{3,}','\n\n','\n'.join(lines)).strip()
registry_path=root/'content/question-id-registry.json'
registry=json.loads(registry_path.read_text(encoding='utf-8')) if registry_path.exists() else {}
def stable_id(key):
 if key not in registry:registry[key]=max([200000,*registry.values()])+1
 return registry[key]
qs=[]
for a,b,title,body in parts:
 topic=f'{a}.{b}';ans=body.split('**自测**')[0];ref=body.split('**出处**：',1)[1].strip() if '**出处**：' in body else ''
 refs=re.findall(r'P(\d{2}) p(\d+)(?:[—–-](\d+))?',ref)
 source=20000+int(refs[0][0]) if refs else 20101
 q={'id':stable_id('topic:'+topic),'chapter':f'第{a}章','question':'简述'+title+'。','type':'简答题','options':'','answer':plain(ans),'explanation':'依据2026年课程考纲第'+topic+'项整理，属于学习参考答案，不是教师公布的标准答案。\n'+('复习自测：'+body.split('**自测**：',1)[1].split('**出处**')[0].strip()+'\n' if '**自测**：' in body else '')+'来源：'+ref,'source_id':source,'source_name':next(s['name'] for s in sources if s['id']==source),'locator':ref,'metadata':{'exam_topic':topic,'knowledge_path':f'第{a}章 > {topic} {title}','source_reference':ref,'review_status':'course_notes_checked','answer_basis':'课程课件、教材和已整理复习清单；非官方试卷答案','content_bank':'hydraulic-engineering-2026','requires_teacher_confirmation':'待核对' in ans or '待核实' in ans}}
 qs.append(q)
judgment=note.split('## 附录D ',1)[1].split('## 附录E',1)[0]
rows=[l for l in judgment.splitlines() if l.startswith('|') and not l.startswith('|---')][1:]
topic_ids=['1.1','2.5','2.4','2.5','3.3','3.5','3.8','3.9','3.17','3.12','3.11','3.11','3.20','4.4','5.4','5.1','6.6','6.7','6.8','7.3','7.8','8.4','8.5','8.8','9.2','9.7','8.7','10.1','10.5','10.10']
assert len(rows)==len(topic_ids)==30
for row,tid in zip(rows,topic_ids):
 stem,answer=[s.strip() for s in row.strip('|').split('|')];base=next(q for q in qs[:86] if q['metadata']['exam_topic']==tid)
 qs.append({'id':stable_id('judgment:'+stem),'chapter':base['chapter'],'type':'判断题','question':stem,'options':'','answer':'正确' if answer.startswith('对') else '错误','explanation':answer+'\n来源：'+base['locator'],'source_id':base['source_id'],'source_name':base['source_name'],'locator':base['locator'],'metadata':{'exam_topic':tid,'knowledge_path':base['metadata']['knowledge_path'],'source_reference':base['locator'],'review_status':'course_notes_checked','content_bank':'hydraulic-engineering-2026'}})
data={'sources':sources,'questions':qs,'edition':'沈振中等《水利工程概论》第2版 · 2026课程考纲（10章86项）','bankId':'hydraulic-engineering-2026','bankVersion':json.loads((root/'desktop/package.json').read_text(encoding='utf-8'))['version']}
(root/'preview/study-data.js').write_text('window.STUDY_DATA='+json.dumps(data,ensure_ascii=False,indent=2)+';\n',encoding='utf-8')
(root/'preview/generated-answers.js').write_text('window.GENERATED_ANSWERS=[];\n',encoding='utf-8')
(root/'preview/question-types.js').write_text('window.QUESTION_TYPES='+json.dumps({str(q['id']):q['type'] for q in qs},ensure_ascii=False,indent=2)+';\n',encoding='utf-8')
(root/'preview/question-images.js').write_text('window.QUESTION_IMAGES={};\n',encoding='utf-8')
(root/'content/hydraulic-engineering-2026.json').write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
(root/'content/hydraulic-engineering-2026-sources.md').write_text('# 平江安澜题库说明\n\n116题：86道考纲简答题及30道判断纠错题。来源为用户提供的课程复习要求、14份课件、《水利工程概论》第2版及本项目复习清单。保留来源定位与需教师确认的边界，不作为官方试卷或教师标准答案。未复制完整教材、课件或原始文件。新题号200001—200116；来源号20001起，避免旧基础地理题及来源进度误配。\n\n题库暂无单独配图题，未把原地理题配图挪入新学科；原题型与导入功能继续保留。\n',encoding='utf-8')
print(json.dumps({'questions':len(qs),'topics':len(parts),'types':dict(collections.Counter(q['type'] for q in qs)),'chapters':dict(collections.Counter(q['chapter'] for q in qs))},ensure_ascii=False))

registry_path.write_text(json.dumps(registry,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
