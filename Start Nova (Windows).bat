@echo off
setlocal
cd /d "%~dp0"
title Nova AI
set "NODE="
where node >nul 2>nul && set "NODE=node"
if not defined NODE set "NODE=%ProgramFiles%\nodejs\node.exe"
if not exist ".next\BUILD_ID" goto notinstalled
"%NODE%" -e "fetch('http://127.0.0.1:3000/api/pair').then(()=>process.exit(0),()=>process.exit(1))" >nul 2>nul && goto running
echo Nova AI is running. Keep this window open - you can minimize it. Close it to stop Nova.
"%NODE%" node_modules\next\dist\bin\next start -H 127.0.0.1 -p 3000
pause
exit /b 0
:running
echo Nova is already running.
timeout /t 3 >nul
exit /b 0
:notinstalled
echo Nova isn't installed yet: double-click "Install Nova (Windows).bat" first.
pause
exit /b 1
