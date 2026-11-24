$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoDir = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$PluginDir = Join-Path $HOME ".gemini\config\plugins\desktop-context"
$CdpPort = if ($env:AGY_CDP_PORT) { $env:AGY_CDP_PORT } else { "9333" }

Write-Host "[context-pro] Installing plugin to $PluginDir ..."

New-Item -ItemType Directory -Force -Path $PluginDir | Out-Null
$PluginReal = (Resolve-Path $PluginDir).Path

if ($RepoDir.TrimEnd('\') -ne $PluginReal.TrimEnd('\')) {
    New-Item -ItemType Directory -Force -Path (Join-Path $PluginDir "sidecars\context") | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $PluginDir "assets") | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $PluginDir "scripts") | Out-Null

    Copy-Item -Force (Join-Path $RepoDir "plugin.json") (Join-Path $PluginDir "plugin.json")
    if (Test-Path (Join-Path $RepoDir "LICENSE")) { Copy-Item -Force (Join-Path $RepoDir "LICENSE") (Join-Path $PluginDir "LICENSE") }
    if (Test-Path (Join-Path $RepoDir "README.md")) { Copy-Item -Force (Join-Path $RepoDir "README.md") (Join-Path $PluginDir "README.md") }
    if (Test-Path (Join-Path $RepoDir "README_ZH.md")) { Copy-Item -Force (Join-Path $RepoDir "README_ZH.md") (Join-Path $PluginDir "README_ZH.md") }
    Copy-Item -Recurse -Force (Join-Path $RepoDir "assets\*") (Join-Path $PluginDir "assets")
    Copy-Item -Recurse -Force (Join-Path $RepoDir "scripts\*") (Join-Path $PluginDir "scripts")

    Get-ChildItem -Path (Join-Path $RepoDir "sidecars\context") -Exclude "__pycache__", ".data" | ForEach-Object {
        Copy-Item -Recurse -Force $_.FullName (Join-Path $PluginDir "sidecars\context")
    }
    Write-Host "[context-pro] Synced plugin files."
}

$Candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\Antigravity\Antigravity.exe"),
    (Join-Path $env:ProgramFiles "Antigravity\Antigravity.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Antigravity\Antigravity.exe")
)
$ExePath = $Candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $ExePath) {
    $cmd = Get-Command antigravity -ErrorAction SilentlyContinue
    if ($cmd) { $ExePath = $cmd.Source }
}

if (-not $ExePath) {
    Write-Warning "Antigravity.exe not found automatically. Pass --remote-debugging-port=$CdpPort to your shortcut manually."
    exit 0
}

$WshShell = New-Object -ComObject WScript.Shell
$ShortcutDirs = @(
    [Environment]::GetFolderPath("Desktop"),
    [Environment]::GetFolderPath("Programs")
)

foreach ($dir in $ShortcutDirs) {
    if ($dir -and (Test-Path $dir)) {
        $lnkPath = Join-Path $dir "Antigravity (Context Ring).lnk"
        $shortcut = $WshShell.CreateShortcut($lnkPath)
        $shortcut.TargetPath = $ExePath
        $shortcut.Arguments = "--remote-debugging-port=$CdpPort"
        $shortcut.WorkingDirectory = Split-Path -Parent $ExePath
        $shortcut.IconLocation = "$ExePath,0"
        $shortcut.Description = "Launch Antigravity with Context Ring CDP enabled"
        $shortcut.Save()
        Write-Host "[context-pro] Created shortcut: $lnkPath"
    }
}

Write-Host ""
Write-Host "Next steps (Windows):"
Write-Host "  1. Quit Antigravity completely."
Write-Host "  2. Launch 'Antigravity (Context Ring)' from your Desktop or Start Menu."
