@echo off
chcp 65001 >nul
rem 场景编辑器 V1.0。第一次启动会打开首次引导，可在设置页里自动检测或填写素材位置。
rem 战斗编辑器与字体素材已预先指好。
call "%~dp0scene-editor\launch-v1.cmd" --battle-root "%~dp0battle-editor" --battle-assets "%~dp0fonts-assets" %*
