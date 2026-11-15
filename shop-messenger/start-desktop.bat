@echo off
cd /d "%~dp0desktop"
if not exist node_modules (
  echo Installing... this needs internet the first time.
  call npm install
  if errorlevel 1 ( pause & exit /b 1 )
)
call npm start
