@echo off
chcp 65001 >nul
rem Basic voice server: double-click to start. Keep this file in my-voice\recorder.
cd /d "%~dp0.."
if not exist ".venv\Scripts\python.exe" (
  echo [!] .venv 폴더를 찾을 수 없어요. 이 파일을 my-voice\recorder 폴더에 두고 실행해 주세요.
  pause
  exit /b
)
netstat -ano | findstr /r /c:"127.0.0.1:8777 .*LISTENING" >nul
if not errorlevel 1 (
  echo [!] 기본 목소리 서버가 이미 켜져 있어요. 새 파일을 쓰려면 켜져 있는 까만 창을 닫고 다시 실행해 주세요.
  start "" http://127.0.0.1:8777/
  pause
  exit /b
)
echo 기본 목소리 서버를 켜는 중이에요. 이 창은 닫지 마세요. (끌 때는 이 창을 닫으면 돼요)
start "" cmd /c "timeout /t 5 /nobreak >nul & start http://127.0.0.1:8777/"
".venv\Scripts\python.exe" recorder\server.py
pause
