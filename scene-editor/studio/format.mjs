
import {projectPlugins,invoke,missingPlugin} from './plugins.mjs';
import {HZ} from './timing.mjs';
export {HZ};
export * from './format-compat.mjs';

export const FORMAT='deltarune-scene/1';
export const DIRECTIONS=['down','left','right','up'];
const coreModes=['walk','slide','climb','platform'];
const coreTypes=['wall','npc','enemy','door','zone','switch','block','mode','checkpoint','savepoint','hold','prop'];
const builtins=projectPlugins();
export const TRAILER_MODES=[...builtins.modes.keys()];
export const MODES=[...coreModes,...TRAILER_MODES];
export const TYPES=[...coreTypes,...builtins.entities.keys()];
export const modeNames=p=>[...coreModes,...projectPlugins(p).modes.keys()];
export const isPlatformMode=(mode,p)=>mode==='platform'||!!projectPlugins(p).modes.get(mode)?.hooks.platform;
export const PLATFORM_DEFAULTS={platform:{speed:9,acceleration:2,gravity:1.25,jump:20,fallSpeed:20},
  ...Object.fromEntries([...builtins.modes].filter(([,m])=>m.hooks.platform).map(([k,m])=>[k,m.hooks.platform]))};
export const DIRECTOR_OPS = ['flash','shake','titlecard','fade'];
export const ACTIONS = ['say','choose','wait','flag','item','show','sprite','move','camera','branch','call','goto','checkpoint','restore','mode','timer','battle','hp',...DIRECTOR_OPS];
export const INPUTS = ['up','down','left','right','act','cancel','tool','dash','skill2','run','skill1','skill3','skill4','spare'];
export const BATTLE_RESULTS = ['victory','spared','defeat','flee'];
export const BATTLE_SOURCES = ['workspace','sample','project'];
export const ENTRY_STYLES = ['classic','fade','instant'];
const encounterName = /^[A-Za-z0-9_\-\u4e00-\u9fa5]{1,80}$/u;
const device = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
export function validateBattleBindings(value) {
  if (value===undefined) return [];
  if (!record(value)||Object.keys(value).length>24)
    return [{path:'battles',message:'需要一个对象，最多 24 场遭遇'}];
  const errors=[];
  for(const [id,b] of Object.entries(value)){
    const path='battles.'+id;
    if(!key.test(id)||['__proto__','constructor','prototype','player'].includes(id))
      errors.push({path,message:'战斗 ID 无效'});
    if(!record(b)){errors.push({path,message:'应为战斗引用对象'});continue;}
    if(typeof b.encounter!=='string'||!encounterName.test(b.encounter)||device.test(b.encounter))
      errors.push({path:path+'.encounter',message:'应为遭遇文件名（不含 .json）'});
    if(b.source!==undefined&&!BATTLE_SOURCES.includes(b.source))errors.push({path:path+'.source',message:'应为 workspace、sample 或 project'});
    if(b.source==='project'&&(typeof b.work!=='string'||!(/^[\p{L}\p{N}_-][\p{L}\p{N}_. -]{0,79}$/u).test(b.work)
      ||/[. ]$/.test(b.work)||device.test(b.work.split('.')[0])))
      errors.push({path:path+'.work',message:'请选择作品库中的作品目录'});
    if(b.lang!==undefined&&!['zh','en'].includes(b.lang))errors.push({path:path+'.lang',message:'应为 zh 或 en'});
  }
  return errors;
}
const key = /^[\p{L}\p{N}_-]{1,80}$/u;
const hex = /^#[0-9a-f]{6}$/i;
const own = (o,k) => Object.hasOwn(o,k);
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
export const entityKind = e => e.kind??e.type;
export const isTimedInput = row => record(row)&&(own(row,'at')||own(row,'tick'));
export const rectOf = e => ({x:e.x,y:e.y,w:e.w ?? 20,h:e.h ?? 20});

