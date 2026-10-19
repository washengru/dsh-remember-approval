@echo off
setlocal
cd /d "%~dp0"

set "SRC=%~dp0"
set "PROFILE=%USERPROFILE%\.dsh\profiles\desktop"
set "DEST=%PROFILE%\node_modules\dsh-remember-approval"
set "PATCH=%PROFILE%\cordis.patch.yml"

echo [1/3] copy plugin ...
if not exist "%PROFILE%\node_modules" goto :fail
if exist "%DEST%" rd /s /q "%DEST%"
md "%DEST%" 2>nul
xcopy "%SRC%*" "%DEST%\" /E /I /Y /Q >nul
if not exist "%DEST%\index.js" goto :fail
echo       OK

echo [2/3] check patch layer ...
if not exist "%PATCH%" goto :fail

findstr /C:"id: remember-approval" "%PATCH%" >nul 2>nul
if not errorlevel 1 (
  echo       already mounted, skip
  goto :done
)

echo [3/3] mount ...
copy /Y "%PATCH%" "%PATCH%.bak" >nul
(
  echo - insert:
  echo     - id: remember-approval
  echo       name: dsh-remember-approval
)>>"%PATCH%"
if errorlevel 1 goto :fail
echo       OK - backup: cordis.patch.yml.bak

:done
echo.
echo DONE. Now fully quit and restart the DSH client.
echo.
pause
exit /b 0

:fail
echo.
echo FAILED - see messages above.
echo.
pause
exit /b 1
