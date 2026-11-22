import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {ROOT,SCRATCH,args,forward,killTree,pythonCommand,Skip,testProcessEnv,workDir} from './test-env.mjs';

const tests=[
  ['audit-chapter5.mjs','快速',60],
  ['test-ch6-navigator.mjs','快速',60],
  ['test-ch6-trailer-modes.mjs','快速',60],
  ['test-plugin-parity.mjs','快速',60],
  ['test-plugin-runtime.mjs','快速',60],
  ['test-editor-regressions.mjs','快速',90],
  ['test-service-regressions.py','快速',120],
  ['test-plugin-export.mjs','快速',240],
  ['test-ch6-v3-ideas.mjs','快速',60],
  ['test-native-server.mjs','快速',180],
  ['test-settings.mjs','快速',180],
  ['test-plugin-manager.mjs','快速',120],
  ['test-release.mjs','快速',120],
  ['verify-battle-library.py','快速',240],
  ['verify-battle.mjs','快速',60],
  ['verify-campaign.mjs','快速',60],
  ['verify-chapter5.mjs','快速',60],
  ['verify-cliff-platform.mjs','快速',60],
  ['verify-dungeon.mjs','快速',60],
  ['verify-example.mjs','快速',60],
  ['verify-grid.mjs','快速',60],
  ['verify-scene-navigator.mjs','快速',60],
  ['verify-plugin-browser.mjs','浏览器',240],
  ['verify-battle-browser.mjs','浏览器',240],
  ['verify-campaign-browser.mjs','浏览器',240],
  ['verify-chapter-ui.mjs','浏览器',120],
  ['verify-chapter5-browser.mjs','浏览器',120],
  ['check-native-window.mjs','原生',0,'需要真实游戏和原生窗口'],
  ['verify-chapter-ending.mjs','原生',0,'需要真实游戏和原生窗口'],
  ['verify-chapter-project.py','原生',0,'需要正版游戏文件和 UndertaleModCli'],
  ['verify-navigator-ui.mjs','原生',0,'需要 Edge 和原生游戏窗口'],
  ['verify-navigator-ui.py','原生',0,'需要 Edge 和原生游戏窗口'],
  ['verify-navigator.py','原生',0,'需要真实游戏和原生窗口'],
];

function parseOptions(){
  const options={browser:false,list:false,only:''};
  for(let i=0;i<args.length;i++){
    const flag=args[i];
    if(flag==='--browser')options.browser=true;
    else if(flag==='--list')options.list=true;
    else if(flag==='--only'&&args[i+1]&&!args[i+1].startsWith('--'))options.only=args[++i];
    else throw Error(`参数无效 ${flag}。用法为 node tools/test-all.mjs [--browser] [--only 名称片段] [--list]`);
  }
  return options;
}

function execute(command,argv,timeout,logFile,env){
  const log=fs.openSync(logFile,'w');
  return new Promise((resolve,reject)=>{
    let timedOut=false;
    const group=process.platform!=='win32';
    let child;
    try{
      child=spawn(command,argv,{cwd:ROOT,env,windowsHide:true,detached:group,stdio:['ignore',log,log]});
    }finally{fs.closeSync(log);}
    const kill=()=>killTree(child,{group});
    process.once('exit',killOnExit);
    function killOnExit(){if(child.exitCode===null&&child.signalCode===null)kill();}
    const timer=setTimeout(()=>{timedOut=true;kill();},timeout*1000);
    child.once('error',reject);
    child.once('close',(code,signal)=>{
      clearTimeout(timer);
      process.off('exit',killOnExit);
      resolve({code,signal,timedOut});
    });
  });
}

function failureReason(output,code,signal){
  const lines=output.trim().split(/\r?\n/);
  const line=lines.findLast(l=>/^\w*(?:Error|Exception)(?: \[\w+\])?:/.test(l))||
    lines.findLast(l=>/^\w*(?:Error|Exception)$/.test(l))||
    lines.findLast(l=>l.startsWith('✗'))||lines.at(-1);
  const assertion=line==='AssertionError'?lines.findLast(l=>/^\s+assert\s/.test(l))?.trim():null;
  return (assertion?`${line} · ${assertion}`:line?.trim()||`进程退出（${signal??code}）`).slice(0,300);
}

async function runTest(test,runDir,env){
  const [name,layer,timeout,skip]=test;
  const started=performance.now(),log=path.join(runDir,name+'.log');
  let status='FAIL',reason='',exitCode=null;
  try{
    if(skip)throw new Skip(skip);
    const [command,...flags]=name.endsWith('.py')?pythonCommand():[process.execPath];
    const browser=options.browser&&['test-settings.mjs','test-plugin-manager.mjs','test-native-server.mjs'].includes(name);
    const argv=[...flags,path.join(ROOT,'tools',name),...forward,...(browser?['--browser']:[])];
    const {code,signal,timedOut}=await execute(command,argv,timeout,log,env);
    const output=fs.readFileSync(log,'utf8');
    const missing=output.match(/^SKIP: (.+)$/m);
    exitCode=code;
    if(timedOut)reason=`超过 ${timeout} 秒时限`;
    else if(code===0)status='PASS';
    else if(code===77&&missing)throw new Skip(missing[1]);
    else reason=failureReason(output,code,signal);
  }catch(error){
    if(error instanceof Skip)status='SKIP';
    reason=error.message.split(/\r?\n/,1)[0];
  }
  return {name,layer,status,elapsedMs:skip?0:Math.round(performance.now()-started),reason,exitCode,
    log:fs.existsSync(log)?path.relative(ROOT,log):null};
}

const options=parseOptions();
const selected=tests.filter(([name])=>name.includes(options.only)).map(([name,layer,timeout,skip])=>
  [name,layer,timeout,skip||(layer==='浏览器'&&!options.browser?'使用 --browser 启用 Edge 验收':'')]);
if(!selected.length){
  console.error(`没有匹配的测试 ${options.only}`);
  process.exitCode=2;
}else if(options.list){
  console.table(selected.map(([name,layer,timeout,skip])=>({名称:name,层:layer,时限:timeout?timeout+' 秒':'—',说明:skip})));
}else{
  const env=testProcessEnv(),runDir=workDir('test-all'),results=[];
  for(const test of selected){
    if(!test[3])console.log(`运行 ${test[0]}`);
    results.push(await runTest(test,runDir,env));
  }
  const summary={PASS:0,FAIL:0,SKIP:0};
  for(const result of results)summary[result.status]++;
  console.table(results.map(({name,layer,status,elapsedMs,reason})=>
    ({名称:name,层:layer,结果:status,耗时:(elapsedMs/1000).toFixed(2)+' 秒',原因:reason})));
  console.log(`PASS ${summary.PASS} / FAIL ${summary.FAIL} / SKIP ${summary.SKIP}`);
  const report=path.join(SCRATCH,'test-report.json');
  fs.writeFileSync(report,JSON.stringify({generatedAt:new Date().toISOString(),options,summary,results},null,2)+'\n');
  console.log('报告 '+path.relative(ROOT,report));
  process.exitCode=summary.FAIL?1:0;
}
