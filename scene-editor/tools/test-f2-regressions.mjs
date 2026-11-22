import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {ROOT,pythonCommand,startTestStudio,testProcessEnv,workDir} from './test-env.mjs';

const api='/api/studio/', plugins=api+'plugins';
const fireflies=path.join(ROOT,'examples/plugins/fireflies');
const jsonHeaders={'Content-Type':'application/json'};
function run(exe,args,options={}){
  return spawnSync(exe,args,{cwd:ROOT,encoding:'utf8',windowsHide:true,timeout:30000,...options});
}
function success(result){
  assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);
  return result.stdout;
}
function python(code,...args){
  const [exe,...flags]=pythonCommand();
  return success(run(exe,[...flags,'-c',code,...args]));
}
function write(file,contents=''){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,contents);
}
async function studio(t,dir,options=[],env={}){
  const server=await startTestStudio(['--data',path.join(dir,'data'),'--assets',path.join(dir,'empty'),...options],
    undefined,true,{env:{...testProcessEnv(),...env}});
  t.after(()=>server.close());
  return server.origin;
}
async function json(origin,route,status=200,body){
  const res=await fetch(origin+route,body===undefined?undefined:{method:'POST',body:JSON.stringify(body),headers:jsonHeaders});
  const data=await res.json();
  assert.equal(res.status,status,route+' '+JSON.stringify(data));
  return data;
}

test('F2 #3 · 普通目录和无效清单只提供诊断',async t=>{
  const dir=workDir('f2-plugin-diagnostics'), workspace=path.join(dir,'workspace');
  const project=path.join(workspace,'projects','keep.scene.json');
  write(project,'{}');
  write(path.join(workspace,'broken/plugin.json'),'{');
  fs.cpSync(fireflies,path.join(workspace,'wrong-directory'),{recursive:true});
  fs.cpSync(fireflies,path.join(workspace,'fireflies'),{recursive:true});
  fs.unlinkSync(path.join(workspace,'fireflies/runtime.mjs'));
  const origin=await studio(t,dir,['--plugins',workspace]);
  for(const id of ['projects','broken','wrong-directory']){
    for(const action of ['uninstall','disable','enable'])await json(origin,`${plugins}/${id}/${action}`,422,{});
  }
  const entries=(await json(origin,plugins)).plugins;
  for(const id of ['projects','broken','wrong-directory','kart']){
    const row=entries.find(e=>e.directory===id);
    assert.equal(row.manageable,false,id);
    assert.ok(row.managementReason,id);
  }
  const repairable=entries.find(e=>e.directory==='fireflies');
  assert.equal(repairable.manageable,true);
  assert.ok(repairable.errors.length);
  await json(origin,plugins+'/fireflies/disable',200,{});
  assert.equal(fs.readFileSync(project,'utf8'),'{}');
  const states=(await json(origin,api+'settings')).settings.pluginEnabled.value;
  assert.deepEqual(states,{fireflies:false});
});

test('F2 #4 · 拒绝硬链接和打开时被替换的源文件',async t=>{
  const dir=workDir('f2-plugin-hardlink'), folder=path.join(dir,'folder'), outside=path.join(dir,'outside.json');
  fs.cpSync(fireflies,folder,{recursive:true});
  write(outside,'{"local":"fixture"}');
  fs.linkSync(outside,path.join(folder,'linked.json'));
  const origin=await studio(t,dir);
  assert.match((await json(origin,plugins+'/install',422,{folder})).error,/硬链接/);
  assert.equal(fs.existsSync(path.join(dir,'data/plugins/fireflies')),false);

  python(String.raw`
import sys
from pathlib import Path
from unittest.mock import patch
from plugins_host import StagedPlugin

root = Path(sys.argv[1])
source = root / 'source'
source.mkdir()
item, replacement = source / 'demo.json', root / 'replacement.json'
item.write_bytes(b'{}')
replacement.write_bytes(b'[]')
original_open = Path.open

def open_swapped(path, *args, **kwargs):
    return original_open(replacement if path == item else path, *args, **kwargs)

stage = StagedPlugin(root)
with patch.object(Path, 'open', open_swapped):
    try:
        stage.copy_folder(source)
    except ValueError as error:
        assert 'demo.json' in str(error), error
    else:
        raise AssertionError('opened file identity differed but the contents were copied')
assert not (stage.root / item.name).exists()
stage.clean()
`,dir);
});

