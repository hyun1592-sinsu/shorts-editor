@echo off
rem 숏츠 자동 편집기 로컬 서버 실행 (작업 내용은 이 주소 기준으로 저장되므로 포트를 바꾸지 마세요)
cd /d "%~dp0"
start "" http://localhost:8765/
python -m http.server 8765 --bind 127.0.0.1
