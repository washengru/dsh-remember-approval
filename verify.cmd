@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo  dsh-remember-approval  verification
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [FAIL] node not found in PATH.
  echo Install Node.js 22+ or run from a DSH environment.
  pause
  exit /b 1
)

echo [1/2] node version:
node -v
echo.

echo [2/2] syntax check + logic tests:
node --check index.js
if errorlevel 1 (
  echo [FAIL] syntax error in index.js
  pause
  exit /b 1
)
echo    syntax OK
echo.

node --test test/logic.test.mjs
set RESULT=%errorlevel%
echo.
if "%RESULT%"=="0" (
  echo [PASS] all logic tests passed.
) else (
  echo [FAIL] tests failed with exit code %RESULT%.
)
echo.
pause
exit /b %RESULT%
