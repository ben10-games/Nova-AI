@echo off
setlocal
cd /d "%~dp0"
title Nova AI setup
set "NODE="
where node >nul 2>nul && set "NODE=node"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if defined NODE goto run
echo Nova needs Node.js. Installing it now with winget, Windows' own app installer...
where winget >nul 2>nul || goto manual
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
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
"%NODE%" setup\setup.mjs
echo.
pause
