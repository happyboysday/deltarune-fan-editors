import {spawn,spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

export const ROOT=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
export const SCRATCH=path.join(ROOT,'.codex-tmp');
const configFile=path.join(ROOT,'tools/test-env.local.json');
const settings={
  assets:['--assets','SCENE_ASSETS',()=>ROOT],
  battleRoot:['--battle-root','DR_BATTLE_ROOT',()=>path.resolve(ROOT,'../../battle-editor')],
  base:['--base','DR_V04_BASE',()=>path.resolve(ROOT,'../deltarune-director-v0.4')],
  aExport:['--a-export','DR_A_EXPORT',d=>{
    const portable=path.join(d.assets,'a-export');
    return fs.existsSync(portable)?portable:path.join(d.base,'management/agents/A-assets/exports/v8');
  }],
  battleAssets:['--battle-assets','DR_ASSETS',d=>path.join(d.battleRoot,'assets')],
  officialRoot:['--official-root','DR_OFFICIAL_ROOT',d=>{
    const workbenchAssets=path.join(d.base,'management/assets/official');
    return fs.existsSync(workbenchAssets)?workbenchAssets:path.resolve(ROOT,'../../assets-official/01-official');
  }],
  ch6Assets:['--ch6-assets','DR_CH6_ASSETS',()=>path.resolve(ROOT,'../../ch6-assets')],
  projects:['--projects','DR_PROJECTS',()=>path.join(ROOT,'projects')],
  trailerRoot:['--trailer-root','DR_TRAILER_ROOT',()=>path.resolve(ROOT,'../../ch6-trailer-project')],
  chapters:['--chapters','DR_CHAPTERS',d=>path.join(d.assets,'chapters')],
};
const byFlag=new Map(Object.entries(settings).map(([name,[flag]])=>[flag,name]));

export function resolveTestEnv(argv=process.argv.slice(2),env=process.env){
  const cli={},args=[],forward=[];
  for(let i=0;i<argv.length;i++){
    const token=argv[i];
    if(token==='--'){args.push(...argv.slice(i));break;}
    const [flag]=token.split('=',1),name=byFlag.get(flag);
    if(!name){args.push(token);continue;}
    const value=token===flag?argv[++i]:token.slice(flag.length+1);
    if(!value||value.startsWith('--'))throw Error(`${flag} 需要目录路径`);
    cli[name]=path.resolve(value);
    forward.push(flag,cli[name]);
  }
  const local=fs.existsSync(configFile)?JSON.parse(fs.readFileSync(configFile,'utf8').replace(/^\uFEFF/,'')):{};
  const data={};
  for(const [name,[,variable,fallback]] of Object.entries(settings)){
    data[name]=cli[name]??(env[variable]?path.resolve(env[variable]):
      local[name]?path.resolve(ROOT,local[name]):fallback(data));
  }
  return {data,args,forward};
}

export const {data,args,forward}=resolveTestEnv();

export class Skip extends Error{
  constructor(reason){super(reason);this.name='SKIP';}
}

process.on('uncaughtExceptionMonitor',error=>{
  if(error instanceof Skip){
    fs.writeSync(1,`SKIP: ${error.message}\n`);
    process.exit(77);
  }
});

export function requireData(...names){
  const missing=[],paths=names.map(spec=>{
    const [name,...parts]=spec.split('/');
    if(!Object.hasOwn(data,name))throw Error(`未知测试数据项 ${name}`);
    const file=path.join(data[name],...parts);
    if(!fs.existsSync(file)||(!parts.length&&!fs.statSync(file).isDirectory()))missing.push(`${spec}（${file}）`);
    return file;
  });
  if(missing.length)throw new Skip('缺少测试数据 '+missing.join('、'));
  return paths;
}

export function requirePath(file,label){
  if(!fs.existsSync(file))throw new Skip(`缺少测试数据 ${label}（${file}）`);
  return file;
}

export function workDir(prefix){
  fs.mkdirSync(SCRATCH,{recursive:true});
  return fs.mkdtempSync(path.join(SCRATCH,prefix+'-'));
}

export function copyProjects(){
  const [source]=requireData('projects');
  const projects=path.join(workDir('studio-test'),'projects');
  fs.cpSync(source,projects,{recursive:true,dereference:true});
  return projects;
}

export function testProcessEnv(){
  fs.mkdirSync(SCRATCH,{recursive:true});
  const env={...process.env,TMP:SCRATCH,TEMP:SCRATCH,TMPDIR:SCRATCH};
  for(const [name,[,variable]] of Object.entries(settings))env[variable]=data[name];
  const official=path.resolve(data.officialRoot,'../..');
  for(const [name,relative] of Object.entries({DIRECTOR_GAME:'game/DELTARUNE',
    DIRECTOR_UTMT:'tools-external/utmt/UndertaleModCli.exe'})){
    const file=path.join(official,relative);
    if(!env[name]&&fs.existsSync(file))env[name]=file;
  }
  return env;
}

let python;
export function pythonCommand(){
  if(python)return python;
  const candidates=process.env.PYTHON?[[process.env.PYTHON]]:process.platform==='win32'?
    [['py','-3'],['python'],['python3']]:[['python3'],['python']];
  for(const [exe,...flags] of candidates){
    const probe=spawnSync(exe,[...flags,'-c','import sys; sys.exit(sys.version_info < (3, 11))'],
      {stdio:'ignore',windowsHide:true,timeout:5000});
    if(probe.status===0)return python=[exe,...flags,'-B','-X','utf8'];
  }
  throw new Skip('缺少 Python 3.11 或更新版本，可通过 PYTHON 指定解释器');
}

export function killTree(child,{group=false}={}){
  if(!child.pid)return;
  if(process.platform==='win32'){
    spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true,timeout:5000});
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
  }else{
    try{process.kill(group?-child.pid:child.pid,'SIGKILL');}
    catch(error){if(error.code!=='ESRCH')throw error;}
  }
}

