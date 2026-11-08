# Phase 2 measurement helper: change the state of the app's main window and report the resulting state.
# Actions: state | focus | blur | minimize | restore | hide | show
# Windows are found by EnumWindows (so hidden windows are found too), by owning process id and title.
param(
  [Parameter(Mandatory = $true)][int]$TargetPid,
  [Parameter(Mandatory = $true)][ValidateSet('state', 'focus', 'blur', 'minimize', 'restore', 'hide', 'show')][string]$Action,
  [string]$Title = 'Mushoku Guild'
)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool altTab);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  // Gives the foreground to h without synthetic key presses (an Alt tap stalls the WebView page).
  public static void Foreground(IntPtr h) {
    uint pid; uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    uint cur = GetCurrentThreadId();
    bool attached = fgThread != 0 && fgThread != cur && AttachThreadInput(cur, fgThread, true);
    SetForegroundWindow(h);
    if (attached) AttachThreadInput(cur, fgThread, false);
  }
  public static IntPtr Find(uint pid, string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid) {
        var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
        if (sb.ToString() == title) { found = h; return false; }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static uint ForegroundPid() { uint p; GetWindowThreadProcessId(GetForegroundWindow(), out p); return p; }
}
"@
$h = [W]::Find([uint32]$TargetPid, $Title)
if ($h -eq [IntPtr]::Zero) { '{"error":"window not found"}'; exit 1 }
switch ($Action) {
  'minimize' { [void][W]::ShowWindow($h, 6) }
  'restore'  { [void][W]::ShowWindow($h, 9) }
  'hide'     { [void][W]::ShowWindow($h, 0) }
  'show'     { [void][W]::ShowWindow($h, 5) }
  'focus'    {
    if ([W]::IsIconic($h)) { [void][W]::ShowWindow($h, 9) }
    [W]::Foreground($h)
  }
  'blur'     {
    # The foreground lock can refuse a plain request depending on how this process was started, so escalate.
    [W]::Foreground([W]::GetShellWindow())
    Start-Sleep -Milliseconds 300
    if ([W]::ForegroundPid() -eq $TargetPid) { [W]::SwitchToThisWindow([W]::GetShellWindow(), $true); Start-Sleep -Milliseconds 300 }
    if ([W]::ForegroundPid() -eq $TargetPid) {
      # Last resort: a real Alt+Tab handled by the OS switcher (never a lone Alt tap, which stalls the page).
      [W]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [W]::keybd_event(0x09, 0, 0, [UIntPtr]::Zero)
      [W]::keybd_event(0x09, 0, 2, [UIntPtr]::Zero); [W]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    }
  }
}
Start-Sleep -Milliseconds 400
$fg = [W]::ForegroundPid()
(@{ action = $Action; visible = [W]::IsWindowVisible($h); iconic = [W]::IsIconic($h); appIsForeground = ($fg -eq $TargetPid) } | ConvertTo-Json -Compress)
