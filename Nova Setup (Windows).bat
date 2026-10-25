@echo off
setlocal
cd /d "%~dp0"
title Nova Setup
set "NODE="
where node >nul 2>nul && set "NODE=node"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if defined NODE goto run
echo Getting Nova ready: installing Node.js, which Nova runs on.
echo This takes a minute. Click Yes if Windows asks.
where winget >nul 2>nul || goto manual
winget install -e --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements >nul 2>nul
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if defined NODE goto run
:manual
echo.
echo Please install Node.js - the LTS button - from the page that opens now,
echo then double-click this file again.
start "" "https://nodejs.org/en/download"
pause
exit /b 1
:run
start "" powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0setup\windows\launch.ps1"
exit /b 0
