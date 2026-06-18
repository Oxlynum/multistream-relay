# Building slimcast-obs

## Prerequisites

### macOS (Apple Silicon)

1. **Xcode Command Line Tools**
   ```bash
   xcode-select --install
   ```

2. **CMake** (≥ 3.26)
   ```bash
   brew install cmake
   ```

3. **OBS Studio** — install from https://obsproject.com/download  
   The build system locates Qt6 and the OBS SDK inside `/Applications/OBS.app` automatically.

### Windows (64-bit)

1. **Visual Studio 2022** with C++ desktop workload
2. **CMake** ≥ 3.26 (bundled with VS or from cmake.org)
3. **OBS Studio** installed to `C:\Program Files\obs-studio`

---

## Build

### macOS

```bash
cd slimcast-obs
cmake --preset macos-arm64
cmake --build --preset macos-arm64
```

Install into OBS:

```bash
cmake --install build/macos-arm64 \
  --prefix "$HOME/Library/Application Support/obs-studio/plugins"
```

Restart OBS — **Docks → SlimCast** will appear.

### Windows

```bat
cd slimcast-obs
cmake --preset windows-x64
cmake --build --preset windows-x64 --config RelWithDebInfo
cmake --install build\windows-x64 --config RelWithDebInfo ^
      --prefix "%APPDATA%\obs-studio\plugins"
```

Restart OBS — **Docks → SlimCast** will appear.

---

## Installer packages

### macOS `.pkg`

```bash
bash installers/macos/build-installer.sh
```

Output: `slimcast-obs-2.0.0-macOS.pkg` — double-click to install.

### Windows `.exe`

```bat
cmake --install build\windows-x64 --config RelWithDebInfo ^
      --prefix installers\windows\staging
"%PROGRAMFILES(X86)%\NSIS\makensis.exe" installers\windows\installer.nsi
```

Output: `slimcast-obs-2.0.0-Windows-x64.exe` — double-click to install.

---

## Using the plugin

1. Sign up at **slimcast.com** and get your API key from the dashboard.
2. Open OBS → **Docks → SlimCast**.
3. Paste your API key and click **Save**.
4. Click **Start Streaming** in OBS — your streaming server starts automatically and all your configured platforms go live.

The dock shows credit balance, per-platform status, and warns when you're under 30 minutes remaining.
