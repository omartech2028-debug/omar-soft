@echo off
cd /d "%~dp0desktop"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22+ is required to BUILD the installer. Install it from https://nodejs.org then run this file again.
  pause
  exit /b 1
)
echo Building the installer. This needs internet and takes several minutes...
call npm install
if errorlevel 1 ( pause & exit /b 1 )
call npm run dist
if errorlevel 1 ( pause & exit /b 1 )
echo.
echo DONE. The installer is in:  desktop\dist
start "" "%~dp0desktop\dist"
pause
