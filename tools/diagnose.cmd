@echo off
rem ===========================================================================
rem dsh-hot-restart :: one-click self check (double-click me)
rem ---------------------------------------------------------------------------
rem Produces ONE self-contained report file on the Desktop and opens it.
rem Read-only: it never closes, restarts or kills anything.
rem Keep this file ASCII-only: cmd.exe reads .cmd in the OEM code page.
rem ===========================================================================
setlocal
title dsh-hot-restart self check
echo.
echo dsh-hot-restart self check - read only, nothing gets closed or restarted.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0diagnose.ps1"
set RC=%ERRORLEVEL%
echo.
if not "%RC%"=="0" echo [warn] diagnose.ps1 exited with code %RC%
echo Done. Send the report file that just opened in Notepad.
echo.
pause
