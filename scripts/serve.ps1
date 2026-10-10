# 启动对比服务：先结束占用端口的进程，再启动 server.js
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/serve.ps1

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot

# 端口取自 .env 的 PORT，避免与配置脱节
$port = 18899
$envFile = Join-Path $root '.env'
if (Test-Path $envFile) {
  $m = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
  if ($m) { $port = [int]$m.Matches[0].Groups[1].Value }
}
Write-Host "目标端口: $port"

# 结束占用该端口的监听进程
$listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listeners) {
  foreach ($l in @($listeners)) {
    $procId = $l.OwningProcess
    $name = ''
    try { $name = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { }
    try {
      Stop-Process -Id $procId -Force -ErrorAction Stop
      Write-Host "已结束占用端口 $port 的进程: PID $procId $name"
    } catch {
      Write-Warning "无法结束 PID $procId : $($_.Exception.Message)"
    }
  }
  # 等端口释放，避免新进程仍报 EADDRINUSE
  Start-Sleep -Milliseconds 800
  $still = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($still) { Write-Warning "端口 $port 仍被占用，启动可能失败" }
} else {
  Write-Host "端口 $port 空闲"
}

Set-Location $root
Write-Host "启动: node src/server.js`n"
node src/server.js
