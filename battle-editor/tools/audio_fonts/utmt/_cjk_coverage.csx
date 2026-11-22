// _cjk_coverage.csx — 開發分析用：統計各字體對一份 UTF-8 字元清單的覆蓋率。
//   set UTMT_CHARS=<UTF-8 檔，第一行為字串>
using System;
using System.IO;
using System.Collections.Generic;
using System.Text;
using UndertaleModLib;
using UndertaleModLib.Models;

EnsureDataLoaded();

string charsPath = Environment.GetEnvironmentVariable("UTMT_CHARS");
string probe = "";
if (!String.IsNullOrEmpty(charsPath) && File.Exists(charsPath))
{
    string[] lines = File.ReadAllLines(charsPath, Encoding.UTF8);
    probe = lines[0];
}
if (probe.Length == 0) { Console.WriteLine("[cov] no chars"); return; }
Console.WriteLine("[cov] probe chars=" + probe.Length + " file=" + Path.GetFileName(FilePath));

var wanted = new HashSet<int>();
foreach (char c in probe) wanted.Add((int)c);

foreach (var f in Data.Fonts)
{
    if (f == null || f.Name == null) continue;
    var have = new HashSet<int>();
    int maxW = 0;
    foreach (var g in f.Glyphs)
    {
        if (g == null || g.SourceWidth == 0) continue;
        have.Add((int)g.Character);
        if (g.SourceWidth > maxW) maxW = g.SourceWidth;
    }
    int hit = 0;
    var miss = new StringBuilder();
    foreach (int c in wanted)
    {
        if (have.Contains(c)) hit++; else miss.Append(char.ConvertFromUtf32(c));
    }
    Console.WriteLine("[cov] " + f.Name.Content + " hit=" + hit + "/" + wanted.Count
        + " pct=" + (100.0 * hit / wanted.Count).ToString("0.0")
        + " glyphs=" + f.Glyphs.Count + " maxW=" + maxW);
}
