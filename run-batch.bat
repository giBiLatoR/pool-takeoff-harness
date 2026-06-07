@echo off
title Pool Takeoff - Batch Validation
cd /d "%~dp0"
echo Running batch extraction over all plans...
echo (use:  run-batch.bat --only NAME   or   --limit N   to narrow)
echo.
node scripts/batch.js %*
echo.
echo Results written to results\  (per-file JSON + _summary.json)
pause
