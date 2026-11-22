@echo off
rem Superseded by launch-v1.cmd. Keep the chapter page and its existing port.
call "%~dp0launch-v1.cmd" --chapter-ui --port 18947 %*
exit /b %errorlevel%
