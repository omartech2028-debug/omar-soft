@echo off
chcp 65001 >nul
title Shop Messenger - Center
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install it from https://nodejs.org ^(version 22 or newer^) then run this file again.
  echo Node.js غير مثبت. ثبّته من https://nodejs.org ثم أعد تشغيل هذا الملف.
  pause
  exit /b 1
)
node --disable-warning=ExperimentalWarning server\main.js
pause
