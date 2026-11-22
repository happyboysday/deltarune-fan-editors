import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {ROOT,data,pythonCommand,startTestStudio,workDir} from './test-env.mjs';

const scratch=workDir('release-test'),zip=path.join(scratch,'场景编辑器-V1.0.zip');
const app=path.join(scratch,'app'),fontAssets=path.join(scratch,'仅字体'),missing=path.join(scratch,'absent');
function run(command,argv){
  const result=spawnSync(command,argv,{encoding:'utf8',windowsHide:true,timeout:60000});
  assert.equal(result.status,0,result.error?.message||result.stderr);
  console.log(result.stdout.trim());
}
run(process.execPath,[path.join(ROOT,'tools/make-release.mjs'),zip]);
const [exe,...flags]=pythonCommand();
run(exe,[...flags,'-c',`
import hashlib, json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    manifest = json.loads(archive.read("release-manifest.json"))
    assert manifest["version"] == "V1.0"
    assert sorted(archive.namelist()) == sorted(["release-manifest.json"] + [row["file"] for row in manifest["files"]])
    for row in manifest["files"]:
        name = row["file"]
        assert not {".git", ".codex-tmp", "__pycache__"}.intersection(name.split("/")), name
        assert name != "tools/test-env.local.json", name
        contents = archive.read(name)
        assert len(contents) == row["size"] and hashlib.sha256(contents).hexdigest() == row["sha256"], name
    archive.extractall(sys.argv[2])
    print("发布清单与 ZIP 文件一致")
`,zip,app]);

const fontDir=path.join(fontAssets,'fonts','fnt_main');
const localFont=path.join(data.battleAssets,'fonts','fnt_main');
fs.mkdirSync(fontDir,{recursive:true});
if(['glyphs.json','glyphs.png'].every(name=>fs.statSync(path.join(localFont,name),{throwIfNoEntry:false})?.isFile())){
  for(const name of ['glyphs.json','glyphs.png'])fs.copyFileSync(path.join(localFont,name),path.join(fontDir,name));
}else{
  // A one-pixel atlas is enough to exercise font discovery on machines without local assets.
  const atlas='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ/0AAAAASUVORK5CYII=';
  fs.writeFileSync(path.join(fontDir,'glyphs.png'),Buffer.from(atlas,'base64'));
  fs.writeFileSync(path.join(fontDir,'glyphs.json'),JSON.stringify({
    format:'dr-battle-font/1',name:'fnt_main',size:1,lineHeight:1,glyphs:{},
  }));
}
fs.writeFileSync(path.join(fontAssets,'index.json'),JSON.stringify({format:'dr-battle-assets/1',fonts:{
  fnt_main:{image:'fonts/fnt_main/glyphs.png',glyphs:'fonts/fnt_main/glyphs.json'},
}}));

const importApp=rel=>import(pathToFileURL(path.join(app,rel)).href);
const {loadLocalPlugins}=await importApp('tools/plugin-files.mjs');
const {createWorld}=await importApp('studio/world.mjs');
const api='/api/studio/';
for(const fonts of [true,false]){
  const state=path.join(scratch,fonts?'data-fonts':'data-empty');
  const options=['--data',state,'--battle-assets',fonts?fontAssets:missing];
  for(const key of ['assets','official-root','a-export','battle-root','ch6-assets','trailer-root','chapters']){
    options.push('--'+key,missing);
  }
  const env={...process.env,TMP:scratch,TEMP:scratch,TMPDIR:scratch,DIRECTOR_GAME:missing,DIRECTOR_UTMT:missing};
  const server=await startTestStudio(options,path.join(app,'studio_server.py'),true,{cwd:app,env});
  try{
    async function request(route,status=200,body){
      const response=await fetch(server.origin+route,body===undefined?undefined:{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
      });
      assert.equal(response.status,status,route);
      assert.match(response.headers.get('server'),/^DeltaruneSceneStudio\/1\.0\b/);
      return response;
    }
    for(const [route,title,entry] of [['/','场景编辑器 V1.0','editor.mjs'],
      ['/studio/settings.html','设置 · 场景编辑器 V1.0','settings.mjs'],
      ['/studio/plugins.html','插件管理 · 场景编辑器 V1.0','plugin-manager.mjs']]){
      const html=await (await request(route)).text();
      assert.ok(html.includes(title)&&html.includes('/studio/'+entry),route);
      assert.match((await request('/studio/'+entry)).headers.get('content-type'),/javascript/);
    }
    const settings=await (await request(api+'settings')).json();
    assert.equal(settings.firstRunDone,false);
    assert.equal(settings.settings.battleAssets.valid,fonts);
    assert.equal((await (await request(api+'settings',200,{settings:{firstRunDone:true}})).json()).ok,true);
    const {capabilities:c}=await (await request(api+'capabilities')).json();
    for(const key of ['battle','battleAssets','uiAssets','uiSprites','roomImport','officialAssets','officialArt',
      'officialHints','chapter5','chapter5Layouts','chapters','chapterPlay4','chapterPlay5','chapterBuild4',
      'chapterBuild5','dungeonExample','layout','trailer','ch6Assets']){
      assert.equal(c[key].available,false,key);
      assert.ok(c[key].missingSettings.length>0&&c[key].reason!=='可用',key);
    }
    assert.deepEqual(c.uiAssets.missingSettings,fonts?['assets']:['battleAssets','assets']);
    assert.equal(c.uiFonts.available,fonts);
    assert.deepEqual(c.uiFonts.missingSettings,fonts?[]:['battleAssets']);
    for(const key of ['projects','projectSave','plugins','pluginInstall'])assert.equal(c[key].available,true,key);
    assert.deepEqual(c.chapters.chapters,{'4':false,'5':false});
    assert.equal(c.chapters.realGame,false);
    const atlas=await request('/ui-assets/fonts/fnt_main/glyphs.png',fonts?200:404);
    if(fonts)assert.deepEqual(Buffer.from(await atlas.arrayBuffer()),fs.readFileSync(path.join(fontDir,'glyphs.png')));
    assert.equal((await (await request(api+'example')).json()).title,'回声工坊');

    const folder=path.join(app,'examples/plugins/fireflies');
    assert.deepEqual(await (await request(api+'plugins/install',201,{folder})).json(),{ok:true,id:'fireflies',enabled:true});
    const {plugins}=await (await request(api+'plugins')).json();
    for(const id of ['dungeon','kart','fireflies']){
      const entry=plugins.find(plugin=>plugin.manifest?.id===id);
      assert.ok(entry?.enabled,id);
      assert.deepEqual(entry.errors,[],id);
    }
    const base='/plugins/fireflies/';
    for(const name of ['runtime.mjs','editor.mjs','art.mjs'])
      assert.match((await request(base+name)).headers.get('content-type'),/javascript/);
    const demo=await (await request(base+'demo.scene.json')).json();
    await loadLocalPlugins(demo,path.join(state,'plugins'));
    const world=createWorld(demo,{autoplay:true});
    for(let i=0;i<180;i++)world.step();
    assert.equal(world.state.flags.gardenLit,true);
    console.log((fonts?'只有字体素材':'没有素材')+'：首页、设置、插件管理、萤火小径与能力报告通过');
  }finally{await server.close();}
}
