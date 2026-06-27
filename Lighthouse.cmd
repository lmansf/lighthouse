@echo off
rem ===========================================================================
rem  Lighthouse launcher (Windows).
rem
rem  Double-click this file. The first time, it installs and builds the app
rem  (a few minutes). Every time after, it just launches Lighthouse. No typing.
rem ===========================================================================
setlocal
cd /d "%~dp0"
title Lighthouse

rem --- Prefer the graphical setup window when PowerShell is available -----------
where powershell >nul 2>nul
if not errorlevel 1 if exist "%~dp0scripts\setup-gui.ps1" (
  start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\setup-gui.ps1"
  exit /b 0
)
rem --- Otherwise fall back to the console setup below ---------------------------

rem --- Node.js required ---------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Lighthouse needs Node.js, which isn't installed yet.
  echo   Opening the download page - install it, then double-click this file again.
  echo.
  start "" https://nodejs.org/en/download
  pause
  exit /b 1
)

rem --- First run: install dependencies -----------------------------------------
if not exist "node_modules\electron\" (
  echo.
  echo   First-time setup: installing Lighthouse. This can take a few minutes...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo   Install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

rem --- First run: build the app ------------------------------------------------
if not exist ".next\BUILD_ID" (
  echo.
  echo   Building Lighthouse...
  echo.
  call npm run build
  if errorlevel 1 (
    echo.
    echo   Build failed.
    pause
    exit /b 1
  )
)

rem --- Launch ------------------------------------------------------------------
echo.
echo   Launching Lighthouse...
echo   (You can minimize this window; closing it will close the app.)
echo.
call npm run electron

endlocal
