#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGIN_DIR="$HOME/.gemini/config/plugins/desktop-context"
CDP_PORT="${AGY_CDP_PORT:-9333}"

echo "[context-pro] Installing plugin to $PLUGIN_DIR ..."

REPO_REAL="$(cd "$REPO_DIR" && pwd -P)"
mkdir -p "$PLUGIN_DIR"
PLUGIN_REAL="$(cd "$PLUGIN_DIR" && pwd -P)"

if [ "$REPO_REAL" != "$PLUGIN_REAL" ]; then
  mkdir -p "$PLUGIN_DIR/sidecars/context" "$PLUGIN_DIR/assets" "$PLUGIN_DIR/scripts"
  cp -f "$REPO_DIR/plugin.json" "$PLUGIN_DIR/plugin.json"
  [ -f "$REPO_DIR/LICENSE" ] && cp -f "$REPO_DIR/LICENSE" "$PLUGIN_DIR/LICENSE"
  [ -f "$REPO_DIR/README.md" ] && cp -f "$REPO_DIR/README.md" "$PLUGIN_DIR/README.md"
  [ -f "$REPO_DIR/README_ZH.md" ] && cp -f "$REPO_DIR/README_ZH.md" "$PLUGIN_DIR/README_ZH.md"
  cp -Rf "$REPO_DIR/assets/." "$PLUGIN_DIR/assets/"
  cp -Rf "$REPO_DIR/scripts/." "$PLUGIN_DIR/scripts/"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --exclude '__pycache__' --exclude '.data' "$REPO_DIR/sidecars/context/" "$PLUGIN_DIR/sidecars/context/"
  else
    cp -Rf "$REPO_DIR/sidecars/context/." "$PLUGIN_DIR/sidecars/context/"
  fi
  echo "[context-pro] Synced plugin files."
else
  echo "[context-pro] Already running from installed plugin directory."
fi

install_macos_launcher() {
  local app_bundle=""
  for candidate in "/Applications/Antigravity.app" "$HOME/Applications/Antigravity.app"; do
    if [ -d "$candidate" ]; then
      app_bundle="$candidate"
      break
    fi
  done

  if [ -z "$app_bundle" ]; then
    echo "[context-pro] Warning: Antigravity.app not found in /Applications or ~/Applications; skipping launcher."
    return 0
  fi

  local launcher_app="$HOME/Applications/Antigravity (Context Ring).app"
  local contents_dir="$launcher_app/Contents"
  local macos_dir="$contents_dir/MacOS"
  local res_dir="$contents_dir/Resources"

  mkdir -p "$macos_dir" "$res_dir"

  local icon_key=""
  local icns_src=""
  icns_src="$(find "$app_bundle/Contents/Resources" -maxdepth 1 -name '*.icns' 2>/dev/null | head -n 1 || true)"
  if [ -n "$icns_src" ] && [ -f "$icns_src" ]; then
    cp -f "$icns_src" "$res_dir/antigravity.icns"
    icon_key="  <key>CFBundleIconFile</key>
  <string>antigravity.icns</string>"
  fi

  cat > "$contents_dir/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>Antigravity (Context Ring)</string>
  <key>CFBundleExecutable</key>
  <string>launcher</string>
  <key>CFBundleIdentifier</key>
  <string>com.pigzzz.antigravity-context-ring-launcher</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Antigravity (Context Ring)</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>LSUIElement</key>
  <true/>
$icon_key
</dict>
</plist>
EOF

  cat > "$macos_dir/launcher" <<EOF
#!/usr/bin/env bash
set -e
exec open -a "$app_bundle" --args --remote-debugging-port=$CDP_PORT "\$@"
EOF
  chmod +x "$macos_dir/launcher"

  local cli_dir="$HOME/.local/bin"
  mkdir -p "$cli_dir"
  cat > "$cli_dir/antigravity-ring" <<EOF
#!/usr/bin/env bash
exec open -a "$app_bundle" --args --remote-debugging-port=$CDP_PORT "\$@"
EOF
  chmod +x "$cli_dir/antigravity-ring"

  echo "[context-pro] Created macOS CDP launcher: $launcher_app"
  echo "[context-pro] Created CLI wrapper: $cli_dir/antigravity-ring"
  echo ""
  echo "Next steps (macOS):"
  echo "  1. Quit Antigravity completely (Cmd + Q)."
  echo "  2. Launch \"Antigravity (Context Ring)\" from Spotlight or ~/Applications (you can pin it to your Dock)."
  echo "     Or run: open -a \"$launcher_app\""
}

install_linux_launcher() {
  local agy_bin=""
  agy_bin="$(command -v antigravity 2>/dev/null || true)"
  if [ -z "$agy_bin" ]; then
    for candidate in "/usr/bin/antigravity" "/usr/local/bin/antigravity" "/opt/Antigravity/antigravity"; do
      if [ -x "$candidate" ]; then
        agy_bin="$candidate"
        break
      fi
    done
  fi

  local cli_dir="$HOME/.local/bin"
  mkdir -p "$cli_dir"
  if [ -n "$agy_bin" ]; then
    cat > "$cli_dir/antigravity-ring" <<EOF
#!/usr/bin/env bash
exec "$agy_bin" --remote-debugging-port=$CDP_PORT "\$@"
EOF
    chmod +x "$cli_dir/antigravity-ring"
    echo "[context-pro] Created CLI wrapper: $cli_dir/antigravity-ring"
  fi

  local desktop_dir="$HOME/.local/share/applications"
  local desktop_out="$desktop_dir/antigravity.desktop"
  mkdir -p "$desktop_dir"

  local desktop_src=""
  for candidate in "/usr/share/applications/antigravity.desktop" "/usr/local/share/applications/antigravity.desktop"; do
    if [ -f "$candidate" ]; then
      desktop_src="$candidate"
      break
    fi
  done

  if [ -n "$desktop_src" ]; then
    python3 - "$desktop_src" "$desktop_out" "$CDP_PORT" <<'PY'
import sys
src, dst, port = sys.argv[1], sys.argv[2], sys.argv[3]
flag = f"--remote-debugging-port={port}"
lines = open(src, encoding="utf-8").read().splitlines()
out = ["# Managed by antigravity-context-pro"]
for line in lines:
    if line.startswith("Exec=") and flag not in line:
        parts = line.split(" ", 1)
        if len(parts) == 2:
            line = f"{parts[0]} {flag} {parts[1]}"
        else:
            line = f"{line} {flag}"
    out.append(line)
open(dst, "w", encoding="utf-8").write("\n".join(out) + "\n")
PY
  elif [ -n "$agy_bin" ]; then
    cat > "$desktop_out" <<EOF
# Managed by antigravity-context-pro
[Desktop Entry]
Name=Antigravity (Context Ring)
Exec=$agy_bin --remote-debugging-port=$CDP_PORT %U
Type=Application
Categories=Development;
EOF
  fi

  echo "[context-pro] Configured Linux desktop launcher: $desktop_out"
  echo ""
  echo "Next steps (Linux):"
  echo "  1. Quit Antigravity completely."
  echo "  2. Relaunch Antigravity from your app launcher or run: $cli_dir/antigravity-ring"
}

case "$(uname -s)" in
  Darwin)
    install_macos_launcher
    ;;
  Linux)
    install_linux_launcher
    ;;
  *)
    echo "[context-pro] Plugin files installed. Launch Antigravity with --remote-debugging-port=$CDP_PORT to enable the input-box ring."
    ;;
esac
