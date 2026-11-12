@echo off
rem Starts Retro Pokies as a desktop app (an SDL window, no browser or server needed). Double-click it, or drop a ROM folder or zip on it.
rem The first run installs the window library (SDL, about 7 MB) into app\node_modules; it needs Node.js 22 or newer.
rem Games come from the roms folder next to this file, or from the folder or ROM zip given.
setlocal
set "app=%~dp0app"
set "node=%app%\node\node.exe"
if not exist "%node%" set "node=node"
"%node%" -e "process.exit(+process.versions.node.split(\".\")[0] >= 22 ? 0 : 1)" >nul 2>&1
if errorlevel 1 (
  echo Retro Pokies needs Node.js 22 or newer. Get the LTS installer from https://nodejs.org/ and run this again.
  pause
  exit /b 1
)
if not exist "%app%\node_modules\@kmamal\sdl" (
  echo First run: installing the window library ^(SDL, about 7 MB^)...
  call npm --prefix "%app%" install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo Could not install it. Check the internet connection, then try again.
    pause
    exit /b 1
  )
)
rem The game runs on its own, without this window: this window closes once it has started (if it fails to start, the reason is shown here).
"%node%" "%app%\bin\launch-detached.js" "%app%\src\main.js" %*
if errorlevel 1 pause