test('F2 #16 · 回收目的地留在插件所属的卷',()=>{
  python(String.raw`
import errno, json, shutil, sys, threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from plugins_host import PluginManager, inventory

root, node = Path(sys.argv[1]), sys.argv[2]
data, plugins = root / 'data-volume', root / 'plugin-volume' / 'plugins'
data.mkdir()
shutil.copytree('examples/plugins/fireflies', plugins / 'fireflies')
manager = PluginManager(plugins, node, SimpleNamespace(data=data, lock=threading.RLock()))
rename = Path.rename

def same_volume(source, target):
    if not Path(target).is_relative_to(plugins.parent):
        raise OSError(errno.EXDEV, 'simulated different volume')
    return rename(source, target)

with patch.object(Path, 'rename', same_volume):
    response = manager.manage('fireflies', 'uninstall')
assert response.status == 200
target = Path(json.loads(response.data)['trash'])
assert target.parent == plugins / '.plugins-trash'
assert (target / 'plugin.json').is_file()
assert not (plugins / 'fireflies').exists()
assert '.plugins-trash' not in [row['directory'] for row in inventory(node, plugins)['plugins']]
`,workDir('f2-plugin-trash'),process.execPath);
});

test('F2 #17 · 中央目录在 ZipFile 之前限流，解包和校验不占设置锁',()=>{
  python(String.raw`
import base64, io, struct, sys, threading, zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import plugins_host as host

def archive(entries, comment=b''):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w') as output:
        output.comment = comment
        for entry, contents in entries:
            output.writestr(entry, contents)
    return stream.getvalue()

root, node = Path(sys.argv[1]), sys.argv[2]
many = archive((f'{i}.json', b'{}') for i in range(4097))
forged = bytearray(many)
struct.pack_into('<2H', forged, len(forged) - 14, 1, 1)
large_entries = [zipfile.ZipInfo(f'{i}.json') for i in range(65)]
for entry in large_entries:
    entry.comment = b'a' * 65535
large = archive((entry, b'{}') for entry in large_entries)
stage = host.StagedPlugin(root)
for data in (many, forged, large):
    with patch.object(zipfile, 'ZipFile', side_effect=AssertionError('ZipFile parsed an oversized directory')) as parser:
        try:
            stage.unpack(base64.b64encode(data).decode('ascii'))
        except ValueError:
            parser.assert_not_called()
        else:
            raise AssertionError('oversized archive accepted')
stage.clean()

source = Path('examples/plugins/fireflies')
lock = threading.Lock()
manager = host.PluginManager(root / 'plugins', node,
    SimpleNamespace(lock=lock, sync=lambda: None, plugin_enabled=lambda plugin_id: True))

def unlocked(function):
    def check(*args, **kwargs):
        assert lock.acquire(blocking=False), 'installation holds the settings lock while staging'
        lock.release()
        return function(*args, **kwargs)
    return check

with patch.object(zipfile, 'ZIP64_LIMIT', 1):
    payload = base64.b64encode(archive(((p.name, p.read_bytes()) for p in source.iterdir()), b'comment')).decode('ascii')
with patch.object(host.StagedPlugin, 'unpack', unlocked(host.StagedPlugin.unpack)), \
        patch.object(host, 'inventory', unlocked(host.inventory)):
    response = manager.install({'zip': payload})
assert response.status == 201
`,workDir('f2-zip-preflight'),process.execPath);
});

