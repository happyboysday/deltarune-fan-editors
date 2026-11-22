// dump_sounds.csx — 匯出「指定名稱」的 Sound 為檔案（.ogg / .wav），並輸出該章的 manifest。
// 由 extract_sfx.py 呼叫：
//   set UTMT_SND_OUT=<assets/audio/snd 的絕對路徑>
//   set UTMT_SND_LIST=<每行一個 sound 名稱的 UTF-8 檔（可 # 註解）>
//   set UTMT_CHAPTER=<章節標記，例如 ch5>
//   set UTMT_SKIP_EXISTING=1  → 已有 .wav/.ogg 的名稱跳過（讓最新章優先）
//   UndertaleModCli.exe load <data.win> -s dump_sounds.csx
// 輸出：<snd out>/<name>.wav|.ogg 與 <snd out>/_manifest_<chapter>.json
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Linq;
using UndertaleModLib;
using UndertaleModLib.Models;

EnsureDataLoaded();

string sndOut = Environment.GetEnvironmentVariable("UTMT_SND_OUT");
if (String.IsNullOrEmpty(sndOut))
{
    Console.WriteLine("[snd] UTMT_SND_OUT not set, abort");
    return;
}
string listPath = Environment.GetEnvironmentVariable("UTMT_SND_LIST");
if (String.IsNullOrEmpty(listPath) || !File.Exists(listPath))
{
    Console.WriteLine("[snd] UTMT_SND_LIST missing, abort");
    return;
}
string chapterTag = Environment.GetEnvironmentVariable("UTMT_CHAPTER");
if (String.IsNullOrEmpty(chapterTag)) chapterTag = "unknown";
bool skipExisting = Environment.GetEnvironmentVariable("UTMT_SKIP_EXISTING") == "1";

Directory.CreateDirectory(sndOut);

string[] wanted = File.ReadAllLines(listPath)
    .Select(l => l.Trim())
    .Where(l => l.Length > 0 && !l.StartsWith("#"))
    .Distinct()
    .ToArray();

var byName = new Dictionary<string, UndertaleSound>();
foreach (var s in Data.Sounds)
{
    if (s != null && s.Name != null && !byName.ContainsKey(s.Name.Content))
        byName[s.Name.Content] = s;
}

string dataDir = Path.GetDirectoryName(FilePath);

// 快取 audiogroup*.dat 的 EmbeddedAudio 清單
var groupCache = new Dictionary<int, IList<UndertaleEmbeddedAudio>>();

IList<UndertaleEmbeddedAudio> LoadGroup(int groupId)
{
    if (groupCache.ContainsKey(groupId)) return groupCache[groupId];
    string full = Path.Combine(dataDir, "audiogroup" + groupId + ".dat");
    if (!File.Exists(full))
    {
        groupCache[groupId] = null;
        return null;
    }
    try
    {
        UndertaleData d = null;
        using (var stream = new FileStream(full, FileMode.Open, FileAccess.Read))
            d = UndertaleIO.Read(stream, (w, i) => Console.WriteLine("[snd] warn audiogroup" + groupId + ": " + w));
        groupCache[groupId] = d.EmbeddedAudio;
        return d.EmbeddedAudio;
    }
    catch (Exception e)
    {
        Console.WriteLine("[snd] audiogroup" + groupId + " load FAIL: " + e.Message);
        groupCache[groupId] = null;
        return null;
    }
}

// 依檔頭判斷實際格式
string GuessExt(byte[] d)
{
    if (d.Length >= 4 && d[0] == 0x4F && d[1] == 0x67 && d[2] == 0x67 && d[3] == 0x53) return ".ogg";
    if (d.Length >= 4 && d[0] == 0x52 && d[1] == 0x49 && d[2] == 0x46 && d[3] == 0x46) return ".wav";
    return ".ogg";
}

string ExistingFile(string dir, string name)
{
    foreach (string ext in new string[] { ".wav", ".ogg" })
    {
        string p = Path.Combine(dir, name + ext);
        if (File.Exists(p)) return p;
    }
    return null;
}

