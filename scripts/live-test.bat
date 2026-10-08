@echo off
REM Live load test for SoundCloud Now Playing (Windows side).
REM
REM Why Windows: a Chrome running on Windows only listens on its own loopback, which
REM WSL cannot reach, and branded Chrome ignores the --load-extension command-line
REM switch (the test loads the extension over CDP instead, which needs
REM --enable-unsafe-extension-debugging).
REM
REM Usage:  live-test.bat  C:\path\to\soundcloud-nowplaying
setlocal
set EXTDIR=%~1
if "%EXTDIR%"=="" set EXTDIR=%~dp0..
set PORT=9228
set PROF=%TEMP%\scnp-prof%RANDOM%
set CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe
set NODE=C:\Program Files\nodejs\node.exe

if not exist "%CHROME%" set CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe

mkdir "%PROF%" 2>nul
start "" /b cmd /c ""%CHROME%" --headless=new --disable-gpu --no-first-run --no-default-browser-check --user-data-dir=%PROF% --remote-debugging-port=%PORT% --remote-allow-origins=* --enable-unsafe-extension-debugging --load-extension="%EXTDIR%" --no-sandbox about:blank > "%TEMP%\scnp-chrome.log" 2>&1"

ping -n 7 127.0.0.1 >nul
"%NODE%" "%~dp0..\tests\live-cdp.js" %PORT% "%EXTDIR%"
set RC=%ERRORLEVEL%

powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -match 'scnp-prof|remote-debugging-port=%PORT%' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1
rmdir /s /q "%PROF%" 2>nul
exit /b %RC%
