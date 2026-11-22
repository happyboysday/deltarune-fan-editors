// probe_sprites.csx — 列出 data.win 內所有 Sprite 的完整結構資訊 + 物件→sprite 引用（唯讀）。
// 由 extract.py 呼叫：
//   UndertaleModCli.exe load <data.win> -s <abs>/probe_sprites.csx
// 環境變數：
//   UTMT_OUT      輸出目錄（必填）
//   UTMT_CHAPTER  章節標籤（例：ch5），只寫進輸出檔方便比對
// 產出：<UTMT_OUT>/sprites.json
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using UndertaleModLib;
using UndertaleModLib.Models;

EnsureDataLoaded();

string outRoot = Environment.GetEnvironmentVariable("UTMT_OUT");
if (String.IsNullOrEmpty(outRoot)) outRoot = Path.Combine(Directory.GetCurrentDirectory(), "utmt_sprites_probe");
Directory.CreateDirectory(outRoot);
string chapter = Environment.GetEnvironmentVariable("UTMT_CHAPTER");
if (chapter == null) chapter = "";

var sb = new StringBuilder(1 << 20);
sb.Append("{\"chapter\":\"").Append(Esc(chapter)).Append('"');
sb.Append(",\"spriteCount\":").Append(Data.Sprites != null ? Data.Sprites.Count : 0);
sb.Append(",\"sprites\":[");

bool first = true;
int frameTotal = 0;
if (Data.Sprites != null)
{
    for (int i = 0; i < Data.Sprites.Count; i++)
    {
        UndertaleSprite s = Data.Sprites[i];
        if (s == null || s.Name == null) continue;
        if (!first) sb.Append(',');
        first = false;

        int fc = 0;
        try { fc = s.Textures != null ? s.Textures.Count : 0; } catch { }
        frameTotal += fc;

        sb.Append("{\"i\":").Append(i);
        sb.Append(",\"name\":\"").Append(Esc(s.Name.Content)).Append('"');
        sb.Append(",\"w\":").Append(s.Width);
        sb.Append(",\"h\":").Append(s.Height);
        sb.Append(",\"ox\":").Append(s.OriginX);
        sb.Append(",\"oy\":").Append(s.OriginY);
        sb.Append(",\"ml\":").Append(s.MarginLeft);
        sb.Append(",\"mr\":").Append(s.MarginRight);
        sb.Append(",\"mt\":").Append(s.MarginTop);
        sb.Append(",\"mb\":").Append(s.MarginBottom);
        sb.Append(",\"transparent\":").Append(s.Transparent ? "true" : "false");
        sb.Append(",\"smooth\":").Append(s.Smooth ? "true" : "false");
        sb.Append(",\"preload\":").Append(s.Preload ? "true" : "false");
        string typeName = "";
        try { typeName = s.SSpriteType.ToString(); } catch { }
        sb.Append(",\"type\":\"").Append(Esc(typeName)).Append('"');

        // GMS2 sprite 播放速度（GameMaker 2 精靈編輯器的 Animation Speed）
        string ps = "null", pst = "null";
        try { ps = s.GMS2PlaybackSpeed.ToString(System.Globalization.CultureInfo.InvariantCulture); } catch { }
        try { pst = ((int)s.GMS2PlaybackSpeedType).ToString(); } catch { }
        sb.Append(",\"playbackSpeed\":").Append(ps);
        sb.Append(",\"playbackType\":").Append(pst);

        sb.Append(",\"frameCount\":").Append(fc);
        sb.Append(",\"frames\":[");
        for (int f = 0; f < fc; f++)
        {
            if (f > 0) sb.Append(',');
            bool wrote = false;
            try
            {
                var entry = s.Textures[f];
                if (entry != null && entry.Texture != null)
                {
                    var t = entry.Texture;
                    sb.Append("{\"page\":\"").Append(t.TexturePage != null && t.TexturePage.Name != null ? Esc(t.TexturePage.Name.Content) : "").Append('"');
                    sb.Append(",\"sx\":").Append(t.SourceX).Append(",\"sy\":").Append(t.SourceY);
                    sb.Append(",\"sw\":").Append(t.SourceWidth).Append(",\"sh\":").Append(t.SourceHeight);
                    sb.Append(",\"tx\":").Append(t.TargetX).Append(",\"ty\":").Append(t.TargetY);
                    sb.Append(",\"tw\":").Append(t.TargetWidth).Append(",\"th\":").Append(t.TargetHeight);
                    sb.Append(",\"bw\":").Append(t.BoundingWidth).Append(",\"bh\":").Append(t.BoundingHeight);
                    sb.Append('}');
                    wrote = true;
                }
            }
            catch { }
            if (!wrote) sb.Append("null");
        }
        sb.Append("]}");
    }
}
sb.Append(']');

// 物件 → sprite 引用（用於推斷敵人/UI 歸屬）
sb.Append(",\"objects\":[");
first = true;
if (Data.GameObjects != null)
{
    for (int i = 0; i < Data.GameObjects.Count; i++)
    {
        UndertaleGameObject o = Data.GameObjects[i];
        if (o == null || o.Name == null) continue;
        string spr = null;
        try { if (o.Sprite != null && o.Sprite.Name != null) spr = o.Sprite.Name.Content; } catch { }
        if (spr == null) continue;
        if (!first) sb.Append(',');
        first = false;
        sb.Append("{\"name\":\"").Append(Esc(o.Name.Content)).Append("\",\"sprite\":\"").Append(Esc(spr)).Append('"');
        sb.Append(",\"visible\":").Append(o.Visible ? "true" : "false").Append('}');
    }
}
sb.Append(']');

// GMS2 Sequence（少數精靈動畫會用 sequence，播放速度在此）
sb.Append(",\"sequences\":[");
first = true;
if (Data.Sequences != null)
{
    for (int i = 0; i < Data.Sequences.Count; i++)
    {
        UndertaleSequence q = Data.Sequences[i];
        if (q == null || q.Name == null) continue;
        if (!first) sb.Append(',');
        first = false;
        sb.Append("{\"name\":\"").Append(Esc(q.Name.Content)).Append('"');
        string qps = "null";
        try { qps = q.PlaybackSpeed.ToString(System.Globalization.CultureInfo.InvariantCulture); } catch { }
        sb.Append(",\"playbackSpeed\":").Append(qps);
        string ql = "0";
        try { ql = q.Length.ToString(System.Globalization.CultureInfo.InvariantCulture); } catch { }
        sb.Append(",\"length\":").Append(ql);
        sb.Append(",\"width\":").Append(q.Width).Append(",\"height\":").Append(q.Height).Append('}');
    }
}
sb.Append("]}");

File.WriteAllText(Path.Combine(outRoot, "sprites.json"), sb.ToString(), new UTF8Encoding(false));
Console.WriteLine("[probe_sprites] chapter=" + chapter + " sprites=" + (Data.Sprites != null ? Data.Sprites.Count : 0)
    + " frames=" + frameTotal + " objects=" + (Data.GameObjects != null ? Data.GameObjects.Count : 0)
    + " sequences=" + (Data.Sequences != null ? Data.Sequences.Count : 0));

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
