<#
.SYNOPSIS
    在 Windows 上安装 Pilot Link 中继器（当前用户登录时自动启动）。

.DESCRIPTION
    中继器只转发端到端加密的 WebSocket 帧，不保存会话，也不持有配对密钥。
    手机要求 wss://，因此 Windows 上还需要用 nginx / Caddy / IIS 反向代理并配置
    TLS 证书，再把 wss://你的域名/connector 填到 Pilot。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install.ps1
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -Port 8789 -Bind 127.0.0.1
#>
[CmdletBinding()]
param(
    [int]$Port = 8789,
    [string]$Bind = '127.0.0.1',
    [string]$TaskName = 'PilotConnector'
)

$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$server = Join-Path $dir 'server.mjs'
if (-not (Test-Path $server)) {
    throw "找不到 server.mjs，请在解压后的中继器目录中运行本脚本。"
}

$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) {
    throw "未找到 Node.js。请先安装 Node.js 22.12 或更高版本：https://nodejs.org/"
}
$nodeVersion = & $node.Source -p "process.versions.node"
$parts = $nodeVersion.Split('.')
$major = [int]$parts[0]
$minor = [int]$parts[1]
if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 12)) {
    throw "Node.js 版本为 $nodeVersion，需要 22.12 或更高版本。"
}

$runScript = Join-Path $dir 'run-connector.cmd'
$runContent = @"
@echo off
set NODE_ENV=production
set PORT=$Port
set BIND=$Bind
set WS_PATH=/connector
"$($node.Source)" "$server"
"@
Set-Content -Path $runScript -Value $runContent -Encoding ASCII

$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$runScript`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'Pilot Link blind WebSocket relay' `
    -Force | Out-Null

Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $TaskName

$healthy = $false
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $response = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/healthz" -TimeoutSec 2
        if ($response.StatusCode -eq 200) {
            $healthy = $true
            break
        }
    } catch {
        # Keep waiting until the service is up.
    }
}

if (-not $healthy) {
    throw "中继器没有通过健康检查。请检查端口 $Port 是否被占用，或在任务计划程序中查看 $TaskName。"
}

Write-Host ""
Write-Host "✓ 中继器已启动：http://${Bind}:${Port}/connector" -ForegroundColor Green
Write-Host "  开机/登录后会自动运行（计划任务：$TaskName）。"
Write-Host ""
Write-Host "  手机连接要求 wss://。请用 nginx / Caddy / IIS 反向代理到 127.0.0.1:$Port 并配置 TLS，"
Write-Host "  然后把 wss://你的域名/connector 填到 Pilot 的「自建中继器 → 中继地址」。"
Write-Host ""
Write-Host "  停止：Stop-ScheduledTask -TaskName $TaskName"
Write-Host "  卸载：powershell -ExecutionPolicy Bypass -File .\uninstall.ps1"
