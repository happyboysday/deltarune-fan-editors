@echo off
chcp 65001 >nul
rem 战斗编辑器。素材目录默认用 fonts-assets（只有字体）；有完整素材库时把 --assets 改成它。
cd /d "%~dp0battle-editor"
python serve.py --open --assets "%~dp0fonts-assets" %*
pause