test('F2 #18 · 区分编辑、生成、试玩和段落预演',async t=>{
  const dir=workDir('f2-chapter-capabilities'), chapters=path.join(dir,'chapters');
  const game=path.join(dir,'game'), compiler=path.join(dir,'UndertaleModCli.exe');
  const home=path.join(chapters,'ch5');
  for(const n of [4,5]){
    for(const file of ['index.json','scripts.zip','edits.json'])write(path.join(chapters,'ch'+n,file),'{}');
  }
  write(path.join(game,'DELTARUNE.exe'));
  write(path.join(home,'chapter.json'),'{}');
  write(path.join(home,'play/chapter5_windows/data.win'));
  write(path.join(home,'play/chapter5_windows/DELTARUNE.exe'));
  write(path.join(home,'previews.json'),'{"room_intro_ch5":{}}');
  write(path.join(home,'build.json'),python(String.raw`
import hashlib, json, sys
from pathlib import Path
from chapter_host import Chapter
home = Path(sys.argv[1])
# F1: a prebuilt copy is only trusted with the digest of its data.win.
digest = hashlib.sha256((home / 'play/chapter5_windows/data.win').read_bytes()).hexdigest()
print(json.dumps({'buildKey': Chapter(5, home).build_key(), 'buildSHA256': digest}))
`,home));
  const origin=await studio(t,dir,['--chapters',chapters],{DIRECTOR_GAME:game,DIRECTOR_UTMT:compiler});
  const read=async()=>(await json(origin,api+'capabilities')).capabilities;
  let c=await read();
  assert.equal(c.chapterPlay5.available,true);
  assert.equal(c.chapterPreview5?.available,false);
  assert.deepEqual(c.chapterPreview5.missingSettings,['DIRECTOR_UTMT']);
  assert.match(c.chapterPreview5.reason,/UndertaleModCli/);
  assert.equal(c.chapterEdit4.available,true);
  assert.equal(c.chapters.chapters['4'],true);
  assert.equal(c.chapterBuild5.available,false);
  assert.match(c.chapterBuild5.reason,/resources\.zip.*dependencies\.json/);

  write(compiler);
  c=await read();
  assert.equal(c.chapterPreview5.available,true);
  assert.equal(c.chapterBuild5.available,false);
  write(path.join(home,'resources.zip'));
  assert.match((await read()).chapterBuild5.reason,/dependencies\.json/);
  write(path.join(home,'dependencies.json'),'{"DELTARUNE.exe":"fixture","mus/track.ogg":"fixture"}');
  assert.match((await read()).chapterBuild5.reason,/mus\/track\.ogg/);
  write(path.join(game,'mus/track.ogg'));
  assert.equal((await read()).chapterBuild5.available,true);
  fs.renameSync(path.join(home,'previews.json'),path.join(home,'presets.json'));
  assert.match((await read()).chapterPreview5.reason,/previews\.json/);
  fs.renameSync(path.join(home,'build.json'),path.join(home,'old-build.json'));
  fs.renameSync(compiler,compiler+'.disabled');
  assert.match((await read()).chapterPlay5.reason,/UndertaleModCli/);
});

