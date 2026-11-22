import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {ROOT,requireData,startStudioServer,workDir} from './test-env.mjs';
import {projectArtSources} from '../studio/resources.mjs';

export async function verifyExports(browser){
  const scratch=workDir('plugin-export'),directory=path.join(scratch,'plugins');
  fs.cpSync(path.join(ROOT,'examples/plugins'),directory,{recursive:true});
  const sample=path.join(directory,'fireflies');
  fs.appendFileSync(path.join(sample,'runtime.mjs'),"\nimport /* offline test */ './export-check.mjs';\n");
  fs.writeFileSync(path.join(sample,'export-check.mjs'),"export /* offline test */ {drawLight} from './art.mjs';\n");
  const files=[path.join(directory,'fireflies/demo.scene.json')];
  fs.mkdirSync(path.join(scratch,'scenes'));
  for(const clip of ['03_sunlit_dungeon_action','04_mario_kart_lancer']){
    const name=clip+'.scene.json',copy=path.join(scratch,'scenes',name);
    fs.copyFileSync(requireData('trailerRoot/scenes/'+name)[0],copy);files.push(copy);
    const sources=projectArtSources(JSON.parse(fs.readFileSync(copy)));
    for(const src of sources)if(src.startsWith('/ch6-trailer-assets/')){
      const asset='assets/'+src.slice('/ch6-trailer-assets/'.length),dest=path.join(scratch,asset);
      fs.mkdirSync(path.dirname(dest),{recursive:true});
      fs.copyFileSync(requireData('trailerRoot/'+asset)[0],dest);
    }
  }
  const server=await startStudioServer({plugins:directory,trailerRoot:scratch});
  function node(args){
    const r=spawnSync(process.execPath,args,{encoding:'utf8',windowsHide:true,timeout:95000});
    assert.equal(r.status,0,r.stderr||r.error?.message);console.log(r.stdout.trim());
  }
  try{
    const {origin}=server;
    const catalog=await (await fetch(origin+'/api/studio/plugins')).json();
    assert.ok(catalog.plugins.some(e=>e.manifest?.id==='fireflies'&&!e.errors.length));
    const url=origin+'/plugins/fireflies/runtime.mjs';
    const head=await fetch(url,{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
    assert.equal((await fetch(origin+'/plugins/fireflies/missing.mjs')).status,404);
    const demo=await (await fetch(origin+'/plugins/fireflies/demo.scene.json')).json();
    const save=await fetch(origin+'/api/studio/projects/fireflies-demo',{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({project:demo,revision:null})});
    assert.equal(save.status,200,await save.text());
    const exports=[];
    for(const file of files){
      const out=path.join(scratch,path.basename(file,'.scene.json')+'.html');
      node(['tools/export-example.mjs',origin,file,out,'--plugins',directory]);
      node(['--experimental-vm-modules','tools/check-plugin-html.mjs',out]);exports.push(out);
    }
    if(browser)await browser(origin,exports,scratch);
  }finally{await server.close();}
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)await verifyExports();
