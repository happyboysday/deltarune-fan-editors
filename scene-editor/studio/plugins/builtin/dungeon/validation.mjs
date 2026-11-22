export function validation({project:p,obj,str,id,num,opt,bool,arr,color,frames,reference,sprite,evt,source,own,record,assets,error,seconds,duration,range,choice,pair,animSettings}){
  const ticks=range(0,3600,true), positiveTicks=range(1,3600,true), speed=range(0,128);
  const distance=range(0,16384), signed=range(-16384,16384), size=range(1,16384);
  const damage=range(0,9999), hp=range(1,9999), cooldown=range(0,3600);
  function fields(value,path,schema,required=[]) {
    if(!obj(value,path))return;
    for(const [field,check] of Object.entries(schema)){
      if(required.includes(field)||own(value,field))check(value[field],path+'.'+field);
    }
  }
  function anim(v,k){
    if(typeof v!=='string'){fields(v,k,{frames,...animSettings},['frames']);return;}
    sprite(v,k);
    const asset=assets[v];
    if(record(asset) && !own(asset,'frames') && !own(asset,'src'))error(k,'横版动画素材需要 src 或 frames');
  }
  const anims=(v,k)=>{if(obj(v,k))for(const [slot,a] of Object.entries(v))anim(a,k+'.'+slot);};
  const box=(v,k)=>fields(v,k,{w:size,h:size},['w','h']);
  const hitbox=(v,k)=>fields(v,k,{x:signed,y:signed,w:size,h:size},['x','y','w','h']);
  const attackSchema={anim,effect:anim,windup:ticks,active:positiveTicks,recovery:ticks,hitbox,damage,lunge:speed,knockback:speed,hitstop:ticks};
  const attack=(v,k)=>fields(v,k,attackSchema,['windup','active','recovery','hitbox','damage']);
  const skillTypes={
    projectile:[{speed,life:positiveTicks,w:size,h:size,damage,pierce:bool,gravity:signed,count:range(1,128,true),spread:range(0,360)},['speed','life','w','h','damage']],
    area:[{x:signed,y:signed,w:size,h:size,damage,ticks:positiveTicks,knockback:speed},['x','y','w','h','damage','ticks']],
    parry:[{radius:size,window:positiveTicks,reflect:bool,stun:ticks},['radius','window']],
    dash:[{speed,ticks:positiveTicks,damage,invulnerable:ticks},['speed','ticks','damage']],
    heal:[{amount:hp},['amount']]
  };
  function skills(v,k){
    if(!arr(v,k,4))return;
    const ids=new Set(),inputs=new Set();
    v.forEach((s,i)=>{
      const q=k+'.'+i;
      if(!obj(s,q))return;
      fields(s,q,{id,name:str,input:choice('skill1','skill2','skill3','skill4'),type:choice(...Object.keys(skillTypes)),
        anim,sprite:anim,sound:str,cooldown,cast:ticks},['id','name','input','type','cooldown','cast']);
      for(const [f,seen] of [['id',ids],['input',inputs]]){
        if(seen.has(s[f]))error(q+'.'+f,'技能 ID 或按键重复');
        seen.add(s[f]);
      }
      if(typeof s.type==='string' && own(skillTypes,s.type))fields(s[s.type],q+'.'+s.type,...skillTypes[s.type]);
    });
  }
  function declarations(name,check){
    opt(p,name,'$',(table,k)=>{if(obj(table,k))for(const [key,value] of Object.entries(table)){
      const q=name+'.'+key;id(key,q);if(obj(value,q))check(value,q);
    }});
  }
  const fighterRef=(v,k)=>reference(p.fighters??{},v,k,'角色');
  declarations('fighters',(f,k)=>fields(f,k,{name:str,hp,box,walkSpeed:speed,runSpeed:speed,jump:speed,anims,
    attacks:(v,q)=>{if(arr(v,q))v.forEach((a,i)=>attack(a,q+'.'+i));},airAttack:attack,comboWindow:ticks,
    dodge:(v,q)=>fields(v,q,{anim,ticks:positiveTicks,speed,invulnerable:ticks,cooldown,afterimages:bool},['ticks','speed','invulnerable','cooldown']),skills}));
  const tileSymbols=new Set(),enemySymbols=new Set([...('#-~=@NEDBSCPOZK'),...Object.values(p.gridParts??{}).map(g=>g?.sym)]);
  const symbol=(regex,used)=>(v,q)=>{
    if(typeof v!=='string'||!regex.test(v))error(q,'符号格式错误，应符合 '+regex.source);
    else if(used.has(v))error(q,'符号已占用：'+v);
    else used.add(v);
  };
  const partFields={label:str,color,cells:pair(range(1,64,true))};
  const layer=choice('back','actor','front'),depth=range(-480,480);
  declarations('tileParts',(t,k)=>fields(t,k,{...partFields,sym:symbol(/^[a-z0-9]$/,tileSymbols),sprite,layer,depth,
    solid:choice('none','solid','oneway')},['sym','cells','layer']));
  const enemyFields={hp,damage,contact:bool,box,ai:choice('patrol','chase','turret','flyer'),speed,aggroRange:distance,gravity:bool,anims,onDefeat:evt,
    melee:(v,q)=>fields(v,q,{range:distance,windup:ticks,active:positiveTicks,recovery:ticks,hitbox,damage},['range','windup','active','recovery','hitbox','damage']),
    shoot:(v,q)=>fields(v,q,{interval:range(.001,3600),delay:cooldown,speed,count:range(1,128,true),spread:range(0,360),range:distance,sprite:anim,color},['interval','speed'])};
  declarations('enemyTypes',(e,k)=>fields(e,k,{...partFields,...enemyFields,sym:symbol(/^[A-Z]$/,enemySymbols)},['sym','cells','ai']));

  if(record(p.player))opt(p.player,'fighter','$.player',fighterRef);
  return {
    room({room:r,path}){
      opt(r,'dungeonConfig',path,(c,k)=>{if(obj(c,k)){
        opt(c,'fighter',k,fighterRef);
        opt(c,'hud',k,(v,l)=>{if(v!==false&&!['top','bottom'].includes(v))error(l,'可选：top、bottom 或 false');});
        opt(c,'maxHp',k,(v,q)=>num(v,q,1,999,true));
        opt(c,'dashSpeed',k,(v,q)=>num(v,q,1,40));
        for(const field of ['waveCooldown','parryCooldown'])opt(c,field,k,duration);
        for(const field of ['waveSprite','parrySprite'])opt(c,field,k,source);
        for(const [field,check] of [['slashSprites',source],['slashArt',sprite]])opt(c,field,k,(v,q)=>{
          if(arr(v,q,3))v.forEach((ref,i)=>{if(ref!==null)check(ref,q+'.'+i);});
        });
      }});
    },
    enemy({value:e,path:k,room:r}){
      if(e.enemyType!==undefined){reference(p.enemyTypes??{},e.enemyType,k+'.enemyType','敌人类型');fields(e,k,enemyFields);}
      opt(e,'hp',k,(v,l)=>num(v,l,1,999,true));
      opt(e,'damage',k,(v,l)=>num(v,l,1,999,true));
      opt(e,'patrolSpeed',k,(v,l)=>num(v,l,0,8));
      opt(e,'patrol',k,(v,l)=>{
        if(!Array.isArray(v)||v.length!==2){error(l,'应为 [最左 X, 最右 X]');return;}
        if(num(v[0],l+'.0',0,r.w-(e.w??20)))num(v[1],l+'.1',v[0],r.w-(e.w??20));
      });
      for(const f of ['shotDelay','shotInterval'])opt(e,f,k,seconds);
      opt(e,'fireRange',k,(v,l)=>num(v,l,1,2048));
      opt(e,'bulletSpeed',k,(v,l)=>num(v,l,.2,32));
      opt(e,'bulletColor',k,color);
      opt(e,'shots',k,(v,l)=>num(v,l,1,5,true));opt(e,'onDefeat',k,evt);
    }
  };
}
