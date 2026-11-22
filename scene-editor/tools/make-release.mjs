import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(fileURLToPath(new URL('../',import.meta.url)));
const argv=process.argv.slice(2);
if(argv.length>1||argv[0]?.startsWith('-'))throw Error('用法为 node tools/make-release.mjs [输出.zip]');
const output=argv[0]?path.resolve(argv[0]):path.join(root,'.codex-tmp/release/场景编辑器-V1.0.zip');
if(path.extname(output).toLowerCase()!=='.zip')throw Error('发布包输出路径须以 .zip 结尾');

const folders=['docs','examples','studio','studio_core','tools'];
const entryFiles=['README.md','CHANGELOG.md','studio_server.py','battle_host.py','chapter_host.py',
  'chapter_navigation.py','chapter_window.py','plugins_host.py','ui_assets.py',
  'launch-v1.cmd','launch-v06.cmd','launch-chapters.cmd'];
const excluded=new Set(['.git','.codex-tmp','__pycache__','.v04-cache','.ui-cache','node_modules']);
const media=/\.(?:png|apng|gif|jpe?g|webp|avif|bmp|ico|tiff?|svg|wav|wave|mp3|mp[24]|m4[abv]|aac|ogg|og[av]|opus|flac|aiff?|wma|mid|midi|amr|ac3|caf|au|webm|mov|mkv|avi|ttf|ttc|otf|otc|woff2?|eot|fon|fnt|bdf|pf[ab])$/i;
const source=/\.(?:md|m?js|json|html|css|py|csx|gml|sha256)$/i;
const demoArt=/^studio\/art\/(?:foreman(?:-face)?|lantern-[01]|sprout|stagehand|walker-(?:down|left|right|up)-[012])\.png$/;
const blocked=[],files=[];
const tracked=spawnSync('git',['ls-files','-z','--cached','--deduplicate'],{
  cwd:root,encoding:'utf8',windowsHide:true,timeout:15000,
});
if(tracked.status!==0)throw Error('发布打包需要 Git 和版本库工作区：'+
  (tracked.error?.message||tracked.stderr.trim()||'git ls-files 失败'));

const checkedDirs=new Set();
function collect(rel){
  const parts=rel.split('/');
  if(parts.some(name=>excluded.has(name.toLowerCase()))||rel.toLowerCase()==='tools/test-env.local.json')return;
  if(!folders.includes(parts[0])&&!entryFiles.includes(rel)&&!(parts.length===1&&media.test(rel)))return;
  const file=path.join(root,rel);
  if(file===output)return;
  if(media.test(rel)&&!demoArt.test(rel)){
    blocked.push(rel);
  }else if(demoArt.test(rel)||entryFiles.includes(rel)||source.test(rel)){
    if(/^examples\/[^/]+\.html$/i.test(rel))return;
    for(let dir=path.dirname(file);dir!==root&&!checkedDirs.has(dir);dir=path.dirname(dir)){
      if(!fs.lstatSync(dir).isDirectory())throw Error('发布目录须为普通目录：'+path.relative(root,dir));
      checkedDirs.add(dir);
    }
    const info=fs.lstatSync(file);
    if(!info.isFile())throw Error('发布文件须为普通文件：'+rel);
    if(rel.startsWith('tools/fixtures/')&&info.size>1024*1024)return;
    files.push(rel);
  }
}
for(const rel of tracked.stdout.split('\0').filter(Boolean))collect(rel);
if(blocked.length)throw Error('发布包发现禁止的素材文件：\n'+blocked.sort().join('\n'));
for(const name of entryFiles)
  if(!files.includes(name))throw Error('缺少发布文件：'+name);

const candidates=process.env.PYTHON?[[process.env.PYTHON]]:process.platform==='win32'?
  [['py','-3'],['python'],['python3']]:[['python3'],['python']];
const python=candidates.find(([exe,...flags])=>spawnSync(exe,[...flags,'-c',
  'import sys; sys.exit(sys.version_info < (3, 11))'],{stdio:'ignore',windowsHide:true,timeout:5000}).status===0);
if(!python)throw Error('缺少 Python 3.11 或更新版本，可通过 PYTHON 指定解释器');
const [exe,...flags]=python;
const result=spawnSync(exe,[...flags,'-B','-X','utf8','-c',String.raw`
import base64, hashlib, json, os, re, sys, tempfile, zipfile
from pathlib import Path

def media_bytes(data):
    return (data.startswith((b"\x89PNG\r\n\x1a\n", b"GIF87a", b"GIF89a", b"\xff\xd8\xff",
                             b"OggS\x00", b"fLaC", b"ID3", b"OTTO", b"wOFF", b"wOF2",
                             b"ttcf", b"\x00\x01\x00\x00"))
            or (data.startswith(b"RIFF") and data[8:12] in (b"WEBP", b"WAVE", b"AVI "))
            or (data.startswith(b"FORM") and data[8:12] in (b"AIFF", b"AIFC"))
            or data[4:8] == b"ftyp")

def encoded_media(value):
    data = "".join(value.split())
    if not re.fullmatch(r"[a-zA-Z0-9+/_-]{16,}={0,2}", data):
        return False
    data = data.rstrip("=")
    if len(data) % 4 == 1:
        return False
    prefix = data[:32]
    return media_bytes(base64.b64decode(prefix + "=" * (-len(prefix) % 4), altchars=b"-_"))

def example_media(data):
    pending = [json.loads(data)]
    while pending:
        value = pending.pop()
        if isinstance(value, dict):
            pending.extend(value.keys())
            pending.extend(value.values())
        elif isinstance(value, list):
            pending.extend(value)
        elif isinstance(value, str):
            if encoded_media(value):
                return True
            for match in re.finditer(r"data:([^;,]*)(?:;[^,]*)?;base64,([a-z0-9+/_=-]+)", value, re.I):
                kind, payload = match.groups()
                if (kind.lower().startswith(("image/", "audio/", "video/", "font/")) or encoded_media(payload)):
                    return True
    return False

root, target = map(Path, sys.argv[1:])
files = json.load(sys.stdin.buffer)
target.parent.mkdir(parents=True, exist_ok=True)
with tempfile.NamedTemporaryFile(dir=target.parent, suffix=".tmp", delete=False) as temp:
    pending = Path(temp.name)
try:
    manifest, blocked = [], []
    with zipfile.ZipFile(pending, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in files:
            data = (root / name).read_bytes()
            if ((not name.startswith("studio/art/") or not name.endswith(".png")) and media_bytes(data) or
                    name.startswith("examples/") and name.lower().endswith(".json") and example_media(data)):
                blocked.append(name)
                continue
            manifest.append({"file": name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})
            archive.writestr(name, data)
        if blocked:
            sys.exit("发布包发现禁止的素材文件：\n" + "\n".join(blocked))
        archive.writestr("release-manifest.json", json.dumps({"version": "V1.0", "files": manifest},
                         ensure_ascii=False, indent=2) + "\n")
    os.replace(pending, target)
finally:
    pending.unlink(missing_ok=True)
`,root,output],{input:Buffer.from(JSON.stringify(files.sort())),encoding:'utf8',windowsHide:true});
if(result.status!==0)throw Error(result.error?.message||result.stderr.trim()||'发布打包失败');
console.log(`${output} · ${fs.statSync(output).size} 字节 · ${files.length+1} 个文件（含清单）`);
