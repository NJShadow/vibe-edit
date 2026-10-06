@echo off
REM Start the Vibe Edit desktop app from source (double-click me).
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)
REM The desktop runtime (Electron 44) needs Node.js 22.12 or newer to install.
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)"
if errorlevel 1 (
  echo Vibe Edit needs Node.js 22.12 or newer. Update it from https://nodejs.org - the LTS version - and run this again.
  pause
  exit /b 1
)
REM Install (or update) the runtime when it is missing or not the version package.json asks for.
node -e "try{const w=require('./package.json').devDependencies.electron.replace(/[^0-9.]/g,'').split('.')[0],h=require('./node_modules/electron/package.json').version.split('.')[0];process.exit(w===h?0:1)}catch(e){process.exit(1)}"
if errorlevel 1 (
  echo Installing the desktop runtime - one time, needs internet...
  call npm install
  if errorlevel 1 (
    echo The install did not finish. Check your internet connection and try again.
    pause
    exit /b 1
  )
)
call npm start
if errorlevel 1 (
  echo.
  echo Vibe Edit stopped with an error - the messages above say why.
  pause
)
