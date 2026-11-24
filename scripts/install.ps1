$ErrorActionPreference = "Stop"

function Get-ScoopRoots {
    param(
        [string]$UserHome = $HOME,
        [string]$ScoopEnv = $env:SCOOP,
        [string]$ScoopGlobalEnv = $env:SCOOP_GLOBAL,
        [string]$ProgramDataDir = $env:ProgramData
    )

    $roots = [System.Collections.Generic.List[string]]::new()
    if ($ScoopEnv) { $roots.Add($ScoopEnv) }
    if ($ScoopGlobalEnv) { $roots.Add($ScoopGlobalEnv) }

    $scoopConfig = Join-Path $UserHome ".config\scoop\config.json"
    if (Test-Path $scoopConfig) {
        try {
            $cfg = Get-Content -Path $scoopConfig -Raw | ConvertFrom-Json
            if ($cfg.root_path) { $roots.Add([string]$cfg.root_path) }
            if ($cfg.global_path) { $roots.Add([string]$cfg.global_path) }
        } catch {
            # Ignore malformed scoop config
        }
    }

    if ($UserHome) { $roots.Add((Join-Path $UserHome "scoop")) }
    if ($ProgramDataDir) { $roots.Add((Join-Path $ProgramDataDir "scoop")) }

    return ($roots | Where-Object { $_ } | Select-Object -Unique)
}

function Get-AntigravityExecutableCandidates {
    param(
        [string]$UserHome = $HOME,
        [string]$LocalAppDataDir = $env:LOCALAPPDATA,
        [string]$ProgramFilesDir = $env:ProgramFiles,
        [string]$ProgramFilesX86Dir = ${env:ProgramFiles(x86)},
        [string]$ScoopEnv = $env:SCOOP,
        [string]$ScoopGlobalEnv = $env:SCOOP_GLOBAL,
        [string]$ProgramDataDir = $env:ProgramData
    )

    $candidates = [System.Collections.Generic.List[string]]::new()
    if ($LocalAppDataDir) { $candidates.Add((Join-Path $LocalAppDataDir "Programs\Antigravity\Antigravity.exe")) }
    if ($ProgramFilesDir) { $candidates.Add((Join-Path $ProgramFilesDir "Antigravity\Antigravity.exe")) }
    if ($ProgramFilesX86Dir) { $candidates.Add((Join-Path $ProgramFilesX86Dir "Antigravity\Antigravity.exe")) }

    foreach ($scoopRoot in (Get-ScoopRoots -UserHome $UserHome -ScoopEnv $ScoopEnv -ScoopGlobalEnv $ScoopGlobalEnv -ProgramDataDir $ProgramDataDir)) {
        $candidates.Add((Join-Path $scoopRoot "apps\antigravity\current\Antigravity.exe"))
    }

    return ($candidates | Where-Object { $_ } | Select-Object -Unique)
}

function Find-AntigravityShortcuts {
    param(
        [string[]]$SearchRoots
    )

    if (-not $SearchRoots -or $SearchRoots.Count -eq 0) {
        $SearchRoots = @(
            [Environment]::GetFolderPath("Desktop"),
            [Environment]::GetFolderPath("StartMenu"),
            [Environment]::GetFolderPath("CommonStartMenu")
        )
    }

    $found = [System.Collections.Generic.List[string]]::new()
    foreach ($root in ($SearchRoots | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique)) {
        Get-ChildItem -Path $root -Filter "*.lnk" -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match "Antigravity" } |
            ForEach-Object { $found.Add($_.FullName) }
    }

    return ($found | Select-Object -Unique)
}

function Update-AntigravityShortcut {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ShortcutPath,
        [Parameter(Mandatory = $true)]
        [string]$CdpPort,
        [object]$WshShell = $null
    )

    if (-not $WshShell) {
        $WshShell = New-Object -ComObject WScript.Shell
    }

    try {
        $shortcut = $WshShell.CreateShortcut($ShortcutPath)
        $currentArgs = if ($shortcut.Arguments) { $shortcut.Arguments } else { "" }
        if ($currentArgs -match "--remote-debugging-port=\d+") {
            $newArgs = $currentArgs -replace "--remote-debugging-port=\d+", "--remote-debugging-port=$CdpPort"
        } else {
            $newArgs = ($currentArgs + " --remote-debugging-port=$CdpPort").Trim()
        }

        $shortcut.Arguments = $newArgs
        $shortcut.Save()

        return [PSCustomObject]@{
            Path          = $ShortcutPath
            Status        = "Updated"
            RequiresAdmin = $false
            Arguments     = $newArgs
            Error         = $null
        }
    } catch {
        $msg = $_.Exception.Message
        $isPermError = ($_.Exception -is [System.UnauthorizedAccessException]) -or
                       ($msg -match "Unable to save shortcut|无法保存快捷方式|Access is denied|拒绝访问")
        return [PSCustomObject]@{
            Path          = $ShortcutPath
            Status        = if ($isPermError) { "RequiresAdmin" } else { "Failed" }
            RequiresAdmin = $isPermError
            Arguments     = $null
            Error         = $msg
        }
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $RepoDir = (Resolve-Path (Join-Path $ScriptDir "..")).Path
    $PluginDir = Join-Path $HOME ".gemini\config\plugins\desktop-context"
    $CdpPort = if ($env:AGY_CDP_PORT) { $env:AGY_CDP_PORT } else { "9222" }

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

    $Candidates = Get-AntigravityExecutableCandidates
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

    # Update existing Antigravity shortcuts (including Scoop Start Menu shortcuts)
    $existingShortcuts = Find-AntigravityShortcuts
    foreach ($lnk in $existingShortcuts) {
        $res = Update-AntigravityShortcut -ShortcutPath $lnk -CdpPort $CdpPort -WshShell $WshShell
        if ($res.Status -eq "Updated") {
            Write-Host "[context-pro] Updated shortcut: $lnk"
        } elseif ($res.RequiresAdmin) {
            Write-Warning "[context-pro] Administrator privileges required to update shortcut: $lnk"
            Write-Host "  Run in elevated PowerShell:"
            Write-Host "  `$wsh = New-Object -ComObject WScript.Shell; `$sc = `$wsh.CreateShortcut('$lnk'); `$sc.Arguments = '--remote-debugging-port=$CdpPort'; `$sc.Save()"
        } else {
            Write-Warning "[context-pro] Failed to update shortcut $lnk : $($res.Error)"
        }
    }

    Write-Host ""
    Write-Host "Next steps (Windows):"
    Write-Host "  1. Quit Antigravity completely."
    Write-Host "  2. Launch 'Antigravity (Context Ring)' from your Desktop or Start Menu."
}
