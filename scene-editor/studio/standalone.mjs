export {bundleModules} from './plugin-bundle.mjs';
export function makeHtml(project,pack,modules,battlePack=null){
  const gameImports=Object.fromEntries(Object.entries(modules).map(([key,source])=>
    [key,'data:text/javascript;charset=utf-8,'+encodeURIComponent(source+'\n//# sourceURL='+key+'.mjs\n')]));
  const asScript=value=>JSON.stringify(value).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
  const content=asScript([project,pack,battlePack?{entries:battlePack.entries,byId:battlePack.byId}:null]);
  const importMap='<script type="importmap">'+asScript({imports:{...battlePack?.imports,...gameImports}})+'</script>';
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+
    '<title>DELTARUNE 场景</title><style>:root{color-scheme:dark;font:14px "Microsoft YaHei UI",sans-serif}'+
    '*{box-sizing:border-box}body{margin:0;background:#100f1a;color:#e9e2f8}main{width:min(880px,96vw);margin:14px auto}'+
    'header,.touch{display:flex;justify-content:space-between;align-items:center;gap:9px}h1{font-size:18px;margin:0}'+
    'canvas{display:block;margin:9px auto;background:#0d0c16;width:100%;max-height:75vh;object-fit:contain;aspect-ratio:var(--aspect,8/5);image-rendering:pixelated;outline:0}'+
    'button{font:inherit;background:#302840;border:1px solid #62547d;color:#f4eaff;border-radius:4px;padding:6px 11px;touch-action:none}'+
    'button:focus-visible{outline:2px solid #a0e6bc}p{color:#bdb0d2;margin:7px 0}.touch{touch-action:none}[hidden]{display:none!important}'+
    '.screen{position:relative}.scene-battle-stage{position:absolute;inset:0;container-type:size}'+
    '.scene-battle-canvas{--aspect:4/3}.scene-battle-curtain{position:absolute;inset:0;display:grid;place-items:center;background:#090611;pointer-events:none}'+
    '.scene-battle-curtain span{color:#f4e3ff;letter-spacing:.12em;padding:8px 16px;border-block:1px solid #6a548a}'+
    '.scene-battle-stage canvas{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(100cqw,calc(100cqh * var(--scene-ratio)));height:min(100cqh,calc(100cqw / var(--scene-ratio)));max-height:none;margin:0;object-fit:contain}'+
    '.scene-battle-entry{--aspect:4/3}'+
    '.touch.platform-controls [data-key="dash"]{display:inline-block}.touch [data-key="skill2"]{display:none}.touch.dungeon-controls [data-key="skill2"]{display:inline-block}.touch [data-combat]{display:none}.touch.combat-controls [data-combat]{display:inline-block}</style>'+importMap+'</head>'+
    '<body><main><header><h1 id="title">场景试玩</h1><div><label><input type="checkbox" id="mute"> 静音</label> <button id="restart">重新开始</button></div></header>'+
    '<div class="screen"><canvas tabindex="0" aria-label="可玩场景"></canvas></div><div class="touch"><div><button data-key="left">←</button> <button data-key="up">↑</button> <button data-key="down">↓</button> <button data-key="right">→</button></div><div><button data-key="act">Z</button> <button data-key="cancel">X</button> <button data-key="skill2" title="灵魂弹反">F</button> <button data-key="tool" title="使用手持工具">C</button> <button data-key="dash" data-combat>V</button> <button data-key="shoot" data-combat>B</button></div></div>'+
    '<p id="status">载入中…</p></main><script id="scene-data" type="application/json">'+content+'</script><script type="module">\n'+
    'import {offlinePlayer} from "scene/boot";\nofflinePlayer(...JSON.parse(document.getElementById("scene-data").textContent));\n</script></body></html>';
}
