# Footage Download Manager — one-shot Windows build.
# Installs prerequisites (Git, Node LTS, Rust MSVC, VS C++ Build Tools) via winget,
# then installs deps, fetches the rclone sidecar, and builds the installers.
#
# Run:  powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1
# (or double-click scripts\build-windows.bat)

# --- Re-launch elevated (VS Build Tools needs admin) -------------------------
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Write-Host "Requesting administrator rights..." -ForegroundColor Yellow
  Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  exit
}

# Start in the repo root (whether run from repo\scripts or standalone).
if (Test-Path "$PSScriptRoot\..\package.json") { Set-Location (Resolve-Path "$PSScriptRoot\..") }
else { Set-Location $PSScriptRoot }

$log = Join-Path (Get-Location) "build-windows.log"
try { Start-Transcript -Path $log -Force | Out-Null } catch {}

$script:winget = $null
function Have($cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  # Include the App-Execution-Alias dir (winget lives here) — elevated sessions drop it.
  $extra = "$env:USERPROFILE\.cargo\bin;$env:ProgramFiles\nodejs;$env:ProgramFiles\Git\cmd;$env:LOCALAPPDATA\Microsoft\WindowsApps;$env:LOCALAPPDATA\Microsoft\WinGet\Links"
  $env:Path = "$machine;$user;$extra"
}
function Resolve-Winget {
  Refresh-Path
  if (Have winget) { return (Get-Command winget).Source }
  # Fall back to the versioned binary under Program Files\WindowsApps (admin can read it).
  $exe = Get-ChildItem "$env:ProgramFiles\WindowsApps\Microsoft.DesktopAppInstaller_*_x64__8wekyb3d8bbwe\winget.exe" -ErrorAction SilentlyContinue |
    Sort-Object FullName | Select-Object -Last 1
  if ($exe) { return $exe.FullName }
  return $null
}

function Main {
  Write-Host "`n== Footage Download Manager :: Windows build ==`n" -ForegroundColor Cyan
  Write-Host "Log: $log`n" -ForegroundColor DarkGray

  $script:winget = Resolve-Winget
  if (-not $script:winget) {
    throw "winget not found. Install 'App Installer' from the Microsoft Store (Windows 10 21H1+/11), then re-run."
  }
  Write-Host "  [ok] winget: $script:winget" -ForegroundColor DarkGray

  function Ensure-Tool($id, $cmd) {
    Refresh-Path
    if (Have $cmd) { Write-Host "  [ok] $cmd" -ForegroundColor DarkGray; return }
    Write-Host "  [install] $id ..." -ForegroundColor Yellow
    & $script:winget install --id $id -e --accept-source-agreements --accept-package-agreements --silent
    Refresh-Path
    if (-not (Have $cmd)) {
      Write-Host "  [warn] $cmd installed but not yet on PATH (a reboot may be needed)" -ForegroundColor Yellow
    }
  }

  # 1) Prerequisites
  Ensure-Tool "Git.Git" "git"
  Ensure-Tool "OpenJS.NodeJS.LTS" "node"
  Ensure-Tool "Rustlang.Rustup" "rustc"

  # Visual Studio C++ Build Tools (Rust's MSVC linker)
  $vsRoots = @(
    "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools",
    "${env:ProgramFiles}\Microsoft Visual Studio\2022\BuildTools",
    "${env:ProgramFiles}\Microsoft Visual Studio\2022\Community"
  )
  if (-not ($vsRoots | Where-Object { Test-Path $_ })) {
    Write-Host "  [install] Visual Studio C++ Build Tools (large, several minutes) ..." -ForegroundColor Yellow
    & $script:winget install --id Microsoft.VisualStudio.2022.BuildTools -e --silent `
      --accept-source-agreements --accept-package-agreements `
      --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
  } else {
    Write-Host "  [ok] VS C++ Build Tools" -ForegroundColor DarkGray
  }
  Refresh-Path
  if (Have rustup) { rustup default stable-x86_64-pc-windows-msvc 2>$null | Out-Null }
  Refresh-Path

  # Diagnostics
  Write-Host "`n  versions:" -ForegroundColor DarkGray
  foreach ($t in @("node", "npm", "rustc", "cargo", "git")) {
    if (Have $t) { Write-Host ("    {0,-6} {1}" -f $t, ((& $t --version) 2>&1 | Select-Object -First 1)) }
    else { Write-Host "    $t  MISSING" -ForegroundColor Red }
  }

  if (-not (Have npm)) { throw "npm not found on PATH. Reboot Windows and run this script again." }
  if (-not (Have cargo)) { throw "cargo (Rust) not found on PATH. Reboot Windows and run this script again." }

  # 2) Source (clone if run standalone)
  if (-not (Test-Path ".\package.json")) {
    Write-Host "`n  [clone] Mustafakamran/footage-download-manager" -ForegroundColor Yellow
    if (Have gh) { gh repo clone Mustafakamran/footage-download-manager }
    else { git clone https://github.com/Mustafakamran/footage-download-manager.git }
    Set-Location footage-download-manager
  }

  # 3) Build
  Write-Host "`n  [npm] installing dependencies..." -ForegroundColor Yellow
  npm install
  if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)." }

  Write-Host "  [rclone] fetching sidecar binary..." -ForegroundColor Yellow
  npm run fetch:rclone
  if ($LASTEXITCODE -ne 0) { throw "fetch:rclone failed (exit $LASTEXITCODE)." }

  Write-Host "  [tauri] building app (this takes a few minutes)...`n" -ForegroundColor Yellow
  npm run tauri build
  if ($LASTEXITCODE -ne 0) { throw "tauri build failed (exit $LASTEXITCODE). See the log above." }

  Write-Host "`nBuild complete. Installers:" -ForegroundColor Green
  Get-ChildItem -Recurse -ErrorAction SilentlyContinue `
    "src-tauri\target\release\bundle\nsis\*.exe", `
    "src-tauri\target\release\bundle\msi\*.msi" |
    ForEach-Object { Write-Host "  $($_.FullName)" -ForegroundColor Green }
}

try {
  Main
} catch {
  Write-Host "`nERROR: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Full log saved to: $log" -ForegroundColor Yellow
} finally {
  try { Stop-Transcript | Out-Null } catch {}
  Write-Host "`nPress Enter to close..."
  [void][System.Console]::ReadLine()
}
