// export_fonts.csx — 匯出指定點陣字體：字形貼圖 PNG + 字形表 JSON。
// 由 extract_fonts.py 呼叫：
//   set UTMT_FONT_OUT=<assets/fonts 的絕對路徑>
//   set UTMT_FONT_LIST=<UTF-8 清單檔，每行 "字體名|輸出目錄名"（可 # 註解）>
//   set UTMT_CHAPTER=<章節標記>
//   set UTMT_SKIP_EXISTING=1 → 已存在的輸出目錄跳過
//   UndertaleModCli.exe load <data.win> -s export_fonts.csx
// 輸出：<UTMT_FONT_OUT>/<out>/glyphs.png
//       <UTMT_FONT_OUT>/<out>/glyphs.json
//       <UTMT_FONT_OUT>/<out>/meta.txt
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Linq;
using UndertaleModLib;
using UndertaleModLib.Models;
using UndertaleModLib.Util;

EnsureDataLoaded();

string fontOut = Environment.GetEnvironmentVariable("UTMT_FONT_OUT");
if (String.IsNullOrEmpty(fontOut))
{
    Console.WriteLine("[font] UTMT_FONT_OUT not set, abort");
    return;
}
string listPath = Environment.GetEnvironmentVariable("UTMT_FONT_LIST");
if (String.IsNullOrEmpty(listPath) || !File.Exists(listPath))
{
    Console.WriteLine("[font] UTMT_FONT_LIST missing, abort");
    return;
}
string chapterTag = Environment.GetEnvironmentVariable("UTMT_CHAPTER");
if (String.IsNullOrEmpty(chapterTag)) chapterTag = "unknown";
bool skipExisting = Environment.GetEnvironmentVariable("UTMT_SKIP_EXISTING") == "1";

Directory.CreateDirectory(fontOut);

var wanted = new List<string[]>();
foreach (string raw in File.ReadAllLines(listPath))
{
    string line = raw.Trim();
    if (line.Length == 0 || line.StartsWith("#")) continue;
    string[] parts = line.Split('|');
    string fname = parts[0].Trim();
    string outName = parts.Length > 1 && parts[1].Trim().Length > 0 ? parts[1].Trim() : fname;
    wanted.Add(new string[] { fname, outName });
}

var byName = new Dictionary<string, UndertaleFont>();
foreach (var f in Data.Fonts)
{
    if (f != null && f.Name != null && !byName.ContainsKey(f.Name.Content))
        byName[f.Name.Content] = f;
}

