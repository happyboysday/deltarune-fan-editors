import {loadLocalPlugins} from './plugin-files.mjs';
import fs from 'node:fs';
import {validateProject,INPUTS,BATTLE_RESULTS,FORMAT,PLATFORM_DEFAULTS} from '../studio/format.mjs';
import {createWorld} from '../studio/world.mjs';
import {registry,toText,fromText,writeGrid,projectIds,roomFromText,legend,gridSize,GridTextError,DEFAULT_SIZE} from '../studio/grid.mjs';

const USAGE = `用法（在场景编辑器目录下）：
  node tools/scene.mjs validate PROJECT.json
  node tools/scene.mjs replay PROJECT.json STEPS.json

逐格编辑（文字地图，一格一个字符）：
  node tools/scene.mjs parts [PROJECT.json]                    列出零件和符号（含工程的自定义零件）
  node tools/scene.mjs grid show PROJECT.json [ROOM]           打印房间的文字地图（默认起始房间）
  node tools/scene.mjs grid apply PROJECT.json ROOM MAP.txt    按文字地图改房间
  node tools/scene.mjs grid new PROJECT.json ROOM MAP.txt [--size 20] [--title 名称]
                                                               用文字地图新建房间
  node tools/scene.mjs init OUT.json MAP.txt [--title 标题] [--size 20]
                                                               用一张文字地图新建整个工程
  node tools/scene.mjs dungeon init PROJECT.json ROOM [--cols 32 --rows 24 --size 20]\n  grid show / apply 可加 --layer collision|back|actor|front|objects\napply / new 默认只检查、不写文件；加 --write 写回原文件，或用 --out 新文件.json 另存。
读取含第三方插件的工程时，可加 --plugins 插件目录。
MAP.txt 写 - 表示从标准输入读取。`;

function read(f){return JSON.parse(fs.readFileSync(f==='-'?0:f,'utf8').replace(/^﻿/,''));}
function text(f){return fs.readFileSync(f==='-'?0:f,'utf8');}
function keys(v){return v===undefined||Array.isArray(v)&&v.every(k=>INPUTS.includes(k));}
function flags(list){
  const out={_:[]};
  for(let i=0;i<list.length;i++){
    const a=list[i];
    if(a==='--write')out.write=true;
    else if(['--out','--size','--title','--cols','--rows','--layer'].includes(a)){
      if(!list[i+1] || list[i+1].startsWith('--'))throw new GridTextError(a+' 缺少值');
      out[a.slice(2)]=list[++i];
    }
    else out._.push(a);
  }
  return out;
}
function report(result){
  for(const e of result.errors)console.error('错误 · '+e.path+' · '+e.message);
  for(const w of result.warnings)console.error('提醒 · '+w.path+' · '+w.message);
}
function save(p,file,opts){
  const result=validateProject(p);
  report(result);
  if(!result.ok){console.error('校验没有通过，没有写文件。');process.exitCode=1;return false;}
  const target=opts.out??(opts.write?file:null);
  if(target){fs.writeFileSync(target,JSON.stringify(p,null,2)+'\n');console.error('已写入 '+target);}
  else console.error('检查通过（没有写文件；加 --write 写回，或 --out 另存）。');
  return true;
}
function summary(before,after){
  const count=r=>{const m={};for(const e of r?.entities??[])m[e.kind]=(m[e.kind]??0)+1;return m;};
  const a=count(before),b=count(after);
  const kinds=[...new Set([...Object.keys(a),...Object.keys(b)])].sort();
  console.error('物件数量：'+kinds.map(k=>k+' '+(a[k]??0)+'→'+(b[k]??0)).join('，')+'；入口 '+Object.keys(before?.entries??{}).length+'→'+Object.keys(after.entries).length);
}
function size(opts){
  const n=opts.size===undefined?DEFAULT_SIZE:Number(opts.size);
  if(!Number.isInteger(n)||n<8||n>64)throw new GridTextError('--size 应为 8–64 的整数');
  return n;
}

