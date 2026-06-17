#!/usr/bin/env bash
# installers/macos/build-installer.sh
#
# Builds the plugin and produces a macOS .pkg installer.
# Run from the obs-relay-control/ directory:
#   bash installers/macos/build-installer.sh
#
# Requirements: Xcode CLT, CMake, OBS.app at /Applications/OBS.app
# Output:  obs-relay-control-<version>-macOS.pkg  (in current directory)

set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root = obs-relay-control/

# ── Config ────────────────────────────────────────────────────────────────────
PLUGIN_ID="com.relaycontrol.obs-relay-control"
VERSION="1.0.0"
OUT_PKG="obs-relay-control-${VERSION}-macOS.pkg"

# OBS on macOS only loads plugins from the user Library, not the system Library.
# The .pkg payload stages the plugin under /Library/... (requires admin) and the
# postinstall script moves it into the current user's ~/Library/... afterwards.
SYSTEM_STAGE_SUBPATH="Library/Application Support/obs-relay-control-staging"

STAGING_DIR="$(pwd)/.staging-macos"
SCRIPTS_DIR="$(pwd)/.scripts-macos"
COMP_PKG="$(pwd)/.component.pkg"

# Pick the right preset for this machine (arm64 or x86_64)
case "$(uname -m)" in
    arm64)  PRESET="macos-arm64"  ;;
    x86_64) PRESET="macos-x86_64" ;;
    *)      PRESET="macos-arm64"  ;;
esac
BUILD_DIR="build/$PRESET"

# ── Clean ─────────────────────────────────────────────────────────────────────
rm -rf "$STAGING_DIR" "$SCRIPTS_DIR" "$COMP_PKG" "$OUT_PKG"
mkdir -p "$STAGING_DIR/$SYSTEM_STAGE_SUBPATH"
mkdir -p "$SCRIPTS_DIR"

# ── Build ─────────────────────────────────────────────────────────────────────
echo "==> Configuring ($PRESET)…"
cmake --preset "$PRESET"

echo "==> Building…"
cmake --build --preset "$PRESET"

# ── Stage payload ─────────────────────────────────────────────────────────────
echo "==> Staging files…"
cmake --install "$BUILD_DIR" \
    --config RelWithDebInfo \
    --prefix "$STAGING_DIR/$SYSTEM_STAGE_SUBPATH"

# ── postinstall script ────────────────────────────────────────────────────────
# Runs as root after the payload is dropped. Moves the plugin from the staging
# area into the current user's OBS plugins directory (the only path OBS scans).
cat > "$SCRIPTS_DIR/postinstall" << 'EOF'
#!/bin/bash
set -euo pipefail

CONSOLE_USER=$(stat -f "%Su" /dev/console)
if [ -z "$CONSOLE_USER" ] || [ "$CONSOLE_USER" = "root" ]; then
    exit 0
fi

USER_HOME=$(dscl . -read /Users/"$CONSOLE_USER" NFSHomeDirectory | awk '{print $2}')
OBS_PLUGINS="$USER_HOME/Library/Application Support/obs-studio/plugins"
STAGING="/Library/Application Support/obs-relay-control-staging"

mkdir -p "$OBS_PLUGINS"
rm -rf "$OBS_PLUGINS/obs-relay-control.plugin"
cp -rf "$STAGING/obs-relay-control.plugin" "$OBS_PLUGINS/"
chown -R "$CONSOLE_USER" "$OBS_PLUGINS/obs-relay-control.plugin"
rm -rf "$STAGING"

# Self-delete the .pkg — $PACKAGE_PATH is set by macOS Installer to the pkg path
if [ -n "${PACKAGE_PATH:-}" ] && [ -f "$PACKAGE_PATH" ]; then
    rm -f "$PACKAGE_PATH"
fi
EOF
chmod +x "$SCRIPTS_DIR/postinstall"

# ── Component package ─────────────────────────────────────────────────────────
echo "==> Creating component package…"
pkgbuild \
    --root             "$STAGING_DIR" \
    --scripts          "$SCRIPTS_DIR" \
    --identifier       "$PLUGIN_ID" \
    --version          "$VERSION" \
    --install-location "/" \
    "$COMP_PKG"

# ── Distribution package (wraps component with installer UI) ──────────────────
echo "==> Creating distribution package…"
productbuild \
    --distribution "$(dirname "$0")/distribution.xml" \
    --package-path "$(pwd)" \
    --version "$VERSION" \
    "$OUT_PKG"

# ── Cleanup ───────────────────────────────────────────────────────────────────
rm -rf "$STAGING_DIR" "$SCRIPTS_DIR" "$COMP_PKG"

echo ""
echo "Done: $OUT_PKG"
echo "Double-click the .pkg to install. Restart OBS afterwards."
echo "(Docks → Relay Control)"
