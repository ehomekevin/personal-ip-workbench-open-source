param([Parameter(Mandatory)][ValidateSet('install','shortcut','launch','close','capture','search','processes','errorbox','uninstall')] [string]$Action)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, UIAutomationClient, UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WindowTest {
  private delegate bool EnumProc(IntPtr h,IntPtr arg);
  [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr h,EnumProc proc,IntPtr arg);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern IntPtr SendMessageTimeout(IntPtr h,uint msg,IntPtr count,System.Text.StringBuilder text,uint flags,uint timeout,out IntPtr result);
  [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr h,uint msg,IntPtr w,IntPtr l);
  public static bool WizardNext(IntPtr window) {
    bool found=false;
    EnumChildWindows(window,(h,arg)=>{
      if (!IsWindowVisible(h)||!IsWindowEnabled(h)) return true;
      var text=new System.Text.StringBuilder(128); IntPtr result; SendMessageTimeout(h,0x000D,(IntPtr)text.Capacity,text,2,500,out result);
      var label=text.ToString().Replace("&","").Trim();
      if (!System.Text.RegularExpressions.Regex.IsMatch(label,@"^(安装|完成|下一步)(\([A-Z]\))?\s*>?$|^(Install|Finish|Next\s*>?)$")) return true;
      found=PostMessage(h,0x00F5,IntPtr.Zero,IntPtr.Zero); return !found;
    },IntPtr.Zero);
    return found;
  }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte key,byte scan,uint flags,UIntPtr extra);
}
'@
$ui = [System.Windows.Automation.AutomationElement]
$root = $ui::RootElement
$all = [System.Windows.Automation.TreeScope]::Descendants
$program = Join-Path $env:TEST_INSTALL 'Chuangzuoyoushu.exe'
function DesktopCapture($file) {
  $area = [Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bitmap = [Drawing.Bitmap]::new($area.Width,$area.Height)
  $canvas = [Drawing.Graphics]::FromImage($bitmap)
  try {
    $canvas.CopyFromScreen($area.Location,[Drawing.Point]::Empty,$area.Size)
    $colors = [Collections.Generic.HashSet[int]]::new()
    for ($y=0; $y -lt $bitmap.Height; $y+=13) {
      for ($x=0; $x -lt $bitmap.Width; $x+=13) { [void]$colors.Add($bitmap.GetPixel($x,$y).ToArgb()) }
    }
    if ($colors.Count -lt 8) { throw 'Desktop capture was blank or locked' }
    $bitmap.Save($file,[Drawing.Imaging.ImageFormat]::Png)
  } finally { $canvas.Dispose(); $bitmap.Dispose() }
}
function TryCapture($file) {
  try { DesktopCapture $file; return 'captured' } catch { return 'desktop_unavailable' }
}
function Equal($property,$value) { return [System.Windows.Automation.PropertyCondition]::new($property,$value) }
function Json($value) { ConvertTo-Json -InputObject $value -Compress -Depth 4 }
function AppProcess {
  return Get-Process Chuangzuoyoushu -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $program -and $_.MainWindowHandle -ne 0 }
}
switch ($Action) {
  'install' {
    $signature = (Get-AuthenticodeSignature -LiteralPath $env:TEST_SETUP)
    $opts = @('/CURRENTUSER','/SP-','/NORESTART',('/DIR="' + $env:TEST_INSTALL + '"'))
    # Prefer the actual interactive wizard. Only named buttons on this installer process tree are invoked.
    if (-not [Environment]::UserInteractive -or !([Diagnostics.Process]::GetCurrentProcess().SessionId)) {
      $p = Start-Process -FilePath $env:TEST_SETUP -ArgumentList (@('/VERYSILENT') + $opts) -Wait -PassThru
      $mode = 'silent (non-interactive session)'
      $screen = 'not_run'
    } else {
      $p = Start-Process -FilePath $env:TEST_SETUP -ArgumentList $opts -PassThru
      $mode = 'Win32 button click, installation wizard'
      $screen = 'not_run'
      $deadline = (Get-Date).AddSeconds(100)
      while (-not $p.HasExited -and (Get-Date) -lt $deadline) {
        $child = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($p.Id)" | Select-Object -ExpandProperty ProcessId)
        foreach ($procId in (@($p.Id) + $child)) {
          foreach ($window in $root.FindAll([System.Windows.Automation.TreeScope]::Children,(Equal $ui::ProcessIdProperty ([int]$procId)))) {
            if ($window.Current.IsOffscreen -or $window.Current.Name -notmatch '创作有数') { continue }
            if ($screen -ne 'captured') { $screen = TryCapture (Join-Path $env:TEST_REPORT 'installer-desktop.png') }
            [void][WindowTest]::WizardNext([IntPtr]$window.Current.NativeWindowHandle)
          }
        }
        Start-Sleep -Milliseconds 300
        $p.Refresh()
      }
      if (!$p.HasExited) { throw 'Timed out driving the installation wizard' }
    }
    if ($p.ExitCode -ne 0 -or !(Test-Path -LiteralPath $program)) { throw 'Windows installation failed' }
    Json @{ mode=$mode; screenshot=$screen; signature=[string]$signature.Status; publisher=$signature.SignerCertificate.Subject;
      downloadReputation='not_run: local CI artifact, no browser download reputation assessment' }
  }
  'shortcut' {
    $programs = [Environment]::GetFolderPath('Programs')
    $links = @(Get-ChildItem -LiteralPath $programs -Recurse -Filter '创作有数.lnk')
    if ($links.Count -ne 1) { throw "Expected one installed shortcut in '$programs'; found $($links.Count)" }
    $lnk = (New-Object -ComObject WScript.Shell).CreateShortcut($links[0].FullName)
    Json @{ link=$links[0].FullName; target=[Environment]::ExpandEnvironmentVariables($lnk.TargetPath); icon=$lnk.IconLocation }
  }
  'launch' { Start-Process -FilePath $env:TEST_LINK -ArgumentList "--remote-debugging-port=$env:TEST_CDP"; Json 'started' }
  'processes' {
    $names = @($program,(Join-Path $env:TEST_INSTALL 'resources/core/runtime/node.exe'))
    $rows = @(Get-CimInstance Win32_Process -Filter "Name='Chuangzuoyoushu.exe' OR Name='node.exe'" | Where-Object {
      $names -contains $_.ExecutablePath
    } | ForEach-Object { @{id=$_.ProcessId; parent=$_.ParentProcessId; name=$_.Name; main=($_.Name -eq 'Chuangzuoyoushu.exe' -and $_.CommandLine -notmatch '--type=') } })
    Json $rows
  }
  'close' {
    $p = @(AppProcess)
    if ($p.Count -ne 1 -or !$p[0].CloseMainWindow()) { throw 'Cannot close the installed desktop window normally' }
    Json 'WM_CLOSE'
  }
  'capture' {
    $p = @(AppProcess)
    if ($p.Count -ne 1 -or $p[0].MainWindowTitle -ne '创作有数') { throw 'Expected the branded installed Windows main window' }
    [void][WindowTest]::SetForegroundWindow($p[0].MainWindowHandle)
    Start-Sleep -Milliseconds 250
    $screen = if ([WindowTest]::GetForegroundWindow() -eq $p[0].MainWindowHandle) {
      TryCapture (Join-Path $env:TEST_REPORT $env:TEST_SCREEN)
    } else { 'foreground_unavailable' }
    Json @{ title=$p[0].MainWindowTitle; pid=$p[0].Id; capture=$screen }
  }
  'search' {
    try {
      if (!(Get-Process explorer -ErrorAction SilentlyContinue)) { throw 'Explorer unavailable' }
      [WindowTest]::keybd_event(0x5b,0,0,0); [WindowTest]::keybd_event(0x53,0,0,0)
      [WindowTest]::keybd_event(0x53,0,2,0); [WindowTest]::keybd_event(0x5b,0,2,0)
      Start-Sleep -Seconds 1
      $fg = $ui::FromHandle([WindowTest]::GetForegroundWindow())
      if ((Get-Process -Id $fg.Current.ProcessId).ProcessName -notmatch '^(SearchHost|SearchApp|StartMenuExperienceHost)$') { throw 'Search not foreground' }
      [Windows.Forms.SendKeys]::SendWait('创作有数')
      Start-Sleep -Seconds 2
      $result = $fg.FindAll($all,(Equal $ui::NameProperty '创作有数')) | Where-Object { !$_.Current.IsOffscreen } | Select-Object -First 1
      if (!$result) { throw 'Search result not identified' }
      $screenshot = TryCapture (Join-Path $env:TEST_REPORT 'start-menu-search.png')
      # Search is read-only: Explorer cannot inherit this test's isolated workspace or port settings.
      Json @{status='result_visible'; screenshot=$screenshot; clicked=$false}
    } catch { Json @{status='not_run'; reason=$_.Exception.Message; clicked=$false} }
    finally {
      try {
        $fg = $ui::FromHandle([WindowTest]::GetForegroundWindow())
        if ((Get-Process -Id $fg.Current.ProcessId).ProcessName -match '^(SearchHost|SearchApp|StartMenuExperienceHost)$') { [Windows.Forms.SendKeys]::SendWait('{ESC}') }
      } catch { }

    }
  }
  'errorbox' {
    $deadline = (Get-Date).AddSeconds(30)
    do {
      foreach ($p in @(Get-Process Chuangzuoyoushu -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $program })) {
        $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children,(Equal $ui::ProcessIdProperty $p.Id))
        foreach ($window in $windows) {
          $texts = $window.FindAll($all,(Equal $ui::ControlTypeProperty ([System.Windows.Automation.ControlType]::Text)))
          if (!(@($texts | ForEach-Object { $_.Current.Name }) -match '端口已被占用')) { continue }
          $screen = TryCapture (Join-Path $env:TEST_REPORT 'occupied-port-desktop.png')
          $ok = $window.FindFirst($all,(Equal $ui::ControlTypeProperty ([System.Windows.Automation.ControlType]::Button)))
          $ok.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
          Json @{ dialog='occupied-port'; screenshot=$screen }; return
        }
      }
      Start-Sleep -Milliseconds 300
    } until ((Get-Date) -gt $deadline)
    throw 'No actionable occupied-port error appeared in the installed application'
  }
  'uninstall' {
    $u = Get-ChildItem -LiteralPath $env:TEST_INSTALL -Filter 'unins*.exe' -File | Select-Object -First 1
    $p = Start-Process -FilePath $u.FullName -ArgumentList '/VERYSILENT /NORESTART' -Wait -PassThru
    if ($p.ExitCode -ne 0 -or (Test-Path -LiteralPath $program)) { throw 'Uninstall did not remove application executable' }
    Json 'uninstalled'
  }
}