test('F2 #20 · 发布包只收录跟踪文件并拒绝示例里的内嵌素材',()=>{
  const dir=workDir('f2-release'), script=path.join(dir,'tools/make-release.mjs'), output=path.join(dir,'result.zip');
  write(script,fs.readFileSync(path.join(ROOT,'tools/make-release.mjs')));
  for(const name of ['README.md','CHANGELOG.md','studio_server.py','battle_host.py','chapter_host.py',
    'chapter_navigation.py','chapter_window.py','plugins_host.py','ui_assets.py','launch-v1.cmd','launch-v06.cmd','launch-chapters.cmd'])
    write(path.join(dir,name));
  for(const folder of ['docs','examples','studio','studio_core','tools'])write(path.join(dir,folder,'fixture.md'));
  const pack=options=>run(process.execPath,[script,output],{cwd:dir,...options});
  const noGit=pack({env:{...process.env,GIT_CEILING_DIRECTORIES:path.dirname(dir)}});

  const git=(...args)=>success(run('git',args,{cwd:dir}));
  git('init','--quiet');
  git('add','--','README.md','CHANGELOG.md','*.py','*.cmd','docs','examples','studio','studio_core','tools');
  write(path.join(dir,'examples/untracked-private.json'),'{}');
  write(path.join(dir,'tools/local-notes.mjs'),'local data');
  success(pack());
  const names=JSON.parse(python(String.raw`
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    print(json.dumps(archive.namelist()))
`,output));
  assert.ok(names.includes('examples/fixture.md'));
  assert.ok(names.every(name=>!name.includes('untracked')&&!name.includes('local-notes')));
  write(path.join(dir,'examples/untracked-audio.wav'),'also local');
  success(pack());

  for(const [name,value] of [['picture.scene.json','data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAE='],
    ['audio.json',Buffer.from('RIFF0000WAVEfmt ').toString('base64')]]){
    const rel='examples/'+name;
    write(path.join(dir,rel),JSON.stringify({nested:[{asset:value}]}));
    git('add','--',rel);
    const blocked=pack();
    assert.notEqual(blocked.status,0);
    assert.ok(blocked.stderr.includes(rel),blocked.stderr);
    fs.unlinkSync(path.join(dir,rel));
    git('add','-u','--',rel);
  }
  assert.notEqual(noGit.status,0);
  assert.match(noGit.stderr,/需要 Git/);
});

test('F2 #22 · 重启、启停与卸载要求小型 JSON 对象',async t=>{
  const origin=await studio(t,workDir('f2-action-json'));
  await json(origin,plugins+'/install',201,{folder:fireflies});
  for(const route of [...['enable','disable','uninstall'].map(action=>plugins+'/fireflies/'+action),api+'restart']){
    for(const [status,body,headers] of [[415,'{}',{'Content-Type':'text/plain'}],
      [413,'',jsonHeaders],[400,'[]',jsonHeaders],[400,'null',jsonHeaders],[400,'{',jsonHeaders],
      [413,JSON.stringify({text:'x'.repeat(4096)}),jsonHeaders],
      [403,'{}',{...jsonHeaders,Origin:'https://invalid.example'}]]){
      const res=await fetch(origin+route,{method:'POST',body,headers});
      assert.equal(res.status,status,route+' '+await res.text());
    }
  }
  assert.equal((await json(origin,plugins)).plugins.find(e=>e.directory==='fireflies').enabled,true);
  assert.equal((await json(origin,plugins+'/fireflies/disable',200,{})).enabled,false);
  assert.equal((await json(origin,plugins+'/fireflies/enable',200,{})).enabled,true);
  assert.equal((await json(origin,plugins+'/fireflies/uninstall',200,{})).ok,true);
  assert.equal((await json(origin,api+'restart',202,{})).exitCode,3);
});

test('F2 #24 · 使用手册中的萤火小径地址可打开',async t=>{
  const manual=fs.readFileSync(path.join(ROOT,'docs/使用手册.md'),'utf8');
  const route=manual.match(/`(\/\?project=\/plugins\/fireflies\/[^`]+\.scene\.json)`/)?.[1];
  assert.ok(route,'使用手册缺少萤火小径地址');
  const origin=await studio(t,workDir('f2-fireflies-manual'));
  await json(origin,api+'settings',200,{settings:{firstRunDone:true}});
  await json(origin,plugins+'/install',201,{folder:fireflies});
  const page=await fetch(origin+route);
  assert.equal(page.status,200);
  assert.match(await page.text(),/\/studio\/editor\.mjs/);
  assert.equal((await json(origin,new URL(page.url).searchParams.get('project'))).title,'萤火小径');
});
