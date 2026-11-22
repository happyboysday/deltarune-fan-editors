
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {validateBattleBindings} from '../studio/format.mjs';
import {connectParty,initialParty,isSharedBattle} from '../studio/campaign.mjs';

const [battleRoot,workspace,library=path.join(battleRoot,'works')]=process.argv.slice(2);
function fail(issues){
  process.stdout.write(JSON.stringify({ok:false,error:'战斗引用无法加载',issues}));
  process.exitCode=1;
}
function checkContinuity(project,ref,doc){
  if(!isSharedBattle(project,ref))return;
  const roster=initialParty(project);
  for(const [map,list,prefix] of [[ref.partyMap,doc.party??[],'party'],[ref.itemMap,doc.items??[],'item']]){
    const ids=new Set(list.map((x,i)=>x.id??prefix+i));
    for(const key of Object.keys(map??{}))if(!ids.has(key))throw new Error('遭遇没有这个 '+prefix+' ID：'+key);
  }
  connectParty(project,ref,doc,roster,{});
}
async function main(){
  const {battles,offline,checkOnly,campaign,battleTransition}=JSON.parse(fs.readFileSync(0,'utf8'));
  const issues=validateBattleBindings(battles);
  if(issues.length){fail(issues);return;}
  const byId=Object.create(null),entries=[],cached=new Map(),notices=[];
  let imports={},bytes=0;
  if(!Object.keys(battles??{}).length){console.log(JSON.stringify({byId,entries,imports}));return;}
  const m=relative=>import(pathToFileURL(path.join(battleRoot,relative)).href);
  const [exporter,{createEncounter,validateEncounter},{validateAttack}]=await Promise.all([m('tools/export-game.mjs'),m('engine/encounter/index.js'),m('engine/attack.js')]);
  let bundle=exporter.exportSceneBundle;
  if(typeof bundle!=='function'){
    // Older scene-capable releases expose the same bundle through exportGame.
    const probe=createEncounter({externalInput:true});
    try{
      if(!['partyState','entryPositions','drawEntry'].every(name=>typeof probe[name]==='function'))
        throw new Error('此战斗编辑器缺少场景联动接口。请将 --battle-root 指向当前整合版。');
    }finally{probe.destroy();}
    bundle=options=>exporter.exportGame({...options,bundleOnly:true});
  }
  const entryAudio=Object.values(battles).some(r=>(r.transition?.style??battleTransition?.style??'classic')==='classic'&&(r.transition?.sound??battleTransition?.sound??true));
  for(const [id,ref] of Object.entries(battles)){
    const sampleOnly=ref.source==='sample',lang=ref.lang??'zh';
    const key=JSON.stringify([ref.source??'workspace',ref.work??null,ref.encounter,lang]);
    try{
      let works=workspace;
      if(ref.source==='project'){
        const root=fs.realpathSync(library);
        const dir=path.join(root,ref.work);
        if(!fs.statSync(dir,{throwIfNoEntry:false})?.isDirectory())throw new Error('找不到战斗作品目录：'+ref.work);
        works=fs.realpathSync(dir);
        const rel=path.relative(root,works);
        if(!rel||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw new Error('作品目录不在战斗作品库中。');
      }
      const folder=sampleOnly?path.join(battleRoot,'samples','encounters'):path.join(works,'encounters');
      const file=path.join(folder,ref.encounter+'.json');
      if(cached.has(key)){
        const index=cached.get(key);
        checkContinuity({campaign},ref,entries[index].doc);
        byId[id]=index;continue;
      }
      if(!fs.statSync(file,{throwIfNoEntry:false})?.isFile())throw new Error('找不到'+(sampleOnly?'样例':'工作区')+'遭遇 '+ref.encounter+'。请先在战斗编辑器保存或检查引用。');
      const resolved=fs.realpathSync(file);
      const relative=path.relative(fs.realpathSync(folder),resolved);
      if(relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error('遭遇文件指向工作区以外。');
      const {config,assets,imports:modules,warnings}=bundle({
        name:ref.encounter,kind:'encounter',lang,root:battleRoot,works,sampleOnly,
        autoplayToggle:false,includeModules:offline&&!entries.length,entryAudio,
      });
      const errors=validateEncounter(config.doc);
      for(const [name,attack] of Object.entries(config.attacks??{}))
        for(const issue of validateAttack(attack))errors.push({...issue,path:'attacks.'+name+'.'+issue.path});
      if(errors.length){issues.push(...errors.slice(0,10).map(e=>({path:'battles.'+id+'.encounter',message:e.path+'：'+e.message})));continue;}
      checkContinuity({campaign},ref,config.doc);
      if(checkOnly)notices.push(...warnings.map(message=>({path:'battles.'+id+'.encounter',message})));
      if(Object.keys(modules).length)imports=modules;
      const entry={title:config.title,lang,fonts:config.fonts,doc:config.doc,attacks:config.attacks,assets,warnings};
      bytes+=Buffer.byteLength(JSON.stringify(entry));
      if(bytes>128*1024*1024)throw new Error('战斗素材总量超过 128 MiB；请拆分工程。');
      byId[id]=entries.length;cached.set(key,entries.length);entries.push(entry);
    }catch(ex){issues.push({path:'battles.'+id+'.encounter',message:ex.message});}
  }
  if(issues.length){fail(issues);return;}
  process.stdout.write(JSON.stringify(checkOnly?{warnings:notices}:{byId,entries,imports}));
}
main().catch(ex=>fail([{path:'battles',message:ex.message}]));
