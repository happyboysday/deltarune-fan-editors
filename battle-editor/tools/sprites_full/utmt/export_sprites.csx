// export_sprites.csx — 依清單把指定 sprite 的「全部幀」匯出成 PNG。
// padding=true：輸出畫布固定 sprite.Width × sprite.Height，幀依 TargetX/TargetY 置入，
// 這樣原點 (OriginX/OriginY) 才是同一個座標系（與引擎 draw_sprite_ext 行為一致）。
// 由 extract.py 呼叫：
//   UndertaleModCli.exe load <data.win> -s <abs>/export_sprites.csx
// 環境變數：
//   UTMT_OUT    輸出目錄（必填）；幀寫到 <UTMT_OUT>/<sprite名>/<i>.png
//   UTMT_LIST   要匯出的 sprite 名清單檔（每行一個；必填）
//   UTMT_CHAPTER 章節標籤（只印 log）
// 另外寫出 <UTMT_OUT>/exported.json 記錄實際寫出的檔案與大小，供 Python 對帳。
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using UndertaleModLib;
using UndertaleModLib.Models;
using UndertaleModLib.Util;

EnsureDataLoaded();

string outRoot = Environment.GetEnvironmentVariable("UTMT_OUT");
if (String.IsNullOrEmpty(outRoot)) outRoot = Path.Combine(Directory.GetCurrentDirectory(), "utmt_sprites_export");
Directory.CreateDirectory(outRoot);
string listPath = Environment.GetEnvironmentVariable("UTMT_LIST");
if (String.IsNullOrEmpty(listPath) || !File.Exists(listPath))
    throw new FileNotFoundException("UTMT_LIST 不存在：" + listPath);
string chapter = Environment.GetEnvironmentVariable("UTMT_CHAPTER");
if (chapter == null) chapter = "";

var byName = new Dictionary<string, UndertaleSprite>(StringComparer.Ordinal);
if (Data.Sprites != null)
{
    for (int i = 0; i < Data.Sprites.Count; i++)
    {
        UndertaleSprite s = Data.Sprites[i];
        if (s == null || s.Name == null) continue;
        byName[s.Name.Content] = s;
    }
}

var names = new List<string>();
foreach (string raw in File.ReadAllLines(listPath))
{
    string line = raw.Trim();
    if (line.Length == 0 || line.StartsWith("#")) continue;
    names.Add(line);
}

var sb = new StringBuilder(1 << 18);
sb.Append("{\"chapter\":\"").Append(Esc(chapter)).Append('"');
sb.Append(",\"exported\":[");
bool firstItem = true;
int okFrames = 0, okSprites = 0, missingSprites = 0, badFrames = 0;

using (TextureWorker worker = new TextureWorker())
{
    foreach (string name in names)
    {
        UndertaleSprite s;
        if (!byName.TryGetValue(name, out s))
        {
            missingSprites++;
            continue;
        }
        string dir = Path.Combine(outRoot, name);
        Directory.CreateDirectory(dir);
        int fc = 0;
        try { fc = s.Textures != null ? s.Textures.Count : 0; } catch { }
        var frames = new List<string>();
        for (int i = 0; i < fc; i++)
        {
            bool ok = false;
            string file = Path.Combine(dir, i.ToString() + ".png");
            try
            {
                var entry = s.Textures[i];
                if (entry != null && entry.Texture != null)
                {
                    worker.ExportAsPNG(entry.Texture, file, null, true);
                    ok = File.Exists(file) && new FileInfo(file).Length > 0;
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine("[export_sprites] " + name + " frame " + i + " 失敗: " + ex.Message);
            }
            if (ok) { frames.Add(i.ToString() + ".png"); okFrames++; }
            else badFrames++;
        }
        okSprites++;
        if (!firstItem) sb.Append(',');
        firstItem = false;
        sb.Append("{\"name\":\"").Append(Esc(name)).Append('"');
        sb.Append(",\"frameCount\":").Append(fc);
        sb.Append(",\"files\":[");
        for (int k = 0; k < frames.Count; k++)
        {
            if (k > 0) sb.Append(',');
            sb.Append('"').Append(frames[k]).Append('"');
        }
        sb.Append("]}");
    }
}
sb.Append("],");
sb.Append("\"sprites\":").Append(okSprites).Append(',');
sb.Append("\"frames\":").Append(okFrames).Append(',');
sb.Append("\"missingSprites\":").Append(missingSprites).Append(',');
sb.Append("\"failedFrames\":").Append(badFrames).Append('}');

File.WriteAllText(Path.Combine(outRoot, "exported.json"), sb.ToString(), new UTF8Encoding(false));
Console.WriteLine("[export_sprites] chapter=" + chapter + " sprites=" + okSprites + " frames=" + okFrames
    + " missing=" + missingSprites + " failedFrames=" + badFrames);

static string Esc(string s)
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
