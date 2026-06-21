@echo off
title JEFF NETWORK SERVICE - Control Panel
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is required but was not found.
  echo   Please install Node.js (LTS) from https://nodejs.org then run this again.
  echo.
  pause
  exit /b 1
)

echo.
echo   ===========================================
echo    JEFF NETWORK SERVICE - Control Panel
echo   ===========================================
echo.
echo   Starting... keep this window open.
echo   Open your browser at:  http://localhost:3000
echo.

REM auto-open the browser after a moment
start "" cmd /c "timeout /t 3 >nul & start http://localhost:3000"

node server.js

echo.
echo   Panel stopped. You can close this window.
pause