const [cmd,...rest]=process.argv.slice(2);
try{
  let directory=process.env.DR_PLUGINS;
  const index=rest.indexOf('--plugins');
  if(index!==-1){
    directory=rest[index+1];
    if(!directory||directory.startsWith('--'))throw Error('--plugins 需要插件目录');
    rest.splice(index,2);
  }
  async function readProject(file){
    const project=read(file);
    await loadLocalPlugins(project,directory,process.env.SCENE_STUDIO_DISABLED_PLUGINS?.split(','));
    return project;
  }
  if(cmd==='parts'){
    const project=rest[0]?await readProject(rest[0]):null;
    console.log(legend(project?.gridParts,project).join('\n'));
    console.log('\n符号  零件        写回成的实体');
    for(const p of registry(project?.gridParts,project?.tileParts,project?.enemyTypes).list)console.log(`${p.sym}     ${p.label.padEnd(8,'　')}  ${p.entry?'入口（rooms.X.entries）':(p.tileKey?'room.tiles · '+p.layer:p.kind)+(p.sprite?' 素材 '+p.sprite:'')+(p.props?' '+JSON.stringify(p.props):'')}${p.cells?' · 默认 '+p.cells.join('×')+' 格':''}${p.tip?' · '+p.tip:''}`);
  }else if(cmd==='grid'){
    const opts=flags(rest),[sub,file,room,map]=opts._;
    if(!['show','apply','new'].includes(sub)||!file)throw new GridTextError(USAGE);
    const p=await readProject(file);
    if(sub==='show'){
      const key=room??p.start?.room;
      if(!p.rooms?.[key])throw new GridTextError('没有房间 '+key+'。可用：'+Object.keys(p.rooms??{}).join('、'));
      process.stdout.write(toText(p.rooms[key],key,{project:p,layer:opts.layer}));
    }else{
      if(!room||!map)throw new GridTextError(USAGE);
      const o=opts;
      if(sub==='apply'){
        const r=p.rooms?.[room];
        if(!r)throw new GridTextError('没有房间 '+room+'。新房间请用 grid new');
        const out=writeGrid(r,fromText(r,text(map),{project:p,layer:opts.layer}),projectIds(p),{radius:p.player?.radius??6});
        summary(r,out);
        save({...p,rooms:{...p.rooms,[room]:out}},file,o);
      }else{
        if(p.rooms?.[room])throw new GridTextError('房间 '+room+' 已存在；修改请用 grid apply');
        const r=roomFromText(text(map),{size:size(o),title:o.title??room,taken:projectIds(p),radius:p.player?.radius??6,project:p});
        summary(null,r);
        save({...p,rooms:{...p.rooms,[room]:r}},file,o);
      }
    }
  }else if(cmd==='dungeon'){
    const opts=flags(rest),[sub,file,key]=opts._;
    if(sub!=='init'||!file||!key)throw new GridTextError(USAGE);
    const p=await readProject(file),g=size(opts),cols=Number(opts.cols??32),rows=Number(opts.rows??24);
    if(![cols,rows].every(n=>Number.isSafeInteger(n)&&n>=3&&n*g>=64&&n*g<=32768) || cols*rows>1000000)
      throw new GridTextError('行列数应为整数，房间至少 3×3 格、64×64 像素，最多一百万格');
    const lines=Array.from({length:rows},(_,r)=>r===rows-1?'#'.repeat(cols):'#'+'.'.repeat(cols-2)+'#');
    lines[rows-2]='#@'+'.'.repeat(cols-3)+'#';
    const old=p.rooms[key], room=roomFromText(lines.join('\n'),{size:g,title:old?.title??key,taken:projectIds(p)});
    const entry=Object.values(room.entries)[0];
    if(old?.entries) room.entries=Object.fromEntries(Object.keys(old.entries).map(k=>[k,{...old.entries[k],...entry}]));
    room.mode='dungeon';room.platform={...PLATFORM_DEFAULTS.dungeon};
    save({...p,rooms:{...p.rooms,[key]:room}},file,opts);
  }else if(cmd==='init'){
    const opts=flags(rest),[out,map]=opts._;
    if(!out||!map)throw new GridTextError(USAGE);
    if(fs.existsSync(out))throw new GridTextError(out+' 已存在，不覆盖');
    const room=roomFromText(text(map),{size:size(opts),title:opts.title??'第一个房间'});
    const p={format:FORMAT,title:opts.title??'新场景',viewport:{w:480,h:300},
      start:{room:'room_1',entry:Object.keys(room.entries)[0]},rooms:{room_1:room},events:{},assets:{}};
    summary(null,room);
    save(p,out,{out});
  }else if(cmd==='validate'||cmd==='replay'){
    const [file,steps]=rest;
    if(!file)throw new GridTextError(USAGE);
    const p=await readProject(file);
    const result=validateProject(p);
    if(cmd==='validate'||!result.ok){
      console.log(JSON.stringify(result,null,2));process.exitCode=result.ok?0:1;
    }else{
      const log=read(steps),world=createWorld(p,{validated:true}),checkpoints=[];
      let total=0;
      if(!Array.isArray(log))throw new Error('Replay should be a JSON array.');
      for(const [i,seg] of log.entries()){
        if(!seg||!Number.isInteger(seg.n??1)||(seg.n??1)<1||seg.n>108000||!keys(seg.hold)||!keys(seg.press))
          throw new Error('Replay step '+i+': expected {n, hold?, press?, mark?}.');
        total+=seg.n??1;
        if(total>216000)throw new Error('Replay limit: 216000 ticks.');
        for(let k=0;k<(seg.n??1);k++)world.step({hold:seg.hold,press:k===0?seg.press:undefined});
        if(seg.battleResult!==undefined){
          const request=world.state.battle;
          if(!request||!BATTLE_RESULTS.includes(seg.battleResult)||seg.battle!==undefined&&seg.battle!==request.id)
            throw new Error('Replay step '+i+': battleResult must match the pending battle and a supported outcome.');
          world.completeBattle(request.serial,{result:seg.battleResult});
        }
        if(seg.mark)checkpoints.push({mark:seg.mark,tick:world.state.tick,room:world.state.room,
          flags:{...world.state.flags},inventory:{...world.state.inventory},mode:world.state.mode});
      }
      console.log(JSON.stringify({checkpoints,state:world.state,entities:world.entities()},null,2));
    }
  }else{
    process.stderr.write(USAGE+'\n');process.exitCode=2;
  }
}catch(ex){
  if(cmd==='validate')console.log(JSON.stringify({ok:false,errors:[{path:'$',message:ex.message}],warnings:[]},null,2));
  else console.error(ex instanceof GridTextError?ex.message:ex.message);
  process.exitCode=ex instanceof GridTextError&&ex.message===USAGE?2:1;
}
