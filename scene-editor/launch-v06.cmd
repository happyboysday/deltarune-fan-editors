@echo off
rem Superseded by launch-v1.cmd. Keep this entry point for existing shortcuts.
call "%~dp0launch-v1.cmd" %*
exit /b %errorlevel%
