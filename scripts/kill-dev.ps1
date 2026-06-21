# Free hera dev procs. server :3000, web :5173 by port; agent by command line (no port).
$owners = (Get-NetTCPConnection -LocalPort 3000, 5173 -State Listen -ErrorAction SilentlyContinue).OwningProcess
$agent = (Get-CimInstance Win32_Process -Filter "Name = 'bun.exe'" | Where-Object { $_.CommandLine -like '*agent*index.ts*' }).ProcessId
$pids = @($owners) + @($agent) | Where-Object { $_ } | Sort-Object -Unique
if ($pids) {
  $pids | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
  "killed PID(s): $($pids -join ', ')"
} else {
  "nothing listening on :3000/:5173 and no dev:agent running"
}