int ok = 0, skip = 0, fail = 0, missing = 0;
using (TextureWorker worker = new())
{
    foreach (string[] item in wanted)
    {
        string name = item[0], outName = item[1];
        UndertaleFont font;
        if (!byName.TryGetValue(name, out font))
        {
            Console.WriteLine("[font] missing: " + name);
            missing++;
            continue;
        }
        string dir = Path.Combine(fontOut, outName);
        string pngPath = Path.Combine(dir, "glyphs.png");
        string jsonPath = Path.Combine(dir, "glyphs.json");
        if (skipExisting && File.Exists(pngPath) && File.Exists(jsonPath))
        {
            skip++;
            continue;
        }
        try
        {
            Directory.CreateDirectory(dir);

            UndertaleTexturePageItem tex = font.Texture;
            if (tex == null)
            {
                Console.WriteLine("[font] no texture: " + name);
                fail++;
                continue;
            }

            // 匯出字體貼圖（字體實際使用區域，不含 padding）
            worker.ExportAsPNG(tex, pngPath, name + ":glyphs", false);

            // glyph.Source* 是相對「字體貼圖頁項目」的座標（0..SourceWidth），
            // 不是整張 texture page 的絕對座標，因此不需再減 tex.SourceX/Y。
            double sx = tex.SourceWidth > 0 ? (double)tex.TargetWidth / tex.SourceWidth : 1.0;
            double sy = tex.SourceHeight > 0 ? (double)tex.TargetHeight / tex.SourceHeight : 1.0;
            int imgW = tex.TargetWidth;
            int imgH = tex.TargetHeight;

            var glyphs = font.Glyphs;
            int glyphCount = glyphs != null ? glyphs.Count : 0;

            // LineHeight 在 DELTARUNE 常為 0，用字形下緣推算後備值
            int maxBottom = 0, maxW = 0, maxH = 0;
            if (glyphs != null)
            {
                foreach (var g in glyphs)
                {
                    if (g == null || g.SourceWidth == 0) continue;
                    int bottom = (int)g.SourceHeight - (int)g.Offset;
                    if (bottom > maxBottom) maxBottom = bottom;
                    if (g.SourceWidth > maxW) maxW = g.SourceWidth;
                    if (g.SourceHeight > maxH) maxH = g.SourceHeight;
                }
            }
            int lineHeight = (int)font.LineHeight;
            if (lineHeight <= 0) lineHeight = maxBottom > 0 ? maxBottom : (int)Math.Ceiling(font.EmSize);
            float emSize = font.EmSize;
            int emInt = (int)Math.Round(emSize);

            var sb = new StringBuilder(1 << 21);
            sb.Append("{\"format\":\"dr-battle-font/1\"");
            sb.Append(",\"name\":").Append(J(outName));
            sb.Append(",\"sourceFont\":").Append(J(name));
            sb.Append(",\"displayName\":").Append(J(font.DisplayName != null ? font.DisplayName.Content : ""));
            sb.Append(",\"chapter\":").Append(J(chapterTag));
            sb.Append(",\"size\":").Append(emInt);
            sb.Append(",\"emSize\":").Append(F(emSize));
            sb.Append(",\"lineHeight\":").Append(lineHeight);
            sb.Append(",\"lineHeightRaw\":").Append((int)font.LineHeight);
            sb.Append(",\"ascender\":").Append((int)font.Ascender);
            sb.Append(",\"ascenderOffset\":").Append(font.AscenderOffset);
            sb.Append(",\"scaleX\":").Append(F(font.ScaleX));
            sb.Append(",\"scaleY\":").Append(F(font.ScaleY));
            sb.Append(",\"bold\":").Append(font.Bold ? "true" : "false");
            sb.Append(",\"italic\":").Append(font.Italic ? "true" : "false");
            sb.Append(",\"antiAliasing\":").Append((int)font.AntiAliasing);
            sb.Append(",\"rangeStart\":").Append((int)font.RangeStart);
            sb.Append(",\"rangeEnd\":").Append((long)font.RangeEnd);
            sb.Append(",\"maxGlyphWidth\":").Append(maxW);
            sb.Append(",\"maxGlyphHeight\":").Append(maxH);
            sb.Append(",\"image\":{\"file\":\"glyphs.png\",\"w\":").Append(imgW).Append(",\"h\":").Append(imgH)
              .Append(",\"scaleX\":").Append(F(sx))
              .Append(",\"scaleY\":").Append(F(sy)).Append('}');
            sb.Append(",\"glyphCount\":").Append(glyphCount);
            sb.Append(",\"glyphs\":{");
            bool first = true;
            if (glyphs != null)
            {
                foreach (var g in glyphs)
                {
                    if (g == null) continue;
                    if (!first) sb.Append(',');
                    first = false;
                    int cc = (int)g.Character;
                    int gx = (int)Math.Round(g.SourceX * sx);
                    int gy = (int)Math.Round(g.SourceY * sy);
                    int gw = (int)Math.Round(g.SourceWidth * sx);
                    int gh = (int)Math.Round(g.SourceHeight * sy);
                    sb.Append('"').Append(cc).Append("\":{");
                    sb.Append("\"char\":").Append(J(CharToString(g.Character)));
                    sb.Append(",\"x\":").Append(gx).Append(",\"y\":").Append(gy);
                    sb.Append(",\"w\":").Append(gw).Append(",\"h\":").Append(gh);
                    sb.Append(",\"shift\":").Append((int)g.Shift);
                    sb.Append(",\"offset\":").Append((int)g.Offset);
                    if (g.Kerning != null && g.Kerning.Count > 0)
                    {
                        sb.Append(",\"kerning\":[");
                        bool kfirst = true;
                        foreach (var k in g.Kerning)
                        {
                            if (k == null) continue;
                            if (!kfirst) sb.Append(',');
                            kfirst = false;
                            sb.Append('[').Append((int)k.Character).Append(',').Append((int)k.ShiftModifier).Append(']');
                        }
                        sb.Append(']');
                    }
                    sb.Append('}');
                }
            }
            sb.Append("}}");
            File.WriteAllText(jsonPath, sb.ToString(), new UTF8Encoding(false));

            var meta = new StringBuilder();
            meta.Append("name=").Append(outName).Append('\n');
            meta.Append("source_font=").Append(name).Append('\n');
            meta.Append("chapter=").Append(chapterTag).Append('\n');
            meta.Append("png_w=").Append(imgW).Append('\n');
            meta.Append("png_h=").Append(imgH).Append('\n');
            meta.Append("glyphs=").Append(glyphCount).Append('\n');
            meta.Append("em_size=").Append(F(emSize)).Append('\n');
            meta.Append("line_height=").Append(lineHeight).Append('\n');
            File.WriteAllText(Path.Combine(dir, "meta.txt"), meta.ToString(), new UTF8Encoding(false));

            Console.WriteLine("[font] ok: " + name + " -> " + outName
                + " glyphs=" + glyphCount + " img=" + imgW + "x" + imgH
                + " em=" + emInt + " lh=" + lineHeight);
            ok++;
        }
        catch (Exception e)
        {
            Console.WriteLine("[font] FAIL " + name + " : " + e.GetType().Name + ": " + e.Message);
            fail++;
        }
    }
}
Console.WriteLine("[font] chapter=" + chapterTag + " ok=" + ok + " skip=" + skip + " fail=" + fail + " missing=" + missing);

static string CharToString(ushort c)
{
    try { return char.ConvertFromUtf32(c); } catch { return ""; }
}

static string F(float v)
{
    return v.ToString("0.#####", System.Globalization.CultureInfo.InvariantCulture);
}

static string F(double v)
{
    return v.ToString("0.#####", System.Globalization.CultureInfo.InvariantCulture);
}

static string J(string s)
{
    if (String.IsNullOrEmpty(s)) return "\"\"";
    var b = new StringBuilder(s.Length + 8);
    b.Append('"');
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
    b.Append('"');
    return b.ToString();
}
