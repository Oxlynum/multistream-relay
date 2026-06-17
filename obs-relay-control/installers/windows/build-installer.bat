@echo off
REM installers\windows\build-installer.bat
REM
REM Builds the plugin and produces a Windows .exe installer.
REM Run from the obs-relay-control\ directory:
REM     installers\windows\build-installer.bat
REM
REM Requirements:
REM   - Visual Studio 2022 with C++ desktop workload
REM   - CMake 3.22+  (in PATH)
REM   - NSIS 3.x     (makensis.exe in PATH, or at default install location)
REM   - OBS Studio installed at C:\Program Files\obs-studio  (or set OBS_ROOT)

setlocal EnableDelayedExpansion

REM ── Locate NSIS ──────────────────────────────────────────────────────────────
set "MAKENSIS="
where makensis >nul 2>&1 && set "MAKENSIS=makensis"
if not defined MAKENSIS (
    if exist "C:\Program Files (x86)\NSIS\makensis.exe" (
        set "MAKENSIS=C:\Program Files (x86)\NSIS\makensis.exe"
    )
)
if not defined MAKENSIS (
    echo ERROR: makensis not found. Install NSIS from https://nsis.sourceforge.io/Download
    exit /b 1
)

REM ── Move to repo root (obs-relay-control\) ──────────────────────────────────
cd /d "%~dp0..\.."

REM ── Build ────────────────────────────────────────────────────────────────────
echo =^> Configuring...
cmake -B build -A x64 ^
    -DCMAKE_BUILD_TYPE=RelWithDebInfo
if errorlevel 1 ( echo Build configuration failed. & exit /b 1 )

echo =^> Building...
cmake --build build --config RelWithDebInfo
if errorlevel 1 ( echo Build failed. & exit /b 1 )

REM ── Stage ────────────────────────────────────────────────────────────────────
echo =^> Staging files...
if exist "installers\windows\staging" rmdir /s /q "installers\windows\staging"
cmake --install build --config RelWithDebInfo ^
    --prefix "installers\windows\staging"
if errorlevel 1 ( echo Install/stage step failed. & exit /b 1 )

REM ── NSIS ─────────────────────────────────────────────────────────────────────
echo =^> Creating installer...
"%MAKENSIS%" "installers\windows\installer.nsi"
if errorlevel 1 ( echo NSIS failed. & exit /b 1 )

echo.
echo Done: obs-relay-control-1.0.0-Windows-x64.exe
echo Run the .exe as Administrator to install. Restart OBS afterwards.
echo (Docks -^> Relay Control)
