// Execute only modules found inside the exported HTML, in a fresh realm.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const [file]=process.argv.slice(2),html=fs.readFileSync(file,'utf8');
const imports=JSON.parse(html.match(/<script type="importmap">([^<]+)<\/script>/)[1]).imports;
const [project,pack]=JSON.parse(html.match(/id="scene-data" type="application\/json">([^<]+)<\/script>/)[1]);
const context=vm.createContext({console,structuredClone});
const modules=new Map();
function lookup(key){
  assert.ok(Object.hasOwn(imports,key),'离线导入未解析 '+key);
  if(!modules.has(key)){
    const url=imports[key];assert.ok(url.startsWith('data:text/javascript'));
    modules.set(key,new vm.SourceTextModule(decodeURIComponent(url.slice(url.indexOf(',')+1)),{context,identifier:key}));
  }
  return modules.get(key);
}
const entry=html.match(/<script type="module">\s*import \{offlinePlayer\} from "([^"]+)"/)[1];
const main=lookup(entry);await main.link(lookup);await main.evaluate();
assert.equal(typeof main.namespace.offlinePlayer,'function');
const art=lookup('scene/resources').namespace.projectArtSources(project);
for(const url of art)assert.ok(url.startsWith('data:image/')||pack.files[url]?.startsWith('data:image/'),'素材未内嵌 '+url);
const w=lookup('scene/world').namespace.createWorld(project,{autoplay:true});
for(let i=0;i<1000;i++)w.step();
assert.equal(w.state.tick,1000);
assert.ok(w.trailerStatus()?.done);
if(project.id==='fireflies-demo'){
  assert.equal(w.state.flags.gardenLit,true);
  assert.ok(!Object.keys(imports).some(s=>s.endsWith('/simulation')));
}
console.log(project.title+' · 离线模块 '+modules.size+'，内嵌场景素材 '+art.size+'，运行至 tick 1000');
