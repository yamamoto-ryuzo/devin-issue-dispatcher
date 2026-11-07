# Devin Agent 管理サーバー(control.mjs) をタスクスケジューラに登録する（ログオン時に自動起動）
# control.mjs は管理パネル(http://127.0.0.1:8585) を提供し、desired.json が
# enabled なら dispatcher.mjs を自動起動する。常駐登録するのはこの control のみ。
# 使い方:
#   powershell -ExecutionPolicy Bypass -File register-task.ps1          # 登録
#   powershell -ExecutionPolicy Bypass -File register-task.ps1 -Remove  # 解除
param([switch]$Remove)

$TaskName = 'DevinAgentDispatcher'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Node = (Get-Command node.exe).Source
$Script = Join-Path $Root 'control.mjs'

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed task '$TaskName'"
  exit 0
}

$action = New-ScheduledTaskAction -Execute $Node -Argument "`"$Script`"" -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
$settings.Hidden = $false

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Description 'Devin Agent control panel (port 8585) + dispatcher supervisor' -Force

Write-Host "Registered '$TaskName' (runs at logon: $Node $Script)"
Write-Host 'Start now with:  Start-ScheduledTask -TaskName DevinAgentDispatcher'
Write-Host 'Stop with:       Stop-ScheduledTask -TaskName DevinAgentDispatcher (or end the node process)'
