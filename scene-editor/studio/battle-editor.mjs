
import {BATTLE_RESULTS,ENTRY_STYLES,validateProject} from './format.mjs';
import {json} from './resources.mjs';
import {ENTRY_LABELS} from './campaign-editor.mjs';

export const RESULT_LABELS={victory:'击败敌人',spared:'饶恕',defeat:'队伍落败',flee:'逃离'};
export function makeBattleOption(id,ref){return id+' · '+ref.encounter;}
export async function editBattleFile(ref){
  const tab=window.open('about:blank','_blank');
  if(!tab)throw new Error('浏览器阻止了战斗编辑器标签页，请允许此工作台打开弹窗。');
  tab.opener=null;
  try{
    const {url}=await json('/api/studio/battles/edit',{ref});
    tab.location.replace(url);
  }catch(ex){tab.close();throw ex;}
}

export function mountBattleEditor(root,{getProject,onChange,onError}){
  const node=(tag,label)=>{const el=document.createElement(tag);if(label!==undefined)el.textContent=label;return el;};
  const select=node('select'),library=node('select'),id=node('input'),resultFlag=node('input'),language=node('select');
  const add=node('button','新建引用'),apply=node('button','应用'),open=node('button','编辑遭遇 ↗'),reload=node('button','刷新目录'),remove=node('button','移除引用');
  const description=node('p'),carry=node('select'),transition=node('select'),rewards=node('textarea');
  rewards.rows=3;rewards.spellcheck=false;rewards.placeholder='{"spared":{"tonic":1}}';
  carry.replaceChildren(new Option('按工程设置',''),new Option('继承共享状态','inherit'),new Option('本场独立','isolated'));
  transition.replaceChildren(new Option('按工程设置',''),...ENTRY_STYLES.map(k=>new Option(ENTRY_LABELS[k],k)));
  const outcomes={};let disabled=false,catalog=[],revision=0;
  function label(text,el){const l=node('label',text);el.setAttribute('aria-label',text);l.append(el);return l;}
  language.replaceChildren(new Option('中文','zh'),new Option('English','en'));
  const group=node('div');group.className='inline';group.append(add,apply,open,reload,remove);
  root.append(label('工程中的战斗引用',select),label('可用遭遇',library),label('战斗 ID',id),label('战斗界面语言',language),label('结果旗标（可留空）',resultFlag));
  for(const result of BATTLE_RESULTS){
    const el=node('select');outcomes[result]=el;root.append(label(RESULT_LABELS[result]+'后',el));
  }
  root.append(label('队伍和道具',carry),label('入战演出',transition),label('结算奖励（JSON）',rewards),group,description);
  const title=entry=>entry.title+' · '+(entry.source==='project'?'作品 / '+entry.work:entry.source==='sample'?'样例':'场景工作区')+' / '+entry.encounter;
  const key=r=>r.source==='project'?['project',r.work,r.encounter].join('|'):[r.source??'workspace',r.encounter].join('|');
  const fromOption=()=>{
    const [source,name,encounter]=library.value.split('|');
    if(source==='project')return {source,work:name,encounter};
    return name?{source,encounter:name}:null;
  };
  function controls(){
    for(const el of [select,library,id,resultFlag,language,carry,transition,rewards,...Object.values(outcomes),reload])el.disabled=disabled;
    id.readOnly=!!select.value;
    add.disabled=disabled;apply.disabled=disabled||!library.value;
    open.disabled=disabled||!library.value;
    remove.disabled=disabled||!select.value;
  }
  function list(ref=null){
    const selected=ref?key(ref):library.value;
    library.replaceChildren(new Option('— 选择已保存的遭遇 —',''),...catalog.map(e=>new Option(title(e),key(e))));
    if(selected&&![...library.options].some(o=>o.value===selected))
      library.add(new Option('未在目录找到 · '+selected.replace('|',' / '),selected));
    library.value=selected;
  }
  function load(){
    const p=getProject(),ref=p.battles?.[select.value];
    list(ref);if(!ref)library.value='';
    id.value=select.value;resultFlag.value=ref?.resultFlag??'';
    language.value=ref?.lang??'zh';carry.value=ref?.carry??'';transition.value=ref?.transition?.style??'';
    rewards.value=ref?.rewards?JSON.stringify(ref.rewards,null,2):'';
    for(const [result,el] of Object.entries(outcomes)){
      el.replaceChildren(new Option('— 返回原事件 —',''),...Object.keys(p.events??{}).map(k=>new Option(k,k)));
      el.value=ref?.on?.[result]??'';
    }
    controls();
  }
  function refresh(pick=select.value){
    select.replaceChildren(new Option('— 新建引用 —',''),
      ...Object.entries(getProject().battles??{}).map(([k,ref])=>new Option(makeBattleOption(k,ref),k)));
    select.value=[...select.options].some(o=>o.value===pick)?pick:'';
    load();
  }
  async function refreshCatalog(){
    const request=++revision;
    try{
      const d=await json('/api/studio/battles');
      if(request!==revision)return;
      catalog=d.entries;
      description.textContent=d.available?'可选场景工作区、战斗作品库或内置样例。保存遭遇后，重新开始试玩即可使用新版本。':d.reason;
      list(getProject().battles?.[select.value]);controls();
    }catch(ex){if(request===revision)onError(ex.message);}
  }
  select.onchange=load;library.onchange=controls;reload.onclick=refreshCatalog;
  add.onclick=()=>{
    select.value='';load();
    let i=1;while(Object.hasOwn(getProject().battles??{},'battle_'+i))i++;
    id.value='battle_'+i;library.focus();
  };
  apply.onclick=()=>{
    const p=getProject(),k=id.value.trim(),ref=fromOption();
    if(!k||!ref){onError('请填写战斗 ID 并选择遭遇。');return;}
    if(!select.value&&Object.hasOwn(p.battles??{},k)){onError('这个战斗 ID 已存在。');return;}
    const on=Object.fromEntries(Object.entries(outcomes).filter(([,e])=>e.value).map(([key,e])=>[key,e.value]));
    const data={...p.battles?.[k],...ref,lang:language.value};
    if(ref.source!=='project')delete data.work;
    if(resultFlag.value.trim())data.resultFlag=resultFlag.value.trim();else delete data.resultFlag;
    if(Object.keys(on).length)data.on=on;else delete data.on;
    if(carry.value)data.carry=carry.value;else delete data.carry;
    const tr={...data.transition};delete tr.style;
    if(transition.value)tr.style=transition.value;
    if(Object.keys(tr).length)data.transition=tr;else delete data.transition;
    try{
      if(rewards.value.trim())data.rewards=JSON.parse(rewards.value);else delete data.rewards;
    }catch(error){onError('结算奖励不是有效 JSON：'+error.message);return;}
    const battles={...p.battles,[k]:data};
    const checked=validateProject({...p,battles});
    if(!checked.ok){const e=checked.errors[0];onError(e.path+' · '+e.message);return;}
    p.battles=battles;onChange(k);refresh(k);
  };
  remove.onclick=()=>{
    const p=getProject(),k=select.value,battles={...p.battles};
    delete battles[k];
    const result=validateProject({...p,battles});
    if(!result.ok){onError(result.errors[0].path+' · '+result.errors[0].message);return;}
    p.battles=battles;onChange(null);refresh('');
  };
  open.onclick=()=>editBattleFile(fromOption()).catch(ex=>onError(ex.message));
  function refreshEvents(){
    const p=getProject();
    for(const el of Object.values(outcomes)){
      const value=el.value;
      el.replaceChildren(new Option('— 返回原事件 —',''),...Object.keys(p.events??{}).map(k=>new Option(k,k)));
      el.value=[...el.options].some(o=>o.value===value)?value:'';
    }
  }
  return {refresh,refreshCatalog,refreshEvents,disable(v){disabled=v;controls();}};
}
