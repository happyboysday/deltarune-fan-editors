
import {validateProject} from './format.mjs';

const eventTemplates={
  '对白':[{op:'say',pages:[{speaker:'角色',text:'把这里改成台词。'}]}],
  '选择分支':[{op:'choose',question:'要接下委托吗？',options:[
    {text:'接下',actions:[{op:'flag',id:'accepted',value:true}]},
    {text:'再等等',actions:[{op:'say',pages:['好，等你回来。']}]}]}],
  '给物品':[{op:'item',id:'钥匙',delta:1},{op:'say',pages:['＊ 你得到了一把钥匙。']}],
  '机关计时':[{op:'flag',id:'switch_active',value:true},{op:'wait',ticks:30},{op:'flag',id:'switch_active',value:false}],
  '节奏':{type:'rhythm',title:'节奏练习',window:4,lead:30,minHits:3,beats:[{at:0,key:'left'},{at:24,key:'up'},{at:48,key:'act'}]},
  '检查点':[{op:'checkpoint'}],
  '对白后开战':null,
  '宣传片演出':[{op:'flash',color:'#fff5d4',duration:.6,hold:.15},
    {op:'shake',intensity:6,duration:.35},
    {op:'titlecard',title:'不屬於暗世界的光彩',duration:2,bg:'transparent',fadeIn:.25,fadeOut:.4},
    {op:'wait',ticks:60},{op:'fade',to:'black',duration:.5}],
  '镜头演出':[{op:'camera',x:320,y:120,ticks:25},{op:'say',pages:['＊ 镜头转向舞台。']},{op:'camera',follow:true}]
};
export function mountEventEditor(root,getProject,onChange,onError){
  const node=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
  const select=node('select'),template=node('select'),add=node('button','新建'),apply=node('button','校验并应用'),area=node('textarea');
  const name=node('input'),battleRef=node('select');
  battleRef.setAttribute('aria-label','对白触发的战斗');
  for(const [el,label] of [[select,'现有事件'],[template,'事件模板'],[name,'新事件 ID'],[area,'事件 JSON']])el.setAttribute('aria-label',label);
  name.placeholder='新事件 ID';area.rows=8;area.spellcheck=false;
  template.replaceChildren(...Object.keys(eventTemplates).map(k=>new Option(k,k)));
  const labels=node('div');labels.className='inline';labels.append(add,apply);
  root.append(select,template,battleRef,name,labels,area);
  function load(){const a=getProject().events?.[select.value];area.value=a?JSON.stringify(a,null,2):'';apply.disabled=!a;}
  function refreshBattles(){
    const before=battleRef.value;
    battleRef.replaceChildren(...Object.entries(getProject().battles??{}).map(([k,v])=>new Option(k+' · '+v.encounter,k)));
    if([...battleRef.options].some(o=>o.value===before))battleRef.value=before;
    battleRef.hidden=template.value!=='对白后开战';
  }
  template.onchange=refreshBattles;
  function refresh(pick){
    select.replaceChildren(new Option('— 选择事件 —',''),...Object.keys(getProject().events??{}).map(k=>new Option(k,k)));
    if(pick)select.value=pick;
    load();refreshBattles();
  }
  select.onchange=load;
  function commit(key,event){
    const p=getProject(),next=Object.assign(Object.create(null),p.events,{[key]:event});
    const result=validateProject({...p,events:next});
    if(!result.ok){const a=result.errors[0];onError(a.path+' · '+a.message);return false;}
    p.events=next;onChange(key);refresh(key);return true;
  }
  add.onclick=()=>{
    const key=name.value.trim();
    if(!key||Object.hasOwn(getProject().events??{},key)){onError('请输入一个未使用的事件 ID。');return;}
    const selected=eventTemplates[template.value];
    const battle=battleRef.value;
    if(!selected&&!battle){onError('请先在「遭遇战与结算」添加一个战斗引用。');return;}
    if(commit(key,selected?structuredClone(selected):[{op:'say',pages:['＊ 对手准备好了。']},{op:'battle',battle}]))name.value='';
  };
  apply.onclick=()=>{
    if(!select.value)return;
    try{commit(select.value,JSON.parse(area.value));}catch(ex){onError(ex.message);}
  };
  return {refresh,disable(v){for(const el of [select,template,battleRef,name,area,add,apply])el.disabled=v||el===apply&&!select.value;}};
}