export async function startStudioServer({script=path.join(ROOT,'studio_server.py'),
    base=fs.existsSync(path.join(data.base,'management/agents/C-editor/server.py'))?data.base:null,
    projects=copyProjects(),aExport=data.aExport,options=[],plugins,trailerRoot=data.trailerRoot}={}){
  if(base)requirePath(path.join(base,'management/agents/C-editor/server.py'),'V0.4 布景工作台');
  const argv=Object.entries(settings).flatMap(([name,[flag]])=>name==='base'?(base?[flag,base]:[]):
    name==='aExport'?(aExport?[flag,aExport]:[]):
    [flag,name==='projects'?projects:name==='trailerRoot'?trailerRoot:data[name]]);
  if(plugins)argv.push('--plugins',plugins);
  const server=await startTestStudio([...argv,...options],script);
  try{
    if(script===path.join(ROOT,'studio_server.py')){
      const response=await fetch(server.origin+'/api/studio/settings',{method:'POST',
        headers:{'Content-Type':'application/json'},body:JSON.stringify({settings:{firstRunDone:true}})});
      if(!response.ok||!(await response.json()).ok)throw Error('无法完成隔离测试服务器的启动引导');
    }
    return {...server,projects};
  }catch(error){await server.close();throw error;}
}

export async function startTestStudio(options,script=path.join(ROOT,'studio_server.py'),ephemeral=true,
    {cwd=ROOT,env=testProcessEnv()}={}){
  const [exe,...flags]=pythonCommand();
  const child=spawn(exe,[...flags,script,...(ephemeral?['--port','0']:[]),'--node',process.execPath,...options],
    {cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const exited=new Promise(resolve=>child.once('close',resolve));
  const terminate=()=>{if(child.exitCode===null&&child.signalCode===null)killTree(child);};
  process.once('exit',terminate);
  const close=async()=>{terminate();await exited;process.off('exit',terminate);};
  let stdout='',stderr='';
  child.stdout.setEncoding('utf8').on('data',s=>{stdout=(stdout+s).slice(-8192);});
  child.stderr.setEncoding('utf8').on('data',s=>{stderr=(stderr+s).slice(-8192);});
  try{
    const origin=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>done(Error('测试服务器启动超时')),30000);
      function done(error,result){
        clearTimeout(timer);
        child.stdout.off('data',ready);
        child.off('error',done);
        child.off('close',ended);
        if(error)reject(error);else resolve(result);
      }
      function ready(){
        const match=stdout.match(/DELTARUNE Scene Studio .*? · (http:\/\/127\.0\.0\.1:\d+)\//);
        if(match)done(null,match[1]);
      }
      function ended(code){done(Error(`测试服务器退出（${code}）`));}
      child.on('error',done);
      child.on('close',ended);
      child.stdout.on('data',ready);
      ready();
    });
    return {origin,close,exited,output:()=>stdout};
  }catch(error){
    await close();
    throw Error([error.message,stderr.trim(),stdout.trim()].filter(Boolean).join('\n'));
  }
}

export async function browserRenderer(root=data.battleRoot){
  const script=requirePath(path.join(root,'tools/agent/render.mjs'),'battleRoot/tools/agent/render.mjs');
  const renderer=await import(pathToFileURL(script));
  if(!renderer.findEdge())throw new Skip('缺少 Microsoft Edge，可通过 MSEDGE_PATH 指定');
  return renderer;
}

export async function openBrowserTest(origin,root,options){
  const renderer=await browserRenderer(root);
  const server=origin?null:await startStudioServer();
  try{
    const edge=await renderer.launchEdge({...options,keepProfile:true});
    const close=edge.close.bind(edge);
    edge.close=async()=>{try{await close();}finally{await server?.close();}};
    return {origin:origin??server.origin,edge,CDP:renderer.CDP};
  }catch(error){
    await server?.close();
    throw error;
  }
}
