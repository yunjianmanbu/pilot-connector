[CmdletBinding()]
param(
    [string]$TaskName = 'PilotConnector'
)

$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path

Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

$runScript = Join-Path $dir 'run-connector.cmd'
if (Test-Path $runScript) {
    Remove-Item -Force $runScript
}

Write-Host "已停止并移除计划任务 $TaskName。" -ForegroundColor Green
Write-Host "中继器文件仍保留在 $dir，可直接删除。"
