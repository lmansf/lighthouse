@echo off
rem ===========================================================================
rem  Build the Lighthouse Windows installer.
rem
rem  Double-click this once on a Windows machine. It produces a standalone
rem  installer (.exe) in the "release" folder that you can share — end users
rem  double-click THAT to install Lighthouse, with no Node.js or build needed.
rem ===========================================================================
setlocal
cd /d "%~dp0"
title Build Lighthouse Installer

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Building the installer needs Node.js. Opening the download page...
  echo   Install it, then double-click this file again.
  echo.
  start "" https://nodejs.org/en/download
  pause
  exit /b 1
)

if not exist "node_modules\electron-builder\" (
  echo.
  echo   Installing build tools (a few minutes)...
  echo.
  call npm install
  if errorlevel 1 ( echo. & echo   Install failed. & pause & exit /b 1 )
)

echo.
echo   Building the app...
echo.
call npm run build
if errorlevel 1 ( echo. & echo   Build failed. & pause & exit /b 1 )

echo.
echo   Packaging the Windows installer (this can take several minutes)...
echo.
call npm run dist
if errorlevel 1 ( echo. & echo   Packaging failed. & pause & exit /b 1 )

echo.
echo   Done. The installer is in the "release" folder.
echo.
start "" "release"
pause
endlocal
