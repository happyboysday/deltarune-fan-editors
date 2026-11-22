@echo off
setlocal
cd /d "%~dp0"
title DELTARUNE Scene Studio V1.0
:start
if defined PYTHON (
  "%PYTHON%" -B -X utf8 studio_server.py --open %*
) else (
  py -3 -B -X utf8 studio_server.py --open %*
)
if "%errorlevel%"=="3" goto start
exit /b %errorlevel%
