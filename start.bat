@echo off
title Pool Takeoff Harness
cd /d "%~dp0"

echo.
echo ========================================
echo   Pool Takeoff Harness
echo ========================================
echo.

REM Install dependencies if missing (check the folder, not a bogus file)
if not exist "node_modules\express" (
    echo Installing dependencies...
    call npm install
    echo.
)

REM Start the server (auto-opens browser)
node server.js

pause
