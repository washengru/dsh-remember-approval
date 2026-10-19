@echo off
setlocal EnableDelayedExpansion
chcp 437 >nul
cd /d "%~dp0"

echo ============================================
echo  dsh-remember-approval  -  GitHub publisher
echo ============================================
echo.

where git >nul 2>nul
if errorlevel 1 (
  echo [FAIL] git not found in PATH. Install Git for Windows first.
  pause
  exit /b 1
)

echo [1/6] checking git identity ...
set "GITNAME="
set "GITMAIL="
for /f "delims=" %%i in ('git config user.name 2^>nul') do set "GITNAME=%%i"
for /f "delims=" %%i in ('git config user.email 2^>nul') do set "GITMAIL=%%i"
if "!GITNAME!"=="" (
  echo       git user.name is not set.
  set /p GITNAME=      your name: 
  git config user.name "!GITNAME!"
)
if "!GITMAIL!"=="" (
  echo       git user.email is not set.
  set /p GITMAIL=      your email: 
  git config user.email "!GITMAIL!"
)
echo       OK

echo.
set "GHUSER="
set /p GHUSER=      GitHub username: 
if "!GHUSER!"=="" (
  echo [FAIL] username is required.
  pause
  exit /b 1
)
set "REPO=dsh-remember-approval"
set "REPOIN="
set /p REPOIN=      Repository name [dsh-remember-approval]: 
if not "!REPOIN!"=="" set "REPO=!REPOIN!"

echo.
echo [2/6] filling placeholders in package.json / LICENSE ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$u='%GHUSER%'; $enc=New-Object System.Text.UTF8Encoding($false); foreach($f in @('package.json','LICENSE')){ $p=Join-Path (Get-Location) $f; if(Test-Path -LiteralPath $p){ $c=[System.IO.File]::ReadAllText($p,[System.Text.Encoding]::UTF8); $c=$c -replace '<your name>',$u -replace '<your-github-name>',$u; [System.IO.File]::WriteAllText($p,$c,$enc) } }"
if errorlevel 1 goto :fail
echo       OK

echo.
echo [3/6] init repo and commit ...
if not exist ".git" (
  git init -b main >nul 2>nul
  if not exist ".git" git init >nul
)
git add -A
if errorlevel 1 goto :fail
git commit -m "feat: remember manually approved requests per session" >nul 2>nul
if errorlevel 1 echo       (nothing new to commit)

echo.
echo [4/6] locating remote repo ...
where gh >nul 2>nul
if not errorlevel 1 (
  gh repo view %GHUSER%/%REPO% >nul 2>nul
  if errorlevel 1 (
    echo       gh found - creating %GHUSER%/%REPO% ...
    gh repo create %GHUSER%/%REPO% --public --description "DSH plugin: remember manual approvals per session" --source . --remote origin --push
    if errorlevel 1 goto :fail
    goto :done
  )
  echo       remote repo already exists - continue
) else (
  echo       gh not found. Make sure you already created an EMPTY repo on GitHub
  echo       (no README, no .gitignore) named: %GHUSER%/%REPO%
)

git remote get-url origin >nul 2>nul
if errorlevel 1 (
  git remote add origin https://github.com/%GHUSER%/%REPO%.git
  if errorlevel 1 goto :fail
) else (
  git remote set-url origin https://github.com/%GHUSER%/%REPO%.git
  if errorlevel 1 goto :fail
)

echo.
echo [5/6] push ...
git push -u origin main
if errorlevel 1 goto :fail

:done
echo.
echo [6/6] DONE
echo       https://github.com/%GHUSER%/%REPO%
echo.
echo Reminder: check that debug.log did NOT get committed.
echo.
pause
exit /b 0

:fail
echo.
echo FAILED - see messages above.
pause
exit /b 1
