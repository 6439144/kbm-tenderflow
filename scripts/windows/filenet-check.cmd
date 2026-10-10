@echo off
rem TenderFlow - IBM FileNet check on Windows, no build needed.
rem Runs services\api\src\tools\verify-filenet.ts with tsx against the FileNet settings in .env
rem (PASS / FAIL / SKIP per step, report in docs\evidence\filenet-verify-<time>.json, no secrets).
rem Usage: double-click, or from any folder:  scripts\windows\filenet-check.cmd
rem Needs Node.js 20.6 or newer (node --import) and "npm install" done once.
setlocal
cd /d "%~dp0..\.."
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required: https://nodejs.org
  goto :fail
)
if not exist "node_modules\tsx\package.json" (
  echo Dependencies are missing. Run:  npm install   in %CD%
  goto :fail
)
if not exist ".env" (
  echo No .env file in %CD%. Copy .env.example to .env and fill in the FILENET_* values.
  goto :fail
)
node --import tsx services\api\src\tools\verify-filenet.ts %*
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (echo FileNet check passed.) else (echo FileNet check found problems - see the FAIL lines above and the report in docs\evidence.)
rem Double-clicked (not run from a prompt): keep the window open to read the result.
echo %CMDCMDLINE% | findstr /i /c:"%~nx0" >nul && pause
endlocal & exit /b %RC%
:fail
echo %CMDCMDLINE% | findstr /i /c:"%~nx0" >nul && pause
endlocal & exit /b 1
