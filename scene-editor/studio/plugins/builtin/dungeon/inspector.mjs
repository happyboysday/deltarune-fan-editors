import {FREE_SYMBOLS, registry, gridSize, TILE_LAYERS} from '../../../grid.mjs';
import {PLATFORM_DEFAULTS} from '../../../format.mjs';
import {animation, frameImage, drawFrame, mountPreview} from '../../../anim-preview.mjs';
import {officialKrisFighter,officialTileParts,officialEnemyTypes,OFFICIAL_TILESETS} from './presets.mjs';

export const layers={collision:'碰撞',back:'背景',actor:'同层',front:'前景 · 遮挡角色',objects:'敌人与物件'};
const tileSymbols=[...'abcdefghijklmnopqrstuvwxyz0123456789'];
const $=id=>document.getElementById(id);
const el=(tag,text)=>Object.assign(document.createElement(tag),text==null?{}:{textContent:text});
function button(parent,label,fn){
  const b=el('button',label);b.type='button';b.onclick=fn;parent.append(b);return b;
}
function label(parent,title,input){input.setAttribute('aria-label',title);const l=el('label',title);l.append(input);parent.append(l);return input;}
function select(parent,title,choices,value,change){
  const s=el('select');
  for(const choice of choices){
    const [id,name]=Array.isArray(choice)?choice:[choice,choice];
    s.add(new Option(name,id));
  }
  s.value=value??'';s.onchange=()=>change(s.value);return label(parent,title,s);
}
function input(parent,title,obj,key,{type='number',min,step='any',required=false}={}){
  const i=el('input');i.type=type;i.required=required;
  if(type==='number'){i.step=step;if(min!=null)i.min=min;}
  if(type==='checkbox')i.checked=!!obj[key];else i.value=obj[key]??'';
  i.oninput=()=>{
    if(type==='checkbox')obj[key]=i.checked;
    else if(!i.value)delete obj[key];
    else obj[key]=type==='number'?i.valueAsNumber:i.value;
  };
  return label(parent,title,i);
}
function group(parent,title){
  const section=el('fieldset');section.append(el('legend',title));const body=el('div');body.className='dg-fields';section.append(body);parent.append(section);return body;
}
function modal(title,save){
  const d=el('dialog'),form=el('form'),head=el('h2',title),body=el('div'),foot=el('footer'),error=el('output');
  d.className='dg-dialog';body.className='dg-body';error.className='error';error.role='alert';
  button(foot,'取消',()=>d.close());const ok=el('button','保存');ok.type='submit';ok.className='primary';foot.append(ok);
  form.onsubmit=async e=>{e.preventDefault();try{await save();d.close();}catch(ex){error.value=ex.message;}};
  form.append(head,body,error,foot);d.append(form);document.body.append(d);
  d.addEventListener('close',()=>d.remove(),{once:true});d.showModal();
  return {body,d,ok,report:msg=>{error.value=msg;}};
}
const nextId=(table,base)=>{let id=base,n=2;while(Object.hasOwn(table??{},id))id=base+'_'+n++;return id;};
const dataURL=file=>new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(Error('无法读取 '+file.name));r.readAsDataURL(file);});
async function officialJSON(path){
  const response=await fetch(path);if(!response.ok)throw Error('未能读取官方素材（'+response.status+'）');return response.json();
}
function freeSymbol(p,enemy,except){
  if(!enemy)return tileSymbols.find(s=>!Object.values(p.tileParts??{}).some(t=>t.sym===s));
  return FREE_SYMBOLS.filter(s=>!Object.values(p.gridParts??{}).some(v=>v.sym===s)
    && !Object.entries(p.enemyTypes??{}).some(([k,v])=>k!==except && v.sym===s));
}
const actors={idle:'待机',walk:'行走',run:'奔跑',jump:'跳跃',fall:'下落',dodge:'闪避',hurt:'受伤',down:'倒下'};
const enemies={idle:'待机',move:'移动',attack:'攻击',hurt:'受伤',die:'死亡'};
const names={hp:'HP',damage:'伤害',w:'宽',h:'高',x:'X',y:'Y',speed:'速度',life:'寿命（tick）',ticks:'持续 tick',range:'距离',
  windup:'前摇',active:'生效',recovery:'后摇',lunge:'突进速度',knockback:'击退',hitstop:'顿帧',radius:'半径',window:'窗口 tick',stun:'眩晕',
  invulnerable:'无敌 tick',interval:'间隔（秒）',delay:'延迟（秒）',count:'数量',spread:'散射角',gravity:'重力',amount:'回复量',
  walkSpeed:'行走速度',runSpeed:'奔跑速度',jump:'跳跃',comboWindow:'连段窗口',aggroRange:'警戒距离',cooldown:'冷却（秒）',cast:'施放前摇'};
