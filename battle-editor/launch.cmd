@echo off
REM ===========================================================================
REM  DR Battle Editor 啟動腳本
REM  雙擊本檔即可在 127.0.0.1:18900 啟動開發伺服器並開啟瀏覽器。
REM  需要 Python 3.11（python 需在 PATH 中）。
REM
REM  參數會原樣轉傳給 serve.py，例如：
REM    launch.cmd --works works\my-boss          使用版控中的作品根
REM    launch.cmd --works D:\DeltaruneWorks\works\doppeldoll
REM    launch.cmd --port 18901 --works works\my-boss
REM    launch.cmd --quiet                        不印每個請求的 log
REM  也可以只設環境變數（--works 優先於 DR_WORKS）：
REM    set DR_WORKS=works\my-boss
REM    launch.cmd
REM  說明見 works\README.md。
REM ===========================================================================
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================================
echo   DR Battle Editor
echo ============================================================
echo.

where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] 找不到 python，請先安裝 Python 3.11 並加入 PATH。
  echo.
  pause
  exit /b 1
)

if defined DR_WORKS echo [INFO] DR_WORKS=%DR_WORKS%
echo.

REM --open：伺服器啟動後自動開啟瀏覽器（若 %* 已含 --open 重複也無妨）
python serve.py --open %*
set EXITCODE=%errorlevel%

echo.
if not "%EXITCODE%"=="0" (
  echo [WARN] 伺服器以退出碼 %EXITCODE% 結束，請檢查上方訊息。
) else (
  echo 伺服器已停止。
)
echo.
pause
endlocal
