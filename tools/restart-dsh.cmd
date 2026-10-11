@echo off
rem ===========================================================================
rem  dsh-hot-restart :: restart DSH from a terminal (prints progress)
rem
rem  For a silent, window-free restart just double-click tools\restart-dsh.vbs
rem  instead - a .cmd always opens a console window.
rem ===========================================================================
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart-dsh.ps1" %*
echo.
pause
