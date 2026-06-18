@echo off
title MikroTik Ops Panel
cd /d "%~dp0"
echo ============================================================
echo   MikroTik Ops Panel
echo ============================================================
echo.

if not exist "server.js" goto nofiles
if not exist "lib\routeros-api.js" goto nofiles
if not exist "public\index.html" goto nofiles

where node >nul 2>nul
if errorlevel 1 goto nonode

for /f "tokens=*" %%v in ('node -v') do set NODEV=%%v
echo [OK] Node.js %NODEV% detected.

if not exist ".env" copy ".env.example" ".env" >nul

echo [OK] Starting the server... a browser tab will open at http://localhost:3000
echo.
echo   First run? Log in with  admin / admin , then open Settings and enter
echo   your MikroTik IP, username and password under "MikroTik access" and
echo   click "Test connection". No file editing needed.
echo.
echo   (Advanced options like AUTO_SUSPEND can still be edited in the .env file.)
echo.
echo Keep THIS window open while you use the panel.  Press Ctrl+C to stop.
echo ------------------------------------------------------------
set NODE_NO_WARNINGS=1
node server.js
echo ------------------------------------------------------------
echo.
echo The server has stopped. Any error is shown above.
echo You can also run diagnose.bat to save details to mikrotik-log.txt
echo.
pause
goto end

:nonode
echo [X] Node.js is not installed or not on PATH.
echo     Install the LTS version from https://nodejs.org then run this again.
echo.
pause
goto end

:nofiles
echo [X] Required files are missing from this folder.
echo     Extract the WHOLE zip and run this file next to server.js,
echo     the lib folder and the public folder.
echo.
pause
goto end

:end