function numbers(root,obj,keys){
  for(const k of keys.split(' '))input(root,names[k]??k,obj,k,{min:['x','y','gravity','lunge','spread'].includes(k)?undefined:['w','h','hp','count'].includes(k)?1:0});
}
function attack(){return {windup:2,active:3,recovery:6,hitbox:{x:6,y:-30,w:28,h:22},damage:2};}
const skills={projectile:'飞射',area:'范围',parry:'弹反',dash:'突进',heal:'治疗'};
const skillDefaults={projectile:{speed:7,life:40,w:26,h:30,damage:3},area:{x:0,y:-30,w:36,h:30,damage:2,ticks:5},
  parry:{radius:40,window:6},dash:{speed:9,ticks:8,damage:2},heal:{amount:10}};
function editActor(p,enemy,id,commit){
  const table=enemy?'enemyTypes':'fighters',isNew=!id;
  id??=nextId(p[table],enemy?'enemy':'fighter');
  const letters=freeSymbol(p,true,id);
  if(enemy&&!letters.length)throw Error('敌人与物件的大写符号已用完');
  const draft=structuredClone(p[table]?.[id]??(enemy?{label:'新敌人',sym:letters[0],cells:[1,2],ai:'patrol',hp:8,damage:10,
    speed:.9,aggroRange:160,gravity:true,contact:true,box:{w:20,h:30},anims:{}}:{name:'新角色',hp:120,walkSpeed:3.2,runSpeed:5.4,
    jump:10.7,box:{w:18,h:34},comboWindow:15,anims:{},attacks:[attack()],skills:[]}));
  const assets={...p.assets};
  const {d,body,report}=modal((isNew?'新建':'编辑')+(enemy?'敌人类型':'角色动作')+' · '+id,()=>{
    if(!enemy && new Set(draft.skills?.map(s=>s.id)).size!==(draft.skills?.length??0))throw Error('技能 ID 不能重复');
    commit({...p,assets,[table]:{...p[table],[id]:draft}},enemy?'objects':undefined);
  });
  body.classList.add('dg-actor');const stats=el('div');body.append(stats);
  const base=group(stats,enemy?'敌人类型':'角色基础数值');
  input(base,'名称',draft,enemy?'label':'name',{type:'text',required:true});
  numbers(base,draft,enemy?'hp damage speed aggroRange':'hp walkSpeed runSpeed jump comboWindow');
  const box=group(stats,'碰撞框 · 像素');draft.box??=enemy?{w:20,h:30}:{w:18,h:34};numbers(box,draft.box,'w h');
  if(enemy){
    select(base,'AI',['patrol','chase','turret','flyer'],draft.ai??'patrol',v=>draft.ai=v);
    select(base,'地图符号',letters,draft.sym,v=>draft.sym=v);
    draft.cells??=[1,1];input(base,'占格宽',draft.cells,0,{min:1,step:1,required:true});input(base,'占格高',draft.cells,1,{min:1,step:1,required:true});
    for(const [key,title] of [['gravity','受重力影响'],['contact','接触伤害']])input(base,title,draft,key,{type:'checkbox'});
    input(base,'击败事件 ID',draft,'onDefeat',{type:'text'});
    const optional=(key,title,defaults,fields)=>{
      const root=group(stats,title),toggle=el('input'),params=el('div');params.className='dg-fields dg-wide';toggle.type='checkbox';toggle.checked=!!draft[key];
      label(root,'启用',toggle);root.append(params);
      function render(){
        params.replaceChildren();if(!draft[key])return;
        numbers(params,draft[key],fields);
        if(key==='melee'){const b=group(params,'近战判定');draft.melee.hitbox??={...defaults.hitbox};numbers(b,draft.melee.hitbox,'x y w h');}
        else{input(params,'子弹素材',draft.shoot,'sprite',{type:'text'});input(params,'子弹颜色',draft.shoot,'color',{type:'color'});}
      }
      toggle.onchange=()=>{if(toggle.checked)draft[key]=structuredClone(defaults);else delete draft[key];render();};render();
    };
    optional('melee','近战',{range:28,windup:12,active:4,recovery:18,damage:14,hitbox:{x:4,y:-26,w:24,h:20}},'range windup active recovery damage');
    optional('shoot','射击',{interval:1.6,delay:.6,speed:3.4,count:1,spread:0,range:220},'interval delay speed count spread range');
  }
  const actions=el('section');actions.className='dg-actions';body.prepend(actions);
  draft.anims??={};let slot='idle',stop=()=>{},official=[];
  function render(){
    stop();actions.replaceChildren();
    const slots=Object.entries(enemy?enemies:actors);
    if(!enemy){
      (draft.attacks??=[]).forEach((_,i)=>slots.push(['atk'+i,'攻击 '+(i+1)]));slots.push(['air','空中攻击']);
      (draft.skills??=[]).forEach((s,i)=>slots.push(['skill'+i,'技能 '+(i+1)+' · '+(s.name??s.id)]));
    }
    const bar=group(actions,'动作槽位');select(bar,'动作',slots,slot,v=>{slot=v;render();});
    const atk=slot.startsWith('atk'),skill=slot.startsWith('skill'),idx=Number(slot.replace(/\D/g,''));
    let owner=draft.anims,key=slot;
    if(atk){owner=draft.attacks[idx];key='anim';}
    if(skill){owner=draft.skills[idx];key='anim';}
    const isAttack=atk||slot==='air';
    let air=draft.airAttack??attack();
    if(slot==='air'){owner=air;key='anim';}
    function materialize(){if(slot==='air')draft.airAttack=air;}
    function value(){return slot==='dodge'?draft.dodge?.anim??owner[key]:owner[key];}
    function put(a){materialize();if(a==null)delete owner[key];else owner[key]=a;
      if(slot==='dodge'&&draft.dodge){if(a==null)delete draft.dodge.anim;else draft.dodge.anim=a;}}
    const getAnim=()=>animation(value(),assets);
    if(!enemy){
      button(bar,'＋ 攻击',()=>{draft.attacks.push(attack());slot='atk'+(draft.attacks.length-1);render();});
      if(atk){
        for(const [delta,title] of [[-1,'前移'],[1,'后移']]){
          const target=idx+delta;button(bar,title,()=>{[draft.attacks[idx],draft.attacks[target]]=[draft.attacks[target],draft.attacks[idx]];slot='atk'+target;render();}).disabled=target<0 || target>=draft.attacks.length;
        }
        button(bar,'删除此段',()=>{draft.attacks.splice(idx,1);slot='idle';render();});
      }
      button(bar,'＋ 技能',()=>{
        const input=['skill1','skill2','skill3','skill4'].find(k=>!draft.skills.some(s=>s.input===k));
        if(!input)return report('四个技能按键都已使用');
        const id=nextId(Object.fromEntries(draft.skills.map(s=>[s.id,true])),'skill');
        draft.skills.push({id,name:'新技能',input,type:'projectile',cast:4,cooldown:1.2,projectile:{...skillDefaults.projectile}});
        slot='skill'+(draft.skills.length-1);render();
      });
      if(skill)button(bar,'删除技能',()=>{draft.skills.splice(idx,1);slot='idle';render();});
    }
    const preview=el('div');preview.className='dg-preview';actions.append(preview);
    const media=group(actions,'动画素材');
    select(media,'工程素材',[['','未选择 / 内联帧'],...Object.keys(assets)],typeof value()==='string'?value():'',v=>{put(v||undefined);render();});
    const library=select(media,'官方第 5 章动画',[['','选择动作…'],...official.map(a=>a.id)],'',v=>{
      const a=official.find(a=>a.id===v);if(!a)return;
      let id=a.id;if(assets[id] && JSON.stringify(animation(id,assets).frames)!==JSON.stringify(a.frames))id=nextId(assets,id);
      // The directory lists whole sequences; the preset may split the same source into combo stages.
      // Transfer its native origin even when the two local URL aliases differ.
      const path=src=>src?.replace(/^\/a-files\/official\//,'/official/');
      const catalog=a.id.startsWith('spr_kris_plat_')?officialKrisFighter():officialEnemyTypes();
      const known=Object.values(catalog.assets??{}).map(ref=>animation(ref,{}))
        .find(ref=>path(ref.frames[0])===path(a.frames[0]));
      assets[id]??={ticks:4,anchor:'feet',...known,frames:a.frames};put(id);render();
    });
    library.dataset.official='true';
    const files=el('input');files.type='file';files.accept='image/*';files.multiple=true;
    files.onchange=async()=>{try{
      const seq=[...files.files].sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}));
      if(!seq.length)return;if(seq.length>128)throw Error('一组动画最多 128 帧');
      const frames=await Promise.all(seq.map(dataURL));
      if(!files.isConnected)return;put({frames,ticks:4,anchor:'feet'});render();
    }catch(ex){report(ex.message);}};label(media,'导入帧序列',files);
    const ticks=el('input');ticks.type='number';ticks.min=1;ticks.max=120;ticks.value=getAnim().ticks??4;
    ticks.oninput=()=>{if(ticks.validity.valid && ticks.value && getAnim().frames.length)put({...getAnim(),ticks:+ticks.value});};
    label(media,'每帧 tick（30 Hz）',ticks);
    const alignment=el('details');alignment.className='dg-wide';alignment.append(el('summary','素材朝向与脚底偏移'));
    const align=group(alignment,'动画对齐');media.append(alignment);
    const a=getAnim(),transform={scale:a.scale??1,flip:a.flip??false,x:a.offset?.[0]??0,y:a.offset?.[1]??0};
    input(align,'素材朝左',transform,'flip',{type:'checkbox'});
    const scale=input(align,'缩放倍率',transform,'scale',{min:.25,required:true});scale.max=8;
    input(align,'X 偏移（原生 px）',transform,'x');input(align,'Y 偏移（原生 px）',transform,'y');
    align.oninput=()=>{if(scale.validity.valid && getAnim().frames.length)put({...getAnim(),scale:transform.scale,flip:transform.flip,offset:[transform.x??0,transform.y??0]});};
    const loops=['idle','walk','run','fall','move'].includes(slot);
    const loopInput=el('input');loopInput.type='checkbox';loopInput.checked=getAnim().loop??loops;
    loopInput.onchange=()=>{if(getAnim().frames.length)put({...getAnim(),loop:loopInput.checked});};label(media,'循环播放',loopInput);
    let setBox;
    if(isAttack){
      const fields=group(actions,'攻击 · 面朝右，相对脚底');numbers(fields,owner,'windup active recovery damage lunge knockback hitstop');
      input(fields,'特效素材',owner,'effect',{type:'text'});
      owner.hitbox??={x:6,y:-30,w:28,h:22};
      const hb=group(actions,'判定框 · 在预览上拖出矩形');
      const inputs=Object.fromEntries(['x','y','w','h'].map(k=>[k,input(hb,names[k],owner.hitbox,k,{min:['w','h'].includes(k)?1:undefined})]));
      setBox=b=>{materialize();Object.assign(owner.hitbox,b);for(const k in inputs)inputs[k].value=b[k];};
      fields.oninput=hb.oninput=materialize;
    }
    if(slot==='dodge'){
      const fields=group(actions,'闪避');draft.dodge??={ticks:9,speed:9.2,invulnerable:9,cooldown:.35,afterimages:true};
      numbers(fields,draft.dodge,'ticks speed invulnerable cooldown');input(fields,'残影',draft.dodge,'afterimages',{type:'checkbox'});
    }
    if(skill){
      const f=group(actions,'技能');input(f,'ID',owner,'id',{type:'text',required:true});input(f,'技能名',owner,'name',{type:'text',required:true});
      select(f,'按键',['skill1','skill2','skill3','skill4'].filter(k=>!draft.skills.some(s=>s!==owner&&s.input===k)),owner.input,v=>owner.input=v);
      select(f,'类型',Object.entries(skills),owner.type,v=>{delete owner[owner.type];owner.type=v;owner[v]={...skillDefaults[v]};render();});
      numbers(f,owner,'cooldown cast');input(f,'特效素材',owner,'sprite',{type:'text'});input(f,'音效名',owner,'sound',{type:'text'});
      const params=owner[owner.type]??={...skillDefaults[owner.type]};
      numbers(f,params,({projectile:'speed life w h damage gravity count spread',area:'x y w h damage ticks knockback',parry:'radius window stun',dash:'speed ticks damage invulnerable',heal:'amount'})[owner.type]);
      if(owner.type==='projectile')input(f,'贯穿',params,'pierce',{type:'checkbox'});
      if(owner.type==='parry')input(f,'反射',params,'reflect',{type:'checkbox'});
    }
    stop=mountPreview(preview,{getAnim,getEffect:()=>isAttack?animation(owner.effect,assets):null,getBox:()=>isAttack?owner.hitbox:null,setBox,loop:loops});
  }
  render();d.addEventListener('close',()=>stop(),{once:true});
  officialJSON('/api/studio/dungeon-animations').then(rows=>{
    official=rows;
    const s=actions.querySelector('[data-official]');if(s)for(const a of rows)s.add(new Option(a.id,a.id));
  }).catch(ex=>report(ex.message));
}