int ok = 0, skip = 0, fail = 0;
string manifestPath = Path.Combine(sndOut, "_manifest_" + chapterTag + ".json");
var manifest = new StringBuilder();
manifest.Append('[');
bool mfirst = true;

foreach (string name in wanted)
{
    UndertaleSound sound;
    if (!byName.TryGetValue(name, out sound))
        continue;   // 本章沒有，交給較舊章節
    if (skipExisting && ExistingFile(sndOut, name) != null)
    {
        skip++;
        continue;
    }
    try
    {
        byte[] data = null;
        string src = "";

        // 1) 內嵌在 data.win 的 EMBEDDED 音檔
        if (sound.AudioFile != null && sound.AudioFile.Data != null && sound.AudioFile.Data.Length > 0)
        {
            data = sound.AudioFile.Data;
            src = "data.win";
        }
        // 2) 放在 audiogroup<N>.dat
        if (data == null && sound.AudioID >= 0)
        {
            int gid = sound.GroupID;
            var grp = LoadGroup(gid);
            if (grp != null && sound.AudioID < grp.Count)
            {
                var e = grp[sound.AudioID];
                if (e != null && e.Data != null && e.Data.Length > 0)
                {
                    data = e.Data;
                    src = "audiogroup" + gid;
                }
            }
        }
        // 3) 外部音檔（遊戲資料夾旁的 .ogg）
        if (data == null && sound.File != null && !String.IsNullOrEmpty(sound.File.Content))
        {
            string fname = sound.File.Content;
            if (!fname.Contains('.')) fname += ".ogg";
            string cand = Path.Combine(dataDir, fname);
            if (File.Exists(cand))
            {
                data = File.ReadAllBytes(cand);
                src = "external";
            }
        }

        if (data == null || data.Length == 0)
        {
            Console.WriteLine("[snd] no-data: " + name);
            fail++;
            continue;
        }

        string ext = GuessExt(data);
        string dest = Path.Combine(sndOut, name + ext);
        File.WriteAllBytes(dest, data);

        if (!mfirst) manifest.Append(',');
        mfirst = false;
        manifest.Append("{\"name\":\"").Append(J(name)).Append('"');
        manifest.Append(",\"file\":\"").Append(J(name + ext)).Append('"');
        manifest.Append(",\"chapter\":\"").Append(J(chapterTag)).Append('"');
        manifest.Append(",\"src\":\"").Append(J(src)).Append('"');
        manifest.Append(",\"bytes\":").Append(data.Length);
        manifest.Append(",\"ext\":\"").Append(ext).Append('"');
        manifest.Append(",\"volume\":").Append(sound.Volume.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture));
        manifest.Append(",\"pitch\":").Append(sound.Pitch.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture));
        manifest.Append('}');
        ok++;
    }
    catch (Exception e)
    {
        Console.WriteLine("[snd] FAIL " + name + " : " + e.GetType().Name + ": " + e.Message);
        fail++;
    }
}
manifest.Append(']');
File.WriteAllText(manifestPath, manifest.ToString(), new UTF8Encoding(false));

Console.WriteLine("[snd] chapter=" + chapterTag + " ok=" + ok + " skip=" + skip + " fail=" + fail);
Console.WriteLine("[snd] manifest -> " + manifestPath);

static string J(string s)
{
    if (String.IsNullOrEmpty(s)) return "";
    var b = new StringBuilder(s.Length + 8);
    foreach (char c in s)
    {
        switch (c)
        {
            case '"': b.Append("\\\""); break;
            case '\\': b.Append("\\\\"); break;
            case '\n': b.Append("\\n"); break;
            case '\r': b.Append("\\r"); break;
            case '\t': b.Append("\\t"); break;
            default:
                if (c < 0x20) b.Append("\\u").Append(((int)c).ToString("x4"));
                else b.Append(c);
                break;
        }
    }
    return b.ToString();
}
