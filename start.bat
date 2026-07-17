@echo off
cd /d %~dp0
echo ============================================
echo   Firmoo Exam Dashboard
echo ============================================
echo.
echo   Starting server... KEEP THIS WINDOW OPEN.
echo   Open browser:  http://127.0.0.1:5000
echo   Login:  admin / admin123
echo.
set PORT=5000
"C:\Users\Adam\.workbuddy\binaries\python\envs\default\Scripts\python.exe" server.py
echo.
echo [server stopped - if it closed by itself, the error is shown above]
pause
