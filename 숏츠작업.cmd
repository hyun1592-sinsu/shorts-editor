@echo off
rem Shorts editor: local server + editor app window + Claude Code, all at once.
rem Keep port 8765 and the same browser (Edge) - saved work lives in Edge for http://localhost:8765
cd /d "%~dp0"

rem 1) Local server (only if not already running)
netstat -ano | findstr /r /c:":8765 .*LISTENING" >nul
if errorlevel 1 (
  start "shorts-server" /min python -m http.server 8765 --bind 127.0.0.1
  timeout /t 1 /nobreak >nul
)

rem 2) Editor as an app window (no address bar)
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" (
  start "" "%EDGE%" --app=http://localhost:8765/
) else (
  start "" http://localhost:8765/
)

rem 3) Claude Code in this folder (Windows Terminal)
where wt >nul 2>nul
if errorlevel 1 (
  start "Claude Code" cmd /k claude
) else (
  start "" wt -d "%CD%" claude
)
