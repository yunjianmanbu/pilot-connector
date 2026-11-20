<#
.SYNOPSIS
    在 Windows 上安装 Pilot Link 中继器（当前用户登录时自动启动）。

.DESCRIPTION
    中继器只转发端到端加密的 WebSocket 帧，不保存会话，也不持有配对密钥。
    手机要求 wss://，因此 Windows 上还需要用 nginx / Caddy / IIS 反向代理并配置
    TLS 证书，再把 wss://你的域名/<随机路径>#k=<准入码> 填到 Pilot。

.PARAMETER Path
    WebSocket 路径。默认自动生成 /c/<32 位十六进制>，让扫描器找不到入口。

.PARAMETER AccessKey
    准入码 id:secret。默认自动生成 home:<随机值>。多条用逗号分隔。

.PARAMETER Strict
    强制要求准入码；不加则只记录不拦截，便于灰度。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install.ps1
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -Port 8789 -Bind 127.0.0.1 -Strict
#>
[CmdletBinding()]
param(
    [int]$Port = 8789,
    [string]$Bind = '127.0.0.1',
    [string]$TaskName = 'PilotConnector',
    [string]$Path = '',
    [string]$AccessKey = '',
    [switch]$Strict
)

$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$server = Join-Path $dir 'server.mjs'
if (-not (Test-Path $server)) {
    throw "找不到 server.mjs，请在解压后的中继器目录中运行本脚本。"
}

function New-RandomHex([int]$bytes) {
    $buffer = New-Object byte[] $bytes
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buffer)
    return ($buffer | ForEach-Object { $_.ToString('x2') }) -join ''
}

if (-not $Path) { $Path = '/c/' + (New-RandomHex 16) }
if (-not $AccessKey) { $AccessKey = 'home:' + (New-RandomHex 24) }
if ($Path -notmatch '^/') { throw "WebSocket 路径必须以 / 开头：$Path" }
if ($AccessKey -notmatch '^[A-Za-z0-9_-]+:[A-Za-z0-9_-]{16,128}(,[A-Za-z0-9_-]+:[A-Za-z0-9_-]{16,128})*$') {
    throw "准入码格式不正确，应为 id:secret（secret 至少 16 个字符），多条用逗号分隔。"
}
$strictValue = if ($Strict) { '1' } else { '0' }

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
set WS_PATH=$Path
set RELAY_ACCESS_KEYS=$AccessKey
set RELAY_ACCESS_STRICT=$strictValue
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
Write-Host "✓ 中继器已启动：http://${Bind}:${Port}${Path}" -ForegroundColor Green
Write-Host "  开机/登录后会自动运行（计划任务：$TaskName）。"
Write-Host ""
Write-Host "  手机连接要求 wss://。请用 nginx / Caddy / IIS 反向代理到 127.0.0.1:$Port 并配置 TLS，"
Write-Host "  然后把下面整条连接串填到 Pilot 的「自建中继器 → 中继地址」："
Write-Host "  wss://你的域名${Path}#k=${AccessKey}" -ForegroundColor Cyan
Write-Host ""
if ($Strict) {
    Write-Host "  准入码已强制生效（RELAY_ACCESS_STRICT=1）。"
} else {
    Write-Host "  准入码目前只记录不拦截（RELAY_ACCESS_STRICT=0）。确认各端都能连上后，"
    Write-Host "  把 run-connector.cmd 里的 RELAY_ACCESS_STRICT 改成 1 并重启任务。"
}
Write-Host "  #k= 之后是准入码，不要单独发出去。"
Write-Host ""
Write-Host "  停止：Stop-ScheduledTask -TaskName $TaskName"
Write-Host "  卸载：powershell -ExecutionPolicy Bypass -File .\uninstall.ps1"