export function validateProject(p) {
  const errors=[], warnings=[];
  const error=(path,message)=>errors.push({path,message});
  const warn=(path,message)=>warnings.push({path,message});
  const obj=(o,path)=>record(o) || (error(path,'应为对象'),false);
  const str=(v,path,max=512)=>typeof v === 'string' && v.trim() && v.length<=max || (error(path,'应为非空文本，长度 ≤ '+max),false);
  const id=(v,path)=>typeof v === 'string' && key.test(v) && !['__proto__','constructor','prototype','player'].includes(v) || (error(path,'ID 只能用字母、数字、下划线、连字符；player 是保留名'),false);
  const num=(v,path,min,max,int=false)=>typeof v==='number' && Number.isFinite(v) && v>=min && v<=max && (!int || Number.isInteger(v)) || (error(path,'应为 '+min+'–'+max+(int?' 的整数':' 之间的数字')),false);
  const one=(v,values,path)=>values.includes(v) || (error(path,'可选：'+values.join('、')),false);
  const opt=(o,k,path,fn)=>!own(o,k) || fn(o[k],path+'.'+k);
  const bool=(v,path)=>typeof v==='boolean' || (error(path,'应为布尔值'),false);
  const arr=(v,path,max=2048)=>Array.isArray(v) && v.length<=max || (error(path,'应为数组，最多 '+max+' 项'),false);
  const color=(v,path)=>typeof v==='string' && hex.test(v) || (error(path,'颜色应为 #RRGGBB'),false);
  const scalar=(v,path)=>['string','boolean'].includes(typeof v) || typeof v==='number' && Number.isFinite(v) || (error(path,'应为字符串、布尔值或有限数字'),false);
  const source=(v,path)=>typeof v==='string' && (/^data:image\/(?:png|webp|gif|jpeg);base64,[a-z0-9+/=]+$/i.test(v) || /^\/(?:official|a-files|custom-assets|animation-assets|plugins|frame0-preview|review012-bg-preview|studio\/art|ch6-assets|ch6-trailer-assets)\/[^?#\\]+$/.test(v) && !decodeSafe(v).split('/').some(s=>s==='..'||s==='.') && !decodeSafe(v).includes('\\')) || (error(path,'请使用本机素材路径或内嵌 PNG/WebP/GIF/JPEG'),false);
  const frames=(v,path)=>{if(arr(v,path,128)) {if(!v.length) error(path,'至少一帧'); v.forEach((a,i)=>source(a,path+'.'+i));}};
  const reference=(table,v,path,label)=>{if(typeof v!=='string'||!own(table,v)) error(path,label+'不存在：'+String(v));};
  if(!obj(p,'$')) return {ok:false,errors,warnings};
  if(p.format!==FORMAT) error('format','应为 '+FORMAT);
  str(p.title,'title',150);
  opt(p,'id','$',id);
  opt(p,'world','$',(v,k)=>one(v,['dark','light'],k));
  opt(p,'viewport','$',(v,path)=>{if(obj(v,path)){num(v.w,path+'.w',160,1600,true);num(v.h,path+'.h',120,1200,true);}});
  const rooms=obj(p.rooms,'rooms')?p.rooms:{};
  if(!Object.keys(rooms).length || Object.keys(rooms).length>512) error('rooms','需要 1–512 个房间');
  const events=obj(p.events ?? {},'events')?p.events??{}:{}, assets=obj(p.assets??{},'assets')?p.assets??{}:{};
  const transition=(t,path)=>{if(obj(t,path)){
    opt(t,'style',path,(v,k)=>one(v,ENTRY_STYLES,k));
    opt(t,'ticks',path,(v,k)=>num(v,k,8,90,true));
    opt(t,'sound',path,bool);
    opt(t,'actors',path,(v,k)=>{if(obj(v,k))for(const [a,e] of Object.entries(v)){
      id(a,k+'.'+a);
      if(e!=='player')id(e,k+'.'+a);
    }});
  }};
  const countMap=(v,path)=>{if(obj(v,path))for(const [k,n] of Object.entries(v)){
    id(k,path+'.'+k);num(n,path+'.'+k,0,999999,true);
  }};
  const campaign=record(p.campaign)?p.campaign:{};
  opt(p,'campaign','$',(c,path)=>{if(obj(c,path)){
    opt(c,'saveKey',path,id);
    opt(c,'defeat',path,(v,k)=>one(v,['scene','load'],k));
    opt(c,'party',path,(v,k)=>{if(obj(v,k)){
      if(Object.keys(v).length>16)error(k,'最多 16 个队伍成员');
      for(const [member,stats] of Object.entries(v)){
        const q=k+'.'+member;id(member,q);
        if(obj(stats,q)){
          num(stats.maxHp,q+'.maxHp',1,9999,true);
          opt(stats,'hp',q,(n,x)=>num(n,x,0,stats.maxHp,true));
          opt(stats,'name',q,(n,x)=>str(n,x,80));
        }
      }
    }});
    opt(c,'items',path,(v,k)=>{if(obj(v,k)){
      if(Object.keys(v).length>128)error(k,'最多 128 种共享道具');
      for(const [item,info] of Object.entries(v)){
        const q=k+'.'+item;id(item,q);
        if(obj(info,q)){
          for(const f of ['name','text'])opt(info,f,q,(n,x)=>{
            if(typeof n==='string')str(n,x,300);
            else if(obj(n,x)){
              if(!['zh','en'].some(l=>own(n,l)))error(x,'需要 zh 或 en 文本');
              for(const l of ['zh','en'])opt(n,l,x,(a,b)=>str(a,b,300));
            }
          });
          opt(info,'heal',q,(n,x)=>num(n,x,0,9999,true));opt(info,'revive',q,bool);
          opt(info,'target',q,(n,x)=>one(n,['party','all','enemy'],x));
        }
      }
    }});
  }});
  opt(p,'battleTransition','$',transition);
  if(Object.keys(events).length>4096)error('events','最多 4096 个事件');
  if(Object.keys(assets).length>2048)error('assets','最多 2048 个素材');
  errors.push(...validateBattleBindings(p.battles));
  const battles=record(p.battles)?p.battles:{};
  const allEntities=Object.create(null);
  const evt=(v,path)=>reference(events,v,path,'事件');
  const sprite=(v,path)=>reference(assets,v,path,'素材');
  const battle=(v,path)=>reference(battles,v,path,'战斗引用');
  for(const [k,b] of Object.entries(battles))if(record(b)){
    const path='battles.'+k;
    opt(b,'resultFlag',path,id);
    opt(b,'carry',path,(v,k)=>one(v,['inherit','isolated'],k));
    if(b.carry==='inherit'&&!record(campaign.party)&&!record(campaign.items))error(path+'.carry','继承队伍需要先启用工程的共享队伍');
    opt(b,'defeat',path,(v,k)=>one(v,['scene','load'],k));
    for(const field of ['partyMap','itemMap'])opt(b,field,path,(v,k)=>{
      if(obj(v,k))for(const [key,value] of Object.entries(v)){
        id(key,k+'.'+key);
        if(value!==null){
          id(value,k+'.'+key);
          if(field==='partyMap')reference(campaign.party??{},value,k+'.'+key,'共享成员');
        }
      }
    });
    opt(b,'rewards',path,(v,q)=>{
      if(obj(v,q))for(const [result,items] of Object.entries(v))if(one(result,BATTLE_RESULTS,q+'.'+result))countMap(items,q+'.'+result);
    });
    opt(b,'transition',path,transition);
    opt(b,'on',path,(v,q)=>{
      if(obj(v,q))for(const [result,event] of Object.entries(v))if(one(result,BATTLE_RESULTS,q+'.'+result))evt(event,q+'.'+result);
    });
  }
  function dest(room,at,path) {
    reference(rooms,room,path+'.room','房间');
    if (typeof room==='string' && own(rooms,room) && record(rooms[room]?.entries)) reference(rooms[room].entries,at,path+'.entry','入口');
    else id(at,path+'.entry');
  }
  function condition(c,path,depth=0) {
    if(depth>12) return error(path,'条件嵌套过深');
    if(!obj(c,path)) return;
    const kinds=['flag','item','all','any','not'].filter(k=>own(c,k));
    if(kinds.length!==1) return error(path,'条件应含 flag / item / all / any / not 中的一项');
    if(own(c,'flag')) {
      id(c.flag,path+'.flag');opt(c,'is',path,scalar);
      if(own(c,'compare')){
        one(c.compare,['eq','ne','lt','le','gt','ge'],path+'.compare');
        if(['lt','le','gt','ge'].includes(c.compare))num(c.is,path+'.is',-1e12,1e12);
        else if(!own(c,'is'))error(path+'.is','比较需要右值');
      }
    }
    if(own(c,'item')) {id(c.item,path+'.item');opt(c,'count',path,(v,k)=>num(v,k,1,999999,true));}
    for(const op of ['all','any']) if(own(c,op)&&arr(c[op],path+'.'+op,32)) {
      if(!c[op].length) error(path+'.'+op,'至少一项');
      c[op].forEach((d,i)=>condition(d,path+'.'+op+'.'+i,depth+1));
    }
    if(own(c,'not')) condition(c.not,path+'.not',depth+1);
  }
  function rhythm(r,path) {
    if(!obj(r,path)) return;
    opt(r,'title',path,(v,k)=>str(v,k,120));
    opt(r,'window',path,(v,k)=>num(v,k,1,18,true));
    opt(r,'resultTicks',path,(v,k)=>num(v,k,1,150,true));
    opt(r,'lead',path,(v,k)=>num(v,k,10,180,true));
    if(arr(r.beats,path+'.beats',128)) {
      if(!r.beats.length) error(path+'.beats','至少一拍');
      let previous=-1;
      for(const [i,b] of r.beats.entries()) {
        const k=path+'.beats.'+i;
        if(!obj(b,k)) continue;
        if(num(b.at,k+'.at',0,108000,true) && b.at<=previous) error(k+'.at','拍点必须严格递增');
        previous=b.at; one(b.key,INPUTS.slice(0,5),k+'.key');
      }
      opt(r,'minHits',path,(v,k)=>num(v,k,1,Math.max(1,r.beats.length),true));
    }
    opt(r,'onWin',path,evt);opt(r,'onLose',path,evt);
  }
  function keypad(kp,path) {
    if(!obj(kp,path)) return;
    opt(kp,'title',path,(v,k)=>str(v,k,120));
    opt(kp,'hint',path,(v,k)=>str(v,k,160));
    if(typeof kp.code!=='string'||!/^[0-9]{1,12}$/.test(kp.code)) error(path+'.code','密码应为 1–12 位数字');
    opt(kp,'onWin',path,evt);opt(kp,'onLose',path,evt);
  }
  if(obj(p.start,'start')) dest(p.start.room,p.start.entry,'start');
  opt(p,'flags','$',(v,path)=>{if(obj(v,path)) for(const [k,x] of Object.entries(v)){id(k,path+'.'+k);scalar(x,path+'.'+k);}});
  opt(p,'inventory','$',(v,path)=>{if(obj(v,path)) for(const [k,x] of Object.entries(v)){id(k,path+'.'+k);num(x,path+'.'+k,0,999999,true);}});
  const range=(lo,hi,integer=false)=>(v,k)=>num(v,k,lo,hi,integer);
  const choice=(...values)=>(v,k)=>one(v,values,k);
  const pair=check=>(v,k)=>{
    if(!Array.isArray(v)||v.length!==2){error(k,'需要两个数值');return;}
    v.forEach((n,i)=>check(n,k+'.'+i));
  };
  const animSettings={ticks:range(1,600,true),loop:bool,flip:bool,anchor:choice('feet','center','topLeft'),offset:pair(range(-16384,16384)),scale:range(.25,8)};
  for(const [a,v] of Object.entries(assets)) {
    const path='assets.'+a;id(a,path);
    if(typeof v==='string') {source(v,path);continue;}
    if(!obj(v,path))continue;
    for(const f of ['loop','flip','offset','scale'])opt(v,f,path,animSettings[f]);
    if(own(v,'src')) source(v.src,path+'.src');
    if(own(v,'frames'))frames(v.frames,path+'.frames');
    opt(v,'ticks',path,animSettings.ticks);
    opt(v,'anchor',path,animSettings.anchor);
    for(const state of ['idle','walk','idle_up','idle_down','idle_left','idle_right','walk_up','walk_down','walk_left','walk_right']) {
      opt(v,state,path,(x,k)=>typeof x==='string'?source(x,k):frames(x,k));
    }
    if(!Object.keys(v).some(k=>k==='src'||k==='frames'||/^(idle|walk)(_|$)/.test(k))) error(path,'缺少图片或动画帧');
  }
  // 自定义零件（逐格编辑用）：字母避开内置符号，素材必须存在。规则与 studio/grid.mjs 的 registry 一致。
  opt(p,'gridParts','$',(v,path)=>{if(!obj(v,path))return;
    const builtin=new Set(['wall','oneway','slide','climb','entry','npc','enemy','door','block','switch','checkpoint','savepoint','prop','zone','hold']);
    const taken=new Set('#-~=@NEDBSCPOZK'),seen=new Map();
    if(Object.keys(v).length>64)error(path,'最多 64 个自定义零件');
    for(const [k,c] of Object.entries(v)){
      const q=path+'.'+k;
      if(id(k,q)&&builtin.has(k))error(q,'ID 与内置零件重复');
      if(!obj(c,q))continue;
      if(typeof c.sym!=='string'||!/^[A-Z]$/.test(c.sym)||taken.has(c.sym))error(q+'.sym','应为一个大写英文字母，且不是内置符号（# - ~ = @ N E D B S C P O Z K）');
      else if(seen.has(c.sym))error(q+'.sym','和 '+seen.get(c.sym)+' 用了同一个字母');
      else seen.set(c.sym,k);
      one(c.kind,['wall','npc','enemy','door','zone','switch','block','checkpoint','savepoint','hold','prop'],q+'.kind');
      opt(c,'label',q,(x,l)=>str(x,l,40));opt(c,'sprite',q,sprite);opt(c,'color',q,color);
      opt(c,'cells',q,(x,l)=>{if(arr(x,l,2)&&x.length===2)x.forEach((n,i)=>num(n,l+'.'+i,1,64,true));else if(Array.isArray(x))error(l,'应为 [宽, 高]');});
      opt(c,'props',q,(x,l)=>{if(obj(x,l))for(const [pk,pv] of Object.entries(x)){
        if(['id','kind','x','y','w','h','sprite'].includes(pk))error(l+'.'+pk,'位置、大小和素材由零件本身决定');else scalar(pv,l+'.'+pk);
      }});
    }
  });
  opt(p,'player','$',(pl,path)=>{if(!obj(pl,path))return;
    opt(pl,'sprite',path,sprite);opt(pl,'color',path,color);
    opt(pl,'speed',path,(v,k)=>num(v,k,.25,12));
    opt(pl,'radius',path,(v,k)=>num(v,k,2,20));
    opt(pl,'reach',path,(v,k)=>num(v,k,4,64));
  });
  const seconds=(v,k)=>num(v,k,0,120);
  const duration=(v,k)=>num(v,k,1/HZ,120);
  function director(a,k){
    opt(a,'duration',k,a.op==='fade'?seconds:duration);
    if(a.op==='flash'){
      opt(a,'color',k,color);opt(a,'hold',k,seconds);
    }
    if(a.op==='shake')opt(a,'intensity',k,(n,q)=>num(n,q,0,100));
    if(a.op==='titlecard'){
      str(a.title,k+'.title',150);opt(a,'subtitle',k,(v,q)=>str(v,q,240));
      opt(a,'bg',k,(v,q)=>v==='transparent'||color(v,q));
      for(const field of ['fadeIn','fadeOut'])opt(a,field,k,seconds);
    }
    if(a.op==='fade')one(a.to,['black','white','clear'],k+'.to');
  }
  function timedRow(row,k,roomScoped=false){
    if(!obj(row,k))return;
    if(own(row,'at')===own(row,'tick'))error(k,'时间线指令需要 at（秒）或 tick（整数帧）中的一项');
    opt(row,'at',k,(n,q)=>num(n,q,0,3600));
    opt(row,'tick',k,(n,q)=>num(n,q,0,3600*HZ,true));
    if(roomScoped&&own(row,'room'))error(k+'.room','房间内时间线已绑定当前房间');
    else opt(row,'room',k,(v,q)=>reference(rooms,v,q,'房间'));
    for(const field of ['press','hold'])opt(row,field,k,(keys,q)=>{
      if(arr(keys,q,INPUTS.length))keys.forEach((v,i)=>one(v,INPUTS,q+'.'+i));
    });
    if(!['op','press','hold'].some(key=>own(row,key)))error(k,'需要 hold、press 或演出 op');
    if(own(row,'op')&&one(row.op,DIRECTOR_OPS,k+'.op'))director(row,k);
  }
  function timeline(list,k,roomScoped=false){
    if(arr(list,k,1024))list.forEach((row,i)=>timedRow(row,k+'.'+i,roomScoped));
  }
  const plugins=projectPlugins(p);
  plugins.errors.forEach(msg=>error('plugins',msg));
  const checks={project:p,obj,str,id,num,one,opt,bool,arr,color,frames,reference,sprite,evt,source,own,record,assets,error,warn,seconds,duration,range,choice,pair,animSettings,timeline};
  const validators=new Map(plugins.extensions.map(ext=>[ext.id,invoke(ext,'validation',checks)]));
  function extension(group,base,name,path){
    return base.includes(name)||plugins[group].has(name)||(error(path,missingPlugin(group,name)),false);
  }
  function check(ext,hook,value,path,room){
    invoke(ext,hook,{...checks,value,path,room,schema:validators.get(ext?.id)});
  }
  for(const [rk,r] of Object.entries(rooms)) {
    const path='rooms.'+rk;id(rk,path);
    if(!obj(r,path))continue;
    num(r.w,path+'.w',64,16384,true);num(r.h,path+'.h',64,16384,true);
    opt(r,'title',path,(v,k)=>str(v,k,120));
    opt(r,'color',path,color);opt(r,'style',path,(v,k)=>one(v,['workshop','canal','theatre','garden','flat'],k));
    opt(r,'platform',path,(v,k)=>{if(obj(v,k)){
      for(const prop of ['gravity','jump','speed','fallSpeed','acceleration','dashSpeed'])opt(v,prop,k,(n,q)=>num(n,q,0.05,80));
      opt(v,'hoverTicks',k,(n,q)=>num(n,q,1,600,true));
      opt(v,'dashTicks',k,(n,q)=>num(n,q,1,90,true));
      opt(v,'retryEntry',k,(name,q)=>reference(r.entries??{},name,q,'重试入口'));
    }});
    opt(r,'mode',path,(v,k)=>extension('modes',coreModes,v,k));opt(r,'onEnter',path,evt);
    opt(r,'navScript',path,(v,k)=>timeline(v,k,true));
    for(const ext of plugins.extensions)check(ext,'validateRoom',r,path,r);
    check(plugins.modes.get(r.mode),'validate',r,path,r);
    opt(r,'parallax',path,(rows,k)=>{if(arr(rows,k,16))rows.forEach((layer,i)=>{
      const q=k+'.'+i;
      if(!obj(layer,q))return;
      source(layer.src,q+'.src');
      for(const f of ['speedX','speedY'])opt(layer,f,q,(v,l)=>num(v,l,-4,4));
      opt(layer,'y',q,(v,l)=>num(v,l,-16384,16384));
      opt(layer,'height',q,(v,l)=>num(v,l,1,4096,true));
      opt(layer,'repeatX',q,bool);opt(layer,'alpha',q,(v,l)=>num(v,l,0,1));
    });});
    opt(r,'skyGradient',path,(g,k)=>{if(obj(g,k)){color(g.top,k+'.top');color(g.bottom,k+'.bottom');}});
    opt(r,'sunbeams',path,(beams,k)=>{
      if(typeof beams==='boolean')return;
      if(arr(beams,k,16))beams.forEach((b,i)=>{
        const q=k+'.'+i;
        if(!obj(b,q))return;
        for(const f of ['x','y'])num(b[f],q+'.'+f,-16384,16384);
        num(b.width,q+'.width',1,4096);
        opt(b,'length',q,(v,l)=>num(v,l,1,8192));
        opt(b,'angle',q,(v,l)=>num(v,l,-360,360));
        opt(b,'alpha',q,(v,l)=>num(v,l,0,1));opt(b,'color',q,color);
        for(const f of ['speedX','speedY'])opt(b,f,q,(v,l)=>num(v,l,-4,4));
      });
    });
    opt(r,'grid',path,(v,k)=>{if(obj(v,k))num(v.size,k+'.size',8,64,true);});
    opt(r,'camera',path,(v,k)=>{if(obj(v,k)){num(v.x,k+'.x',0,r.w);num(v.y,k+'.y',0,r.h);}});
    if(obj(r.entries,path+'.entries')) {
      if(!Object.keys(r.entries).length) error(path+'.entries','至少一个入口');
      for(const [ek,e] of Object.entries(r.entries)) {
        const k=path+'.entries.'+ek;id(ek,k);
        if(obj(e,k)){const radius=p.player?.radius??6;num(e.x,k+'.x',radius,r.w-radius);num(e.y,k+'.y',radius,r.h-radius);opt(e,'face',k,(v,i)=>one(v,DIRECTIONS,i));}
      }
    }
    opt(r,'scenery',path,source);
    opt(r,'layout',path,id);
    if(r.layout&&r.map)error(path,'外部布景和内嵌布景只能选一种');
    opt(r,'playerArt',path,sprite);
    opt(r,'view',path,(v,k)=>{if(obj(v,k)){num(v.w,k+'.w',64,1600,true);num(v.h,k+'.h',64,1200,true);}});
    opt(r,'followers',path,(v,k)=>{if(arr(v,k,4))v.forEach((a,i)=>{
      const q=k+'.'+i;
      if(obj(a,q)){
        sprite(a.sprite,q+'.sprite');num(a.delay,q+'.delay',2,120,true);opt(a,'when',q,condition);
        opt(a,'id',q,(value,field)=>{
          id(value,field);
          if(v.slice(0,i).some(other=>other?.id===value)||r.entities?.some?.(e=>e?.id===value))
            error(field,'跟随者与本房间的其他人物需要不同的 ID');
        });
      }
    });});
    opt(r,'playerFeetOffset',path,(v,k)=>num(v,k,-100,100));
    opt(r,'sourceHud',path,bool);
    opt(r,'world',path,(v,k)=>one(v,['dark','light'],k));
    opt(r,'darkness',path,(v,k)=>num(v,k,0,0.96));
    opt(r,'darkColor',path,color);
    opt(r,'playerLight',path,(v,k)=>num(v,k,0,480));
    opt(r,'tiles',path,(list,k)=>{if(arr(list,k,4096))list.forEach((t,i)=>{
      const q=k+'.'+i;
      if(obj(t,q)){
        // Shared tile placements can refer to a project part or directly to a sprite.
        if(t.part!==undefined){reference(p.tileParts??{},t.part,q+'.part','方块零件');opt(t,'sprite',q,sprite);}
        else sprite(t.sprite,q+'.sprite');
        opt(t,'layer',q,(v,l)=>one(v,['back','actor','front'],l));opt(t,'depth',q,(v,l)=>num(v,l,-480,480));
        num(t.x,q+'.x',-1024,r.w+1024);num(t.y,q+'.y',-1024,r.h+1024);
        opt(t,'w',q,(v,l)=>num(v,l,1,r.w));opt(t,'h',q,(v,l)=>num(v,l,1,r.h));
        opt(t,'front',q,bool);opt(t,'activeWhen',q,condition);
      }
    });});
    opt(r,'tool',path,(v,k)=>{if(obj(v,k)){
      id(v.item,k+'.item');num(v.range,k+'.range',8,240);num(v.width,k+'.width',4,180);
      num(v.ticks,k+'.ticks',1,120,true);opt(v,'sprite',k,sprite);
      opt(v,'variants',k,(items,q)=>{if(arr(items,q,8))items.forEach((b,i)=>{
        const j=q+'.'+i;
        if(obj(b,j)){condition(b.when,j+'.when');num(b.range,j+'.range',8,240);num(b.width,j+'.width',4,180);}
      });});
    }});
    opt(r,'frontLayers',path,(v,k)=>{if(arr(v,k,1024))v.forEach((n,i)=>str(n,k+'.'+i,280));});
    opt(r,'foreground',path,source);
    opt(r,'official',path,(v,k)=>{if(obj(v,k)){one(v.chapter,['ch1','ch2','ch3','ch4','ch5'],k+'.chapter');id(v.room,k+'.room');}});
    opt(r,'map',path,(m,k)=>{
      if(!obj(m,k))return;
      if(m.schema!=='director-map/1'&&m.format!=='director-map/1') error(k,'应为 director-map/1');
      one(m.chapter,['ch1','ch2','ch3','ch4','ch5'],k+'.chapter');
      const layerIds=new Set();
      if(arr(m.layers,k+'.layers',2048))m.layers.forEach((l,i)=>{
        const q=k+'.layers.'+i;
        if(obj(l,q)){
          if(str(l.id,q+'.id',280)){if(layerIds.has(l.id))error(q+'.id','图层 ID 重复');layerIds.add(l.id);}
          num(l.depth,q+'.depth',-2147483648,2147483647,true);opt(l,'visible',q,bool);
        }
      });
      for(const layer of Array.isArray(r.frontLayers)?r.frontLayers:[])if(!layerIds.has(layer))error(path+'.frontLayers','没有图层 '+layer);
      if(arr(m.elements,k+'.elements',50000)) m.elements.forEach((e,i)=>{
        const q=k+'.elements.'+i;
        if(obj(e,q)){str(e.asset,q+'.asset',280);if(!layerIds.has(e.layer))error(q+'.layer','没有图层 '+String(e.layer));num(e.x,q+'.x',-32768,32768);num(e.y,q+'.y',-32768,32768);
          opt(e,'url',q,source);opt(e,'visible',q,bool);
          for(const f of ['scale_x','scale_y'])opt(e,f,q,(v,k)=>num(v,k,-4096,4096));
          opt(e,'rotation',q,(v,k)=>num(v,k,-360000,360000));opt(e,'alpha',q,(v,k)=>num(v,k,0,1));
          opt(e,'animation',q,(a,k)=>{if(obj(a,k)){
            opt(a,'fps',k,(v,l)=>num(v,l,1,60));opt(a,'playing',k,bool);opt(a,'loop',k,bool);
          }});}
      });
    });
    if(!arr(r.entities??[],path+'.entities',10000)) continue;
    for(const [i,e] of (r.entities??[]).entries()){
      const k=path+'.entities.'+i;
      if(!obj(e,k))continue;
      if(id(e.id,k+'.id')) {
        if(own(allEntities,e.id))error(k+'.id','实体 ID 与 '+allEntities[e.id]+' 重复');
        else allEntities[e.id]=k;
      }
      const kind=entityKind(e);
      if(e.kind===undefined&&coreTypes.includes(kind))error(k+'.kind','基础实体需要 kind 字段');
      else extension('entities',coreTypes,kind,e.kind===undefined&&e.type!==undefined?k+'.type':k+'.kind');
      if(plugins.entities.has(e.type)&&kind!==e.type)error(k+'.type','type 与 kind 不一致');
      opt(e,'name',k,(v,l)=>str(v,l,120));opt(e,'sprite',k,sprite);opt(e,'color',k,color);
      num(e.x,k+'.x',0,r.w);num(e.y,k+'.y',0,r.h);
      num(e.w??20,k+'.w',1,r.w);num(e.h??20,k+'.h',1,r.h);
      if(e.x+(e.w??20)>r.w || e.y+(e.h??20)>r.h) error(k,'实体矩形超出房间');
      for(const a of ['once','auto','hidden','solid','facing','latch','draw','toolTarget','oneWay']) opt(e,a,k,bool);
      for(const a of ['when','activeWhen']) opt(e,a,k,condition);
      for(const a of ['event','otherwise']) opt(e,a,k,evt);
      opt(e,'light',k,(v,l)=>{if(obj(v,l)){
        num(v.r,l+'.r',8,480);opt(v,'color',l,color);opt(v,'flicker',l,(n,q)=>num(n,q,0,1));
      }});
      opt(e,'beam',k,(v,l)=>{if(obj(v,l)){
        num(v.angle,l+'.angle',-360,360);num(v.range,l+'.range',20,640);
        opt(v,'sweep',l,(n,q)=>num(n,q,-180,180));opt(v,'period',l,(n,q)=>num(n,q,15,600));
        opt(v,'spread',l,(n,q)=>num(n,q,6,120));opt(v,'color',l,color);
        opt(v,'onCatch',l,evt);
      }});
      if(e.kind==='door'){
        if(e.room===undefined&&e.entry===undefined)warn(k,'门未绑定目标，试玩时不会转场');
        else dest(e.room,e.entry,k);
        opt(e,'fade',k,(v,l)=>num(v,l,0,120,true));
      }
      if(e.kind==='enemy'){
        opt(e,'battle',k,battle);
        if(e.battle===undefined&&!e.event)warn(k,'敌人还没有绑定战斗或事件');
        if(e.auto!==false&&e.solid)warn(k+'.solid','固体会挡住接触触发；可关闭固体或改用按 Z');
      }
      check(plugins.entities.get(kind),'validate',e,k,r);
      if(e.kind==='switch')id(e.flag,k+'.flag');
      if(e.kind==='mode'){
        extension('modes',coreModes,e.mode,k+'.mode');opt(e,'grip',k,(v,l)=>num(v,l,1,3600,true));
        opt(e,'rest',k,bool);
      }
      if(e.kind==='savepoint'){
        opt(e,'heal',k,bool);opt(e,'confirm',k,bool);opt(e,'beforeEvent',k,evt);
        opt(e,'entry',k,(v,l)=>reference(r.entries??{},v,l,'当前房间入口'));
      }
      if(e.kind==='hold'){
        num(e.ticks,k+'.ticks',1,3600,true);
        opt(e,'decay',k,(v,l)=>num(v,l,0,600));
        if(!e.event)warn(k+'.event','完成长按后未绑定事件');
      }
    }
    if (record(r.entries)&&Array.isArray(r.entities??[])) for(const [ek,v] of Object.entries(r.entries)) if(record(v)) {
      const radius=p.player?.radius??6;
      const overlap=(r.entities??[]).find(e=>record(e)&&!e.activeWhen&&!e.hidden&&!plugins.entities.get(entityKind(e))?.hooks.ignoreSolid&&(e.kind==='wall'||e.kind==='block'||e.solid)&&v.x+radius>e.x&&v.x-radius<e.x+(e.w??20)&&v.y+radius>e.y&&v.y-radius<e.y+(e.h??20));
      if(overlap)error(path+'.entries.'+ek,'入口与固体 '+overlap.id+' 重叠');
    }
  }
  const callGraph=new Map();
  function sequence(list,path,owner,depth=0) {
    if(depth>12) return error(path,'指令嵌套过深');
    if(!arr(list,path,256)) return;
    for(const [i,a] of list.entries()){
      const k=path+'.'+i;
      if(!obj(a,k)||!extension('actions',ACTIONS,a.op,k+'.op'))continue;
      check(plugins.actions.get(a.op),'validate',a,k);
      if(a.op==='say'){
        if(arr(a.pages,k+'.pages',128)){
          if(!a.pages.length)error(k+'.pages','对白至少一页');
          for(const [j,page] of a.pages.entries()){
            const q=k+'.pages.'+j;
            if(typeof page==='string'){str(page,q,3000);continue;}
            if(obj(page,q)){str(page.text,q+'.text',3000);opt(page,'speaker',q,(v,l)=>str(v,l,100));opt(page,'portrait',q,sprite);}
          }
        }
      }
      if(a.op==='choose'){
        str(a.question,k+'.question',240);
        if(arr(a.options,k+'.options',6)){
          if(a.options.length<2)error(k+'.options','至少两个选项');
          for(const [j,c] of a.options.entries()){
            const q=k+'.options.'+j;
            if(obj(c,q)){str(c.text,q+'.text',80);sequence(c.actions,q+'.actions',owner,depth+1);}
          }
        }
      }
      if(['wait','timer'].includes(a.op))num(a.ticks,k+'.ticks',1,108000,true);
      if(a.op==='flag'){id(a.id,k+'.id');scalar(a.value,k+'.value');}
      if(a.op==='item'){id(a.id,k+'.id');num(a.delta,k+'.delta',-999999,999999,true);}
      if(['show','move','sprite'].includes(a.op) && a.actor!=='player')reference(allEntities,a.actor,k+'.actor','实体');
      if(a.op==='show'){if(a.actor==='player')error(k+'.actor','玩家显示状态不可修改');bool(a.value,k+'.value');}
      if(a.op==='sprite')sprite(a.sprite,k+'.sprite');
      if(a.op==='move'||(a.op==='camera'&&a.follow!==true)){
        for(const axis of ['x','y'])num(a[axis],k+'.'+axis,0,16384);
        opt(a,'ticks',k,(v,l)=>num(v,l,1,3600,true));
        if(a.op==='move')opt(a,'face',k,(v,l)=>one(v,DIRECTIONS,l));
      }
      if(a.op==='camera')opt(a,'follow',k,bool);
      if(a.op==='branch'){condition(a.if,k+'.if');sequence(a.then,k+'.then',owner,depth+1);if(a.else!==undefined)sequence(a.else,k+'.else',owner,depth+1);}
      if(a.op==='call'||a.op==='timer'){
        evt(a.event,k+'.event');if(a.op==='call'&&typeof a.event==='string'&&own(events,a.event))callGraph.get(owner).push(a.event);
      }
      if(a.op==='timer')opt(a,'global',k,bool);
      if(a.op==='goto'){dest(a.room,a.entry,k);opt(a,'fade',k,(v,l)=>num(v,l,0,120,true));}
      if(a.op==='battle')battle(a.battle,k+'.battle');
      if(a.op==='hp'){
        if(a.member!=='party')reference(campaign.party??{},a.member,k+'.member','共享成员');
        else if(!Object.keys(campaign.party??{}).length)error(k+'.member','工程未配置共享成员');
        if(a.full!==true)num(a.delta,k+'.delta',-9999,9999,true);
        opt(a,'full',k,bool);
      }
      if(a.op==='mode'){extension('modes',coreModes,a.mode,k+'.mode');opt(a,'grip',k,(v,l)=>num(v,l,1,3600,true));}
      if(DIRECTOR_OPS.includes(a.op))director(a,k);
    }
  }
  for(const e of Object.keys(events)) callGraph.set(e,[]);
  for(const [e,v] of Object.entries(events)){
    const path='events.'+e;id(e,path);
    if(Array.isArray(v))sequence(v,path,e);
    else if(obj(v,path)){
      if(v.type==='rhythm') rhythm(v,path);
      else if(v.type==='keypad') keypad(v,path);
      else error(path+'.type','专用事件目前支持 rhythm、keypad；普通事件使用指令数组');
    }
  }
  const visited=new Set(), stack=new Set();
  function visit(e){
    if(stack.has(e)){error('events.'+e,'call 不能循环调用');return;}
    if(visited.has(e))return;
    stack.add(e);for(const child of callGraph.get(e))visit(child);stack.delete(e);visited.add(e);
  }
  for(const e of callGraph.keys())visit(e);
  opt(p,'navScript','$',(list,path)=>{if(arr(list,path,1024))list.forEach((step,i)=>{
    const q=path+'.'+i;
    if(isTimedInput(step)){timedRow(step,q);return;}
    if(!obj(step,q))return;
    opt(step,'id',q,id);
    reference(rooms,step.room,q+'.room','房间');
    opt(step,'label',q,(v,l)=>str(v,l,120));
    opt(step,'when',q,condition);opt(step,'until',q,condition);
    one(step.action,['interact','tool','hold','push','zone','door'],q+'.action');
    reference(allEntities,step.target,q+'.target','实体');
    opt(step,'face',q,(v,l)=>one(v,DIRECTIONS,l));
    opt(step,'pushDir',q,(v,l)=>one(v,DIRECTIONS,l));
    opt(step,'choice',q,(v,l)=>num(v,l,0,10,true));
    opt(step,'keypadCode',q,(v,l)=>typeof v==='string'&&/^[0-9]{1,12}$/.test(v)||(error(l,'密码应为 1–12 位数字'),false));
  });});
  return {ok:!errors.length,errors,warnings};
}
function decodeSafe(v){try{return decodeURIComponent(v);}catch{return '..';}}
