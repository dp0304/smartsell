# SmartSell hub installer for Windows (§2.13).
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-hub.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-hub.ps1 -Dir "$HOME\smartsell" -Mode boot
#
# Checks prerequisites and prints the exact winget command for anything missing; it never installs system software
# for you. Every failing step prints the command, the reason and the next step, then stops.
[CmdletBinding()]
param(
  [string]$Dir = (Join-Path $HOME 'smartsell'),
  [string]$Repo = 'https://github.com/dp0304/smartsell.git',
  [string]$Branch = 'main',
  [string]$Mode = '',
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
# This file is saved as UTF-8 with a BOM so Windows PowerShell 5.1 reads the zh-Hant text correctly.

function Step([string]$Text) { Write-Host ''; Write-Host "==> ${Text}" }
function Fail([string]$Command, [string]$Reason, [string]$Next) {
  Write-Host ''
  Write-Host "[失敗] 命令：${Command}" -ForegroundColor Red
  Write-Host "       原因：${Reason}"
  Write-Host "       下一步：${Next}"
  exit 1
}
function Run([string]$Description, [string]$Next, [string]$File, [string[]]$Arguments) {
  $line = "${File} $($Arguments -join ' ')"
  Write-Host "    > ${line}"
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) { Fail $line "${Description} 失敗（結束碼 ${LASTEXITCODE}）" $Next }
}
function Has([string]$Name) { return [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

if ($Mode -and @('logon', 'boot') -notcontains $Mode) { Fail "-Mode $Mode" '-Mode 只能是 logon 或 boot' '改用 -Mode logon 或 -Mode boot 後重跑' }

Step '1/6 檢查前置軟體'
$missing = $false
function Need([string]$Name, [bool]$Present, [string]$Install) {
  if ($Present) { Write-Host "    [OK] ${Name}" }
  else { Write-Host "    [缺少] ${Name}：請執行  ${Install}"; $script:missing = $true }
}
$nodeOk = $false
if (Has 'node') {
  $version = (& node -p 'process.versions.node').Trim()
  $nodeOk = $version.StartsWith('24.')
  if (-not $nodeOk) { Write-Host "    目前的 Node 版本是 ${version}，需要 24：winget install --id OpenJS.NodeJS -e --version 24.*（或 winget upgrade OpenJS.NodeJS）" }
}
$tailscaleExe = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
Need 'git' (Has 'git') 'winget install --id Git.Git -e'
Need 'Node.js 24' $nodeOk 'winget install --id OpenJS.NodeJS -e --version 24.*'
Need 'corepack' (Has 'corepack') 'winget install --id OpenJS.NodeJS -e   （Node 24 內建 corepack）'
Need 'ffmpeg / ffprobe' (Has 'ffprobe') 'winget install --id Gyan.FFmpeg -e   （安裝後重新開啟 PowerShell）'
Need 'Tailscale' ((Test-Path $tailscaleExe) -or (Has 'tailscale')) 'winget install --id Tailscale.Tailscale -e   （安裝後登入）'
if ($missing) { Fail '前置軟體檢查' '缺少上面標示的軟體' '依上面的命令安裝後，重新開啟 PowerShell 並重跑 scripts\install-hub.ps1' }
if ($CheckOnly) { Write-Host ''; Write-Host '前置軟體都已安裝（-CheckOnly，沒有做任何變更）。'; exit 0 }

Step '2/6 啟用 pnpm（corepack）'
Run 'corepack enable' '以「系統管理員」身分開啟 PowerShell 後重跑' 'corepack' @('enable')

Step '3/6 取得原始碼'
$here = Split-Path -Parent $PSScriptRoot
if ($here -and (Test-Path (Join-Path $here 'apps\server\hub.ts')) -and (Test-Path (Join-Path $here '.git'))) {
  $Dir = $here
  Write-Host "    使用目前的原始碼資料夾：${Dir}"
  Run 'git pull' '先處理本機修改（git status），再重跑' 'git' @('-C', $Dir, 'pull', '--ff-only')
} elseif (Test-Path (Join-Path $Dir '.git')) {
  Run 'git pull' "先處理本機修改（git -C `"$Dir`" status），再重跑" 'git' @('-C', $Dir, 'pull', '--ff-only')
} else {
  Run 'git clone' '確認網路與 -Repo 網址後重跑' 'git' @('clone', '--branch', $Branch, $Repo, $Dir)
}
Set-Location $Dir

Step '4/6 安裝相依套件、建置 Web 與 relay'
Run 'pnpm install' '看上面的錯誤訊息；網路問題時重跑即可' 'pnpm' @('install', '--frozen-lockfile')
Run 'Web 建置' '看上面的錯誤訊息，或在 docs\hub-setup.md 查「Web 建置失敗」' 'pnpm' @('--filter', '@smartsell/web', 'build')
Run 'relay 建置' '看上面的錯誤訊息；修正後重跑 pnpm --filter @smartsell/agent-relay build' 'pnpm' @('--filter', '@smartsell/agent-relay', 'build')

Step '5/6 設定中樞（pnpm hub:init）'
Run 'pnpm hub:init' '依上面的提示處理後重跑 pnpm hub:init（可以重跑，已有的設定會保留）' 'pnpm' @('hub:init', '--skip-web-build', '--no-service')

Step '6/6 安裝為服務（pnpm hub:service install）'
if ($Mode) { Run 'pnpm hub:service install' "依上面的說明處理後重跑 pnpm hub:service install --mode $Mode" 'pnpm' @('hub:service', 'install', '--mode', $Mode) }
else { Run 'pnpm hub:service install' '依上面的說明處理後重跑 pnpm hub:service install' 'pnpm' @('hub:service', 'install') }

Write-Host ''
Write-Host '完成。之後的健檢：pnpm hub:doctor；更新：pnpm hub:update。首次設定網址已印在上面 [10/10] 那一行。'
