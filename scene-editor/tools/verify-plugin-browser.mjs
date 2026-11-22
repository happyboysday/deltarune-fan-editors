import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {openBrowserTest} from './test-env.mjs';
import {verifyExports} from './test-plugin-export.mjs';

await verifyExports(async(origin,exports,dir)=>{
  const {edge}=await openBrowserTest(origin,undefined,{profileDir:path.join(dir,'edge-profile')});
  const {cdp}=edge,errors=[],requests=[];
  async function evaluate(expression){
    const r=await cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});
    if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);
    return r.result.value;
  }
  async function until(test,description){
    for(let i=0;i<200;i++){if(await test())return;await new Promise(r=>setTimeout(r,100));}
    throw Error(description+' · '+await evaluate("document.querySelector('#status')?.textContent"));
  }
  try{
    console.log('Edge 已连接，正在启用 CDP 页面域');
    await cdp.send('Page.enable');await cdp.send('Runtime.enable');await cdp.send('Network.enable');
    console.log('CDP 页面域已就绪，正在打开编辑器');
    cdp.on('Runtime.exceptionThrown',e=>errors.push(e.exceptionDetails.text));
    cdp.on('Network.requestWillBeSent',e=>requests.push(e.request.url));
    await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:dir});
    await cdp.send('Page.navigate',{url:origin+'/?project=/plugins/fireflies/demo.scene.json&manual=1'});
    await until(()=>evaluate("document.body?.dataset.ready==='true'&&document.getElementById('title').value==='萤火小径'"),'打开萤火示例');
    assert.ok(await evaluate("document.getElementById('fields').textContent.includes('收集时限')"));
    assert.ok(await evaluate("document.getElementById('pluginTools').textContent.includes('添加萤火')"));
    await evaluate("document.getElementById('play').click()");
    await until(()=>evaluate("!!window.__ch6Trailer"),'启动编辑器试玩');
    assert.ok(await evaluate("(__ch6Trailer.start(),__ch6Trailer.advance(180).flags.gardenLit)"));
    await evaluate("document.getElementById('editMode').click();document.getElementById('exportHtml').click()");
    const download=path.join(dir,'萤火小径-离线试玩.html');
    await until(()=>fs.existsSync(download),'编辑器离线导出');
    for(const file of [download,...exports.slice(1)]){
      requests.length=0;
      await cdp.send('Page.navigate',{url:pathToFileURL(file).href+'?manual=1&autoplay=1'});
      await until(()=>evaluate("location.protocol==='file:'&&document.body?.dataset.ready==='true'&&!!window.sceneGame"),'打开离线 HTML');
      await evaluate('sceneGame.advance({},1000)');
      assert.equal(await evaluate('sceneGame.world.state.tick'),1000);
      assert.ok(requests.every(u=>!/^https?:/.test(u)),'离线页请求了网络资源');
    }
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(dir,'plugins/fireflies/editor.mjs'),"throw Error('面板加载测试')");
    await cdp.send('Page.navigate',{url:origin+'/?project=/plugins/fireflies/demo.scene.json'});
    const panelError="document.querySelector('#pluginTools [role=alert]')?.textContent";
    await until(()=>evaluate("document.body?.dataset.ready==='true'&&"+panelError+"?.includes('面板加载测试')"),'编辑器显示缺失面板原因');
    await evaluate("document.getElementById('validate').click()");
    assert.match(await evaluate(panelError),/fireflies.*编辑器入口.*面板加载测试/);
  }finally{await edge.close();}
});
