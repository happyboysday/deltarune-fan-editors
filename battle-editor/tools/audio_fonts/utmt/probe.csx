// probe.csx — 列出 data.win 內所有 Sound 與 Font 資源的結構資訊（唯讀）。
// 用法（由 extract_all.py 呼叫）：
//   UndertaleModCli.exe load <data.win> -s probe.csx -o <tmp_out>
// 環境變數：
//   UTMT_OUT  輸出目錄
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using UndertaleModLib;
using UndertaleModLib.Models;

EnsureDataLoaded();

string outRoot = Environment.GetEnvironmentVariable("UTMT_OUT");
if (String.IsNullOrEmpty(outRoot)) outRoot = Path.Combine(Directory.GetCurrentDirectory(), "utmt_probe");
Directory.CreateDirectory(outRoot);

var sb = new StringBuilder();
sb.Append("{\"sounds\":[");
bool first = true;
for (int i = 0; i < Data.Sounds.Count; i++)
{
    UndertaleSound s = Data.Sounds[i];
    if (s == null || s.Name == null) continue;
    if (!first) sb.Append(',');
    first = false;
    bool emb = (s.Flags & UndertaleSound.AudioEntryFlags.IsEmbedded) != 0;
    bool cmp = (s.Flags & UndertaleSound.AudioEntryFlags.IsCompressed) != 0;
    long len = 0;
    bool hasEmbeddedAudio = false;
    try { hasEmbeddedAudio = s.AudioFile != null; } catch { }
    if (hasEmbeddedAudio)
    {
        try { if (s.AudioFile.Data != null) len = s.AudioFile.Data.Length; } catch { }
    }
    sb.Append("{\"i\":").Append(i);
    sb.Append(",\"name\":\"").Append(Esc(s.Name.Content)).Append('"');
    sb.Append(",\"group\":").Append(s.GroupID);
    sb.Append(",\"audioId\":").Append(s.AudioID);
    sb.Append(",\"audioGroup\":\"").Append(s.AudioGroup != null ? Esc(s.AudioGroup.Name.Content) : "").Append('"');
    sb.Append(",\"file\":\"").Append(s.File != null ? Esc(s.File.Content) : "").Append('"');
    sb.Append(",\"embedded\":").Append(emb ? "true" : "false");
    sb.Append(",\"compressed\":").Append(cmp ? "true" : "false");
    sb.Append(",\"inDataWin\":").Append(hasEmbeddedAudio ? "true" : "false");
    sb.Append(",\"bytes\":").Append(len);
    sb.Append('}');
}
sb.Append("],\"fonts\":[");
first = true;
for (int i = 0; i < Data.Fonts.Count; i++)
{
    UndertaleFont f = Data.Fonts[i];
    if (f == null || f.Name == null) continue;
    if (!first) sb.Append(',');
    first = false;
    sb.Append("{\"i\":").Append(i);
    sb.Append(",\"name\":\"").Append(Esc(f.Name.Content)).Append('"');
    sb.Append(",\"displayName\":\"").Append(f.DisplayName != null ? Esc(f.DisplayName.Content) : "").Append('"');
    sb.Append(",\"emSize\":").Append(f.EmSize);
    sb.Append(",\"bold\":").Append(f.Bold ? "true" : "false");
    sb.Append(",\"italic\":").Append(f.Italic ? "true" : "false");
    sb.Append(",\"charset\":").Append(f.Charset);
    sb.Append(",\"antiAliasing\":").Append(f.AntiAliasing);
    sb.Append(",\"scaleX\":").Append(f.ScaleX);
    sb.Append(",\"scaleY\":").Append(f.ScaleY);
    sb.Append(",\"lineHeight\":").Append(f.LineHeight);
    sb.Append(",\"ascender\":").Append(f.Ascender);
    sb.Append(",\"ascenderOffset\":").Append(f.AscenderOffset);
    sb.Append(",\"rangeStart\":").Append(f.RangeStart);
    sb.Append(",\"rangeEnd\":").Append(f.RangeEnd);
    sb.Append(",\"glyphCount\":").Append(f.Glyphs != null ? f.Glyphs.Count : 0);
    string tw = "0", th = "0", tsx = "0", tsy = "0", tsw = "0", tsh = "0";
    if (f.Texture != null)
    {
        tw = f.Texture.TargetWidth.ToString();
        th = f.Texture.TargetHeight.ToString();
        tsx = f.Texture.SourceX.ToString();
        tsy = f.Texture.SourceY.ToString();
        tsw = f.Texture.SourceWidth.ToString();
        tsh = f.Texture.SourceHeight.ToString();
    }
    sb.Append(",\"tex\":{\"tw\":").Append(tw).Append(",\"th\":").Append(th)
      .Append(",\"sx\":").Append(tsx).Append(",\"sy\":").Append(tsy)
      .Append(",\"sw\":").Append(tsw).Append(",\"sh\":").Append(tsh).Append('}');
    sb.Append('}');
}
sb.Append("]}");

File.WriteAllText(Path.Combine(outRoot, "probe.json"), sb.ToString(), new UTF8Encoding(false));
Console.WriteLine("[probe] sounds=" + Data.Sounds.Count + " fonts=" + Data.Fonts.Count);

// 本機（csx 腳本作用域）函式：JSON 字串轉義
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
