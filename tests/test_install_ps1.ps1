$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoDir = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$InstallScript = Join-Path $RepoDir "scripts\install.ps1"

# Dot-source install.ps1 to import helper functions without running main installer
. $InstallScript

$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("agy-install-test-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $TempRoot | Out-Null

$Passed = 0
$Failed = 0

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if ($Condition) {
        Write-Host "[PASS] $Message" -ForegroundColor Green
        $script:Passed++
    } else {
        Write-Host "[FAIL] $Message" -ForegroundColor Red
        $script:Failed++
    }
}

try {
    # ------------------------------------------------------------------
    # Test 1: Scoop user ($env:SCOOP) and global ($env:SCOOP_GLOBAL) detection
    # ------------------------------------------------------------------
    $fakeUserScoop = Join-Path $TempRoot "user-scoop"
    $fakeGlobalScoop = Join-Path $TempRoot "global-scoop"
    $userExe = Join-Path $fakeUserScoop "apps\antigravity\current\Antigravity.exe"
    $globalExe = Join-Path $fakeGlobalScoop "apps\antigravity\current\Antigravity.exe"

    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $userExe) | Out-Null
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $globalExe) | Out-Null
    Set-Content -Path $userExe -Value "dummy" -Encoding UTF8
    Set-Content -Path $globalExe -Value "dummy" -Encoding UTF8

    $candidates = Get-AntigravityExecutableCandidates `
        -UserHome $TempRoot `
        -LocalAppDataDir (Join-Path $TempRoot "local") `
        -ProgramFilesDir (Join-Path $TempRoot "pf") `
        -ProgramFilesX86Dir (Join-Path $TempRoot "pf86") `
        -ScoopEnv $fakeUserScoop `
        -ScoopGlobalEnv $fakeGlobalScoop `
        -ProgramDataDir (Join-Path $TempRoot "pd")

    Assert-True ($candidates -contains $userExe) "Detects user Scoop executable via SCOOP env var"
    Assert-True ($candidates -contains $globalExe) "Detects global Scoop executable via SCOOP_GLOBAL env var"

    # ------------------------------------------------------------------
    # Test 2: Find and update Scoop Start Menu shortcut (idempotent)
    # ------------------------------------------------------------------
    $scoopStartMenu = Join-Path $TempRoot "StartMenu\Programs\Scoop Apps"
    New-Item -ItemType Directory -Force -Path $scoopStartMenu | Out-Null
    $scoopLnk = Join-Path $scoopStartMenu "Antigravity.lnk"

    $wsh = New-Object -ComObject WScript.Shell
    $sc = $wsh.CreateShortcut($scoopLnk)
    $sc.TargetPath = $globalExe
    $sc.Arguments = "--existing-flag"
    $sc.Save()

    $foundLnks = Find-AntigravityShortcuts -SearchRoots @((Join-Path $TempRoot "StartMenu"))
    Assert-True ($foundLnks -contains $scoopLnk) "Finds Scoop Start Menu Antigravity.lnk"

    $res1 = Update-AntigravityShortcut -ShortcutPath $scoopLnk -CdpPort "9333" -WshShell $wsh
    Assert-True ($res1.Status -eq "Updated" -and -not $res1.RequiresAdmin) "Updates writable Scoop shortcut successfully"

    $scAfter1 = $wsh.CreateShortcut($scoopLnk)
    Assert-True ($scAfter1.Arguments -eq "--existing-flag --remote-debugging-port=9333") "Preserves existing args and appends --remote-debugging-port=9333"

    # Idempotency check: updating port again replaces instead of duplicating
    $res2 = Update-AntigravityShortcut -ShortcutPath $scoopLnk -CdpPort "9444" -WshShell $wsh
    $scAfter2 = $wsh.CreateShortcut($scoopLnk)
    Assert-True ($res2.Status -eq "Updated" -and $scAfter2.Arguments -eq "--existing-flag --remote-debugging-port=9444") "Replaces existing --remote-debugging-port without duplication"

    # ------------------------------------------------------------------
    # Test 3: Admin-protected shortcut (e.g. ProgramData\...\Scoop Apps\Antigravity.lnk)
    # ------------------------------------------------------------------
    $protectedDir = Join-Path $TempRoot "ProgramData\StartMenu\Programs\Scoop Apps"
    New-Item -ItemType Directory -Force -Path $protectedDir | Out-Null
    $protectedLnk = Join-Path $protectedDir "Antigravity.lnk"

    $scProt = $wsh.CreateShortcut($protectedLnk)
    $scProt.TargetPath = $globalExe
    $scProt.Arguments = ""
    $scProt.Save()

    # Deny write permission on the shortcut file to simulate admin-only ProgramData ACL
    $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls $protectedLnk /deny "${currentUser}:(W)" | Out-Null

    try {
        $foundProtected = Find-AntigravityShortcuts -SearchRoots @((Join-Path $TempRoot "ProgramData"))
        Assert-True ($foundProtected -contains $protectedLnk) "Finds admin-protected ProgramData Antigravity.lnk"

        $resProt = Update-AntigravityShortcut -ShortcutPath $protectedLnk -CdpPort "9333" -WshShell $wsh
        Assert-True ($resProt.Status -eq "RequiresAdmin" -and $resProt.RequiresAdmin -eq $true) "Detects permission error on admin-protected shortcut without crashing"
    } finally {
        # Restore ACL so cleanup succeeds
        & icacls $protectedLnk /remove:d $currentUser | Out-Null
    }
} finally {
    if (Test-Path $TempRoot) {
        Remove-Item -Recurse -Force $TempRoot -ErrorAction SilentlyContinue
    }
}

Write-Host ""
Write-Host "Summary: $Passed passed, $Failed failed."
if ($Failed -gt 0) { exit 1 }
exit 0
