
import {validateProject,ENTRY_STYLES} from './format.mjs';

export const ENTRY_LABELS={classic:'经典冲入',fade:'普通淡入',instant:'直接切换'};
export function mountCampaignEditor(root,{getProject,onChange,onError}){
  const make=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
  const enabled=make('input'),key=make('input'),defeat=make('select'),party=make('div'),members=make('div');
  const catalogue=make('textarea'),inventory=make('textarea'),style=make('select'),ticks=make('input'),sfx=make('input');
  const add=make('button','＋ 队员'),apply=make('button','应用队伍与存档设置');
  enabled.type=sfx.type='checkbox';
  ticks.type='number';ticks.min=8;ticks.max=90;ticks.step=1;
  catalogue.rows=4;inventory.rows=3;
  catalogue.spellcheck=inventory.spellcheck=false;
  catalogue.placeholder='{"tonic":{"name":"星糖","heal":18}}';inventory.placeholder='{"tonic":2}';
  defeat.replaceChildren(new Option('落败后回场景','scene'),new Option('落败时提示读档','load'));
  style.replaceChildren(...ENTRY_STYLES.map(k=>new Option(ENTRY_LABELS[k],k)));
  function label(text,e,at=root){
    const l=make('label',text);l.append(e);at.append(l);e.setAttribute('aria-label',text);
  }
  label('启用共享队伍',enabled);
  label('试玩档标识',key);
  label('队伍落败',defeat);
  party.append(members,add);root.append(party);
  label('共享道具定义（JSON）',catalogue);
  label('初始道具数量（JSON）',inventory);
  label('默认入战演出',style);
  label('演出步数（30 步/秒）',ticks);
  label('入战音效',sfx);
  root.append(apply);
  function row(id='',value={}){
    const wrap=make('div');wrap.className='member-row';
    const name=make('input'),display=make('input'),hp=make('input'),max=make('input'),remove=make('button','移除');
    name.value=id;display.value=value.name??'';hp.value=value.hp??value.maxHp??90;max.value=value.maxHp??90;
    hp.type=max.type='number';hp.min=0;max.min=1;hp.max=max.max=9999;
    label('成员 ID',name,wrap);label('显示名',display,wrap);label('初始 HP',hp,wrap);label('最大 HP',max,wrap);
    wrap.append(remove);members.append(wrap);
    remove.onclick=()=>wrap.remove();
    wrap.read=()=>{
      const out={hp:hp.valueAsNumber,maxHp:max.valueAsNumber};
      if(display.value.trim())out.name=display.value.trim();
      return [name.value.trim(),out];
    };
  }
  function refresh(){
    const p=getProject(),c=p.campaign,t=p.battleTransition??{};
    enabled.checked=!!(c?.party||c?.items);key.value=c?.saveKey??'';defeat.value=c?.defeat??'scene';
    members.replaceChildren();
    for(const [id,stats] of Object.entries(c?.party??{}))row(id,stats);
    catalogue.value=JSON.stringify(c?.items??{},null,2);inventory.value=JSON.stringify(p.inventory??{},null,2);
    style.value=t.style??'classic';ticks.value=t.ticks??25;sfx.checked=t.sound??true;
    syncVisibility();
  }
  function syncVisibility(){party.hidden=!enabled.checked;catalogue.disabled=!enabled.checked;}
  enabled.onchange=syncVisibility;
  add.onclick=()=>row();
  apply.onclick=()=>{
    try{
      const p=getProject(),entries=Array.from(members.children,e=>e.read());
      if(enabled.checked&&new Set(entries.map(([k])=>k)).size!==entries.length)throw new Error('成员 ID 不能重复');
      const next={...p,inventory:JSON.parse(inventory.value||'{}'),
        battleTransition:{...p.battleTransition,style:style.value,ticks:ticks.valueAsNumber,sound:sfx.checked}};
      if(enabled.checked||key.value.trim()||defeat.value==='load'){
        next.campaign={defeat:defeat.value};
        if(key.value.trim())next.campaign.saveKey=key.value.trim();
        if(enabled.checked)Object.assign(next.campaign,{party:Object.fromEntries(entries),items:JSON.parse(catalogue.value||'{}')});
      }else delete next.campaign;
      const result=validateProject(next);
      if(!result.ok){const e=result.errors[0];throw new Error(e.path+' · '+e.message);}
      onChange(next);
    }catch(error){onError(error.message);}
  };
  return {refresh,disable(v){
    for(const el of root.querySelectorAll('input,textarea,select,button'))el.disabled=v;
    if(!v)syncVisibility();
  }};
}
