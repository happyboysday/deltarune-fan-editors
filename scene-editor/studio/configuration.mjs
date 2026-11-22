export const labels={
  assets:'场景编辑器素材',battleAssets:'战斗素材库',officialRoot:'官方解包素材',base:'V0.4 布景工作台',
  aExport:'A-export v8',ch6Assets:'第 6 章素材',battleRoot:'战斗编辑器',projects:'场景工程',
  plugins:'用户插件目录',trailerRoot:'宣传片工程',port:'端口',node:'Node.js（--node）',
  DIRECTOR_GAME:'真实游戏（DIRECTOR_GAME）',DIRECTOR_UTMT:'UndertaleModCli（DIRECTOR_UTMT）',
};
export function unavailable(capabilities, keys){
  return keys.split(' ').map(k=>capabilities[k]).filter(row=>row&&!row.available).map(row=>
    row.reason+(row.missingSettings.length?'（'+row.missingSettings.map(k=>labels[k]??k).join('、')+'）':'')).join('；');
}
export function disableFeature(element,reason){
  if(!reason)return;
  const title=reason.includes('（')?reason:reason+' · 请查看设置';
  element.title=title;
  if(element.tagName==='A'){
    element.removeAttribute('href');
    element.setAttribute('role','link');
    element.tabIndex=0;
  }else if('disabled' in element)element.disabled=true;
  element.setAttribute('aria-disabled','true');
}
export async function api(path,body){
  const response=await fetch('/api/studio/'+path,body===undefined?undefined:{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
  });
  const result=await response.json();
  if(!response.ok)throw Error([result.error,...(result.errors??[])].filter(Boolean).join('：')||'HTTP '+response.status);
  return result;
}
export function finishSetup(report){
  if(report.firstRunDone)return false;
  location.replace('/studio/settings.html?'+new URLSearchParams({setup:'1',return:location.pathname+location.search}));
  return true;
}