function tileDialog(p,room,commit,atlasMode=false,currentLayer){
  const sym=freeSymbol(p,false);
  if(!sym)throw Error('36 个方块符号都已使用');
  const g=gridSize(room),assets={...p.assets},id=nextId(p.tileParts,'tile');
  const part={sym,label:'新方块',layer:TILE_LAYERS.includes(currentLayer)?currentLayer:'back',solid:'none',depth:0,cells:[1,1]};
  const {body,d,report}=modal('新建方块零件 · '+sym,()=>{
    if(atlasMode){
      if(!crop.width || !ready)throw Error('请先选取瓦片区域');
      const sprite=nextId(assets,'tile_'+set.id.replace(/[^\w-]/g,'_').slice(0,40));
      assets[sprite]=crop.toDataURL('image/png');part.sprite=sprite;
    }
    if(!part.sprite)throw Error('请先选择或导入图片');
    commit({...p,assets,tileParts:{...p.tileParts,[id]:part}},part.layer,'tile:'+id);
  });
  let set,img,preset,ready=false,serial=0;
  const source=group(body,atlasMode?'官方第 5 章瓦片集':'方块素材');
  const crop=el('canvas');crop.width=0;crop.className='dg-crop';
  const general=group(body,'放置属性');input(general,'名称',part,'label',{type:'text',required:true});
  select(general,'图层',TILE_LAYERS.map(l=>[l,layers[l]]),part.layer,v=>part.layer=v);
  select(general,'碰撞',[['none','无'],['solid','实体'],['oneway','单向平台']],part.solid,v=>part.solid=v);
  input(general,'排序深度（像素）',part,'depth');
  const w=input(general,'占格宽',part.cells,0,{min:1,step:1,required:true}),h=input(general,'占格高',part.cells,1,{min:1,step:1,required:true});
  function dimensions(iw,ih){w.value=part.cells[0]=Math.max(1,Math.ceil(iw/g));h.value=part.cells[1]=Math.max(1,Math.ceil(ih/g));}
  if(!atlasMode){
    const preview=el('img');preview.className='dg-sample';preview.alt='方块预览';
    const use=id=>{
      part.sprite=id;const src=animation(id,assets).frames[0];
      preview.onload=()=>dimensions(preview.naturalWidth,preview.naturalHeight);
      if(src)preview.src=src;else preview.removeAttribute('src');
    };
    const list=select(source,'工程素材',[['','选择图片…'],...Object.keys(assets)],'',use);
    const file=el('input');file.type='file';file.accept='image/*';label(source,'导入图片',file);
    file.onchange=async()=>{try{if(!file.files.length)return;const id=nextId(assets,'tile_image');assets[id]=await dataURL(file.files[0]);list.add(new Option(file.files[0].name,id));list.value=id;use(id);}catch(ex){report(ex.message);}};
    source.append(preview);if(Object.keys(assets).length){list.selectedIndex=1;use(list.value);}
    return;
  }
  const atlas=el('canvas');atlas.className='dg-atlas';atlas.width=1;atlas.height=1;
  const pos={x:0,y:0,w:1,h:1},inputs={};let start;
  function draw(){
    ready=false;if(!img?.complete || !img.naturalWidth || !set)return;
    const {tile,border,cols,rows}=set,stride=tile+border*2;
    const ctx=atlas.getContext('2d');ctx.clearRect(0,0,atlas.width,atlas.height);ctx.drawImage(img,0,0);
    if(!Object.values(pos).every(Number.isInteger)||pos.x<0||pos.y<0||pos.w<1||pos.h<1||pos.x+pos.w>cols||pos.y+pos.h>rows)return;
    ctx.strokeStyle='#ffdb74';ctx.lineWidth=3;ctx.strokeRect(pos.x*stride+1.5,pos.y*stride+1.5,pos.w*stride-3,pos.h*stride-3);
    crop.width=pos.w*tile;crop.height=pos.h*tile;const c=crop.getContext('2d');
    for(let y=0;y<pos.h;y++)for(let x=0;x<pos.w;x++)c.drawImage(img,(pos.x+x)*stride+border,(pos.y+y)*stride+border,tile,tile,x*tile,y*tile,tile,tile);
    dimensions(crop.width,crop.height);ready=true;
  }
  function change(s){
    set=s;preset=officialTileParts(s.id);
    report(Object.keys(preset.tileParts??{}).length?'可导入该集预设，或另选区域保存。':'该集尚无方块预设。可直接裁取下方官方瓦片。');
    img=new Image();const version=++serial;ready=false;
    img.onload=()=>{if(version!==serial)return;atlas.width=img.width;atlas.height=img.height;Object.assign(pos,{x:0,y:0,w:1,h:1});sync();};
    img.onerror=()=>report('瓦片图读取失败：'+s.src);img.src=s.src;
  }
  function sync(){for(const k in inputs)inputs[k].value=pos[k];draw();}
  function cell(e){const b=atlas.getBoundingClientRect(),step=set.tile+2*set.border;
    return [Math.max(0,Math.min(set.cols-1,Math.floor((e.clientX-b.left)/b.width*atlas.width/step))),Math.max(0,Math.min(set.rows-1,Math.floor((e.clientY-b.top)/b.height*atlas.height/step)))];}
  atlas.onpointerdown=e=>{if(!img?.naturalWidth)return;start=cell(e);atlas.setPointerCapture(e.pointerId);Object.assign(pos,{x:start[0],y:start[1],w:1,h:1});sync();};
  atlas.onpointermove=e=>{if(!start)return;const [x,y]=cell(e);Object.assign(pos,{x:Math.min(x,start[0]),y:Math.min(y,start[1]),w:1+Math.abs(x-start[0]),h:1+Math.abs(y-start[1])});sync();};
  atlas.onpointerup=atlas.onpointercancel=()=>{start=null;};
  const region=group(body,'瓦片区域 · 单击一格或拖选矩形');
  for(const [k,title] of [['x','起始列（0 起）'],['y','起始行（0 起）'],['w','列数'],['h','行数']]){
    inputs[k]=input(region,title,pos,k,{min:k==='w'||k==='h'?1:0,step:1,required:true});inputs[k].addEventListener('input',draw);
  }
  source.append(atlas);region.append(crop);
  function listSets(sets){
    if(!sets.length)throw Error('没有可用的官方瓦片集');
    const s=select(source,'瓦片集',sets.map(s=>[s.id,s.label??s.id]),sets[0].id,id=>change(sets.find(s=>s.id===id)));
    source.prepend(s.parentElement);
    button(source,'导入该集的官方预设',()=>{
      try{
        const bundle=preset;
        if(!Object.keys(bundle.tileParts??{}).length)return report('该集尚无预设，可以在下方选区后保存。');
        commit(mergeBundle(p,bundle,'tileParts'),Object.values(bundle.tileParts)[0].layer);d.close();
      }catch(ex){report(ex.message);}
    });change(sets[0]);
  }
  if(OFFICIAL_TILESETS.length)listSets(OFFICIAL_TILESETS);
  else{
    report('可直接裁取本机第 5 章瓦片，或选定瓦片集后导入预设。');
    officialJSON('/a-files/official/maps/ch5/tilesets_meta.json').then(({tilesets})=>listSets(tilesets.filter(s=>s.tile_w===s.tile_h&&s.tile_w>0&&s.columns>0).map(s=>({
      id:s.name,src:'/a-files/official/maps/ch5/tilesets/'+encodeURIComponent(s.name)+'.png',tile:s.tile_w,border:s.border_x,cols:s.columns,rows:Math.floor(s.h/(s.tile_h+2*s.border_y))
    })))).catch(ex=>report(ex.message));
  }
}
function mergeTable(table,additions){
  const result={...table};
  for(const [id,v] of Object.entries(additions??{})){
    if(Object.hasOwn(result,id) && JSON.stringify(result[id])!==JSON.stringify(v))throw Error('同名定义已存在：'+id);
    result[id]=v;
  }
  return result;
}
function mergeBundle(p,bundle,table){
  const definitions={...p[table]};
  for(const [id,original] of Object.entries(bundle[table]??{})){
    let def=original;
    if(table!=='fighters'){
      if(definitions[id]){
        def={...original,sym:definitions[id].sym};
      }else{
        const current={...p,[table]:definitions},enemy=table==='enemyTypes';
        const used=new Set(registry(current.gridParts,current.tileParts,current.enemyTypes).list.map(part=>part.sym));
        if(used.has(original.sym)){
          const sym=enemy?freeSymbol(current,true)[0]:freeSymbol(current,false);
          if(!sym)throw Error('剩余地图符号不足，无法导入整组预设');
          def={...original,sym};
        }
      }
    }
    Object.assign(definitions,mergeTable(definitions,{[id]:def}));
  }
  return {...p,assets:mergeTable(p.assets,bundle.assets),[table]:definitions};
}
export function wireDungeon({project,room,commit,status,changeLayer}){
  const guard=fn=>()=>{try{fn();}catch(ex){status(ex.message,true);}};
  $('dgEnable').onclick=guard(()=>{
    const p=project(),r=room(),key=Object.keys(p.rooms).find(k=>p.rooms[k]===r);
    commit({...p,rooms:{...p.rooms,[key]:{...r,mode:'dungeon',platform:{...PLATFORM_DEFAULTS.dungeon,...r.platform}}}},'collision');
  });
  $('dgLayer').onchange=()=>changeLayer($('dgLayer').value);
  $('dgSolo').onchange=()=>changeLayer($('dgLayer').value);
  $('dgFighter').onchange=guard(()=>{
    const p=project(),r=room(),key=Object.keys(p.rooms).find(k=>p.rooms[k]===r);
    const dungeonConfig={...r.dungeonConfig};if($('dgFighter').value)dungeonConfig.fighter=$('dgFighter').value;else delete dungeonConfig.fighter;
    commit({...p,rooms:{...p.rooms,[key]:{...r,dungeonConfig}}});
  });
  for(const [id,fn] of Object.entries({
    dgTile:()=>tileDialog(project(),room(),commit,false,$('dgLayer').value),
    dgAtlas:()=>tileDialog(project(),room(),commit,true,$('dgLayer').value),
    dgNewFighter:()=>editActor(project(),false,null,commit),
    dgEditFighter:()=>editActor(project(),false,$('dgFighter').value||project().player?.fighter,commit),
    dgNewEnemy:()=>editActor(project(),true,null,commit),dgEditEnemy:()=>editActor(project(),true,$('dgEnemy').value,commit),
    dgKris:()=>{
      const bundle=officialKrisFighter();if(!bundle.fighter)return status('官方 Kris 预设尚未载入，可新建角色并从官方动画库选帧。');
      const p=project(),id=nextId(p.fighters,'kris');
      const next=mergeBundle(p,{assets:bundle.assets,fighters:{[id]:bundle.fighter}},'fighters');
      const r=room();
      if(!(r.dungeonConfig?.fighter??p.player?.fighter)){
        const key=Object.keys(p.rooms).find(k=>p.rooms[k]===r);
        next.rooms={...p.rooms,[key]:{...r,dungeonConfig:{...r.dungeonConfig,fighter:id}}};
      }
      commit(next);
    },
    dgEnemies:()=>{
      const bundle=officialEnemyTypes();if(!Object.keys(bundle.enemyTypes??{}).length)return status('官方敌人预设尚未载入，可先新建敌人类型。');
      commit(mergeBundle(project(),bundle,'enemyTypes'),'objects');
    }
  }))$(id).onclick=guard(fn);
}
export function dungeonControls(p,room,layer){
  $('dgEnable').hidden=!!layer;$('dgPanel').hidden=!layer;if(!layer)return;
  $('dgLayer').value=layer;
  const enemies=$('dgEnemy'),old=enemies.value;
  enemies.replaceChildren(...Object.entries(p.enemyTypes??{}).map(([id,e])=>new Option(e.label??id,id)));
  if(p.enemyTypes?.[old])enemies.value=old;
  $('dgEditEnemy').disabled=!enemies.value;
  $('dgFighter').replaceChildren(new Option(p.player?.fighter?'工程默认 · '+p.player.fighter:'内置 Kris',''),
    ...Object.entries(p.fighters??{}).map(([id,f])=>new Option((f.name??id)+' · '+id,id)));
  $('dgFighter').value=room.dungeonConfig?.fighter??'';
  $('dgEditFighter').disabled=!($('dgFighter').value||p.player?.fighter);
}
export function drawDungeonGrid(ctx,p,room,m,active,solo,repaint){
  const items=[];
  function item(layer,z,depth,draw){
    if(!solo || layer===active)items.push({layer,z,depth,draw});
  }
  function sprite(value,rect,color,actor=false,dir=1){
    const a=animation(value,p.assets),img=frameImage(a.frames[0],repaint);
    if(img){
      if(actor)drawFrame(ctx,a,img,rect.x+rect.w/2,rect.y+rect.h,dir);
      else drawFrame(ctx,a,img,rect.x,rect.y,dir,rect);
    }else{ctx.fillStyle=color;ctx.fillRect(rect.x,rect.y,rect.w,rect.h);}
  }
  for(const o of m.tiles){
    const original=o.tile,part=m.reg.byId[o.part],layer=o.layer;
    const ref=original.sprite??part?.sprite;
    const img=frameImage(animation(ref,p.assets).frames[0],repaint);
    const t={...original,w:original.w??(part?o.cw*m.size:img?.naturalWidth??m.size),
      h:original.h??(part?o.ch*m.size:img?.naturalHeight??m.size)};
    item(layer,{back:0,actor:2,front:3}[layer],t.y+t.h+(t.depth??part?.depth??0),()=>{
      sprite(ref,t,part?.color??'#70607d');
      if(layer==='front'){
        ctx.strokeStyle='#e8acff';ctx.setLineDash([3,3]);ctx.strokeRect(t.x+.5,t.y+.5,t.w-1,t.h-1);ctx.setLineDash([]);
      }
    });
  }
  for(const o of [...m.objects,...m.locked]){
    const e=o.entity,part=m.reg.byId[o.part],b={x:e.x,y:e.y,w:e.w??m.size,h:e.h??m.size};
    const type=p.enemyTypes?.[e.enemyType],enemy=e.kind==='actionEnemy';
    const anim=(e.anims??type?.anims)?.idle??e.sprite??part?.thumbnail??part?.sprite;
    item('objects',2,b.y+b.h,()=>{sprite(anim,b,part?.color??type?.color??'#9a8faa',enemy,e.dir??1);
      ctx.fillStyle='#151320';ctx.fillRect(b.x,b.y,10,11);ctx.fillStyle='#fff';ctx.fillText(part?.sym??'?',b.x+2,b.y+9);});
  }
  const f=p.fighters?.[room.dungeonConfig?.fighter??p.player?.fighter];
  for(const en of Object.values(room.entries??{}))item('objects',2,en.y,()=>{
    const a=animation(f?.anims?.idle,p.assets);
    drawFrame(ctx,a,frameImage(a.frames[0],repaint),en.x,en.y,en.face==='left'?-1:1);
    ctx.fillStyle='#a3f2ba';ctx.fillText('@',en.x-4,en.y);
  });
  item('collision',1,0,()=>{
    const g=m.size;
    for(let r=0;r<m.rows;r++)for(let c=0;c<m.cols;c++){
      const part=m.reg.bySym[m.terrain[r][c]];if(!part)continue;
      ctx.fillStyle=part.color;ctx.fillRect(c*g,r*g,g,part.id==='oneway'?3:g);
    }
  });
  ctx.save();ctx.font='bold 10px monospace';ctx.imageSmoothingEnabled=false;
  for(const i of items.sort((a,b)=>a.z-b.z||a.depth-b.depth)){ctx.globalAlpha=i.layer===active?1:.38;i.draw();}
  ctx.restore();
}
