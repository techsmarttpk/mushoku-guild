# Phase 2 measurement sampler. Emits one JSON line per sample for the process tree rooted at -RootPid.
# Memory: wsMB = sum of working sets (double-counts shared pages, matches the ADR-0012 wording);
#         privMB = sum of private working sets (what is not shared).
# CPU:    % of TOTAL machine CPU (all logical processors) from kernel+user time deltas of tree processes.
# GPU (-Gpu): per-engine utilisation of tree processes, keyed "luid|engtype".
param(
  [Parameter(Mandatory = $true)][int]$RootPid,
  [int]$IntervalMs = 1000,
  [int]$DurationSec = 60,
  [switch]$Gpu
)
$ErrorActionPreference = 'Stop'
$logical = [Environment]::ProcessorCount

function Get-TreeIds($root, $all) {
  $ids = New-Object 'System.Collections.Generic.HashSet[int]'
  [void]$ids.Add($root)
  do {
    $changed = $false
    foreach ($p in $all) {
      if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) {
        [void]$ids.Add([int]$p.ProcessId); $changed = $true
      }
    }
  } while ($changed)
  return , $ids
}

$prev = @{}
$prevT = $null
$end = (Get-Date).AddSeconds($DurationSec)
while ((Get-Date) -lt $end) {
  $t0 = [DateTime]::UtcNow
  $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, WorkingSetSize, KernelModeTime, UserModeTime, CommandLine)
  if (-not ($all | Where-Object { $_.ProcessId -eq $RootPid })) { break }
  $ids = Get-TreeIds $RootPid $all
  # Phase 3: the external Claude CLI (and everything it spawned, incl. the approver) is measured separately (ADR-0012 qualification).
  foreach ($c in @($all | Where-Object { $ids.Contains([int]$_.ProcessId) -and $_.Name -eq 'claude.exe' })) {
    foreach ($x in (Get-TreeIds ([int]$c.ProcessId) $all)) { [void]$ids.Remove($x) }
  }
  $tree = @($all | Where-Object { $ids.Contains([int]$_.ProcessId) })

  $cpuTicks = 0.0
  $cur = @{}
  $pidDelta = @{}
  foreach ($p in $tree) {
    $tick = [double]$p.KernelModeTime + [double]$p.UserModeTime
    $cur[[int]$p.ProcessId] = $tick
    if ($prev.ContainsKey([int]$p.ProcessId)) { $d = ($tick - $prev[[int]$p.ProcessId]); $cpuTicks += $d; $pidDelta[[int]$p.ProcessId] = $d }
  }
  $nowT = [DateTime]::UtcNow
  $cpuPct = $null
  $dt = 0
  if ($prevT) {
    $dt = ($nowT - $prevT).TotalSeconds * 1e7
    if ($dt -gt 0) { $cpuPct = [math]::Round(100.0 * $cpuTicks / $dt / $logical, 3) }
  }
  $prev = $cur
  $prevT = $nowT

  $perf = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $ids.Contains([int]$_.IDProcess) })
  $priv = ($perf | Measure-Object WorkingSetPrivate -Sum).Sum
  $ws = ($tree | Measure-Object WorkingSetSize -Sum).Sum
  $row = [ordered]@{
    t       = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    procs   = $tree.Count
    wsMB    = [math]::Round($ws / 1MB, 1)
    privMB  = [math]::Round($priv / 1MB, 1)
    cpuPct  = $cpuPct
    names   = (($tree | Group-Object Name | ForEach-Object { "$($_.Name)x$($_.Count)" }) -join ',')
  }
  # One per-process breakdown mid-run (process type only; command lines are never stored).
  $script:n = 1 + $(if ($script:n) { $script:n } else { 0 })
  if ($script:n -eq 10) {
    $row['detail'] = @($tree | ForEach-Object {
      $pid2 = $_.ProcessId
      $pr = $perf | Where-Object { $_.IDProcess -eq $pid2 } | Select-Object -First 1
      $type = if ($_.CommandLine -match '--type=([a-z\-]+)') { $Matches[1] } elseif ($_.Name -eq 'msedgewebview2.exe') { 'browser' } else { $_.Name }
      [ordered]@{ pid = $pid2; name = $_.Name; type = $type; wsMB = [math]::Round($_.WorkingSetSize / 1MB, 1); privMB = [math]::Round($pr.WorkingSetPrivate / 1MB, 1); cpuPct = $(if ($dt -gt 0 -and $pidDelta.ContainsKey([int]$pid2)) { [math]::Round(100.0 * $pidDelta[[int]$pid2] / $dt / $logical, 3) } else { $null }) }
    })
  }
  if ($Gpu) {
    $acc = @{}
    foreach ($e in (Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine)) {
      if ($e.Name -match '^pid_(\d+)_luid_(0x[0-9A-Fa-f]+_0x[0-9A-Fa-f]+)_phys_\d+_eng_\d+_engtype_(.+)$') {
        if ($ids.Contains([int]$Matches[1])) {
          $k = "$($Matches[2])|$($Matches[3])"
          if (-not $acc.ContainsKey($k)) { $acc[$k] = 0.0 }
          $acc[$k] += [double]$e.UtilizationPercentage
        }
      }
    }
    $row['gpu'] = $acc
  }
  ($row | ConvertTo-Json -Compress -Depth 4)
  $elapsed = ([DateTime]::UtcNow - $t0).TotalMilliseconds
  if ($elapsed -lt $IntervalMs) { Start-Sleep -Milliseconds ([int]($IntervalMs - $elapsed)) }
}
