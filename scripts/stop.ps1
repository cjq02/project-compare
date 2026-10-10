# 仅结束占用端口的对比服务进程
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/stop.ps1

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot

$port = 18899
$envFile = Join-Path $root '.env'
if (Test-Path $envFile) {
  $m = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
  if ($m) { $port = [int]$m.Matches[0].Groups[1].Value }
}

$listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $listeners) {
  Write-Host "端口 $port 上没有正在运行的对比服务"
  return
}
foreach ($l in @($listeners)) {
  $procId = $l.OwningProcess
  $name = ''
  try { $name = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { }
  try {
    Stop-Process -Id $procId -Force -ErrorAction Stop
    Write-Host "已结束: PID $procId $name (端口 $port)"
  } catch {
    Write-Warning "无法结束 PID $procId : $($_.Exception.Message)"
  }
}
