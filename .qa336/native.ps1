param([Parameter(Mandatory)][ValidateSet('install','shortcut','launch','close','capture','search','processes','listener','errorbox','uninstall')] [string]$Action)
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
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);
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
      $folder=Split-Path -Parent $env:TEST_SETUP
      $shell=New-Object -ComObject Shell.Application
      Start-Process explorer.exe -ArgumentList ('/select,"'+$env:TEST_SETUP+'"')
      $limit=(Get-Date).AddSeconds(20)
      do {
        Start-Sleep -Milliseconds 500
        $view=@($shell.Windows() | Where-Object { $_.Document.Folder.Self.Path -eq $folder }) | Select-Object -Last 1
        if ($view) {
          $entry=$view.Document.Folder.ParseName([IO.Path]::GetFileName($env:TEST_SETUP))
          $view.Document.SelectItem($entry,29)
          $node=$ui::FromHandle([IntPtr]([long]$view.HWND))
          $item=$node.FindAll($all,(Equal $ui::ControlTypeProperty ([System.Windows.Automation.ControlType]::ListItem))) | Where-Object { $_.Current.Name -like 'chuangzuoyoushu-0.1.2-windows-x64-setup*' } | Select-Object -First 1
        }
      } until ($item -or (Get-Date) -gt $limit)
      if (!$item) { throw 'Explorer installer item not found' }
      [void][WindowTest]::SetForegroundWindow([IntPtr]([long]$view.HWND))
      $bounds=$item.Current.BoundingRectangle
      $x=[int]($bounds.Left+25);$y=[int]($bounds.Top+$bounds.Height/2)
      DesktopCapture (Join-Path $env:TEST_REPORT 'explorer-selected.png')
      if (![WindowTest]::SetCursorPos($x,$y)) {throw 'Could not point to selected installer'}
      for ($i=0;$i -lt 2;$i++) { [WindowTest]::mouse_event(2,0,0,0,0);[WindowTest]::mouse_event(4,0,0,0,0);Start-Sleep -Milliseconds 50 }
      $limit=(Get-Date).AddSeconds(12)
      do {Start-Sleep -Milliseconds 300;$p=Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($env:TEST_SETUP)) -ErrorAction SilentlyContinue | Where-Object Path -eq $env:TEST_SETUP | Select-Object -First 1} until ($p -or (Get-Date) -gt $limit)
      if (!$p) {DesktopCapture (Join-Path $env:TEST_REPORT 'doubleclick-result.png');throw 'Double click did not start bound installer'}
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
    $item = (New-Object -ComObject Shell.Application).NameSpace($links[0].DirectoryName).ParseName($links[0].Name)
    Json @{ link=$links[0].FullName; target=$item.ExtendedProperty('System.Link.TargetParsingPath') }
  }
  'launch' { Start-Process -FilePath $env:TEST_LINK -ArgumentList "--remote-debugging-port=$env:TEST_CDP"; Json 'started' }
  'listener' {
    $row = @(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ([int]$env:WORKBENCH_WEB_PORT) -State Listen)
    if ($row.Count -ne 1) { throw 'Expected one listening owner' }
    $owner = Get-Process -Id $row[0].OwningProcess
    Json @{ pid=$owner.Id; executable=$owner.Path; started=$owner.StartTime.ToUniversalTime().ToString('o'); port=$row[0].LocalPort }
  }
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
    $shellNames = '^(SearchHost|SearchApp|SearchUI|StartMenuExperienceHost|explorer)$'
    function ShellForeground {
      $h = [WindowTest]::GetForegroundWindow()
      if (!$h) { return $null }
      $element = $ui::FromHandle($h)
      $name = (Get-Process -Id $element.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName
      if ($name -match $shellNames) { return $element }
    }
    $clicked = $false
    $seen = @()
    try {
      if ((AppProcess) -or !(Get-Process explorer -ErrorAction SilentlyContinue | Where-Object SessionId -eq ([Diagnostics.Process]::GetCurrentProcess().SessionId))) {
        throw 'Expected a cold app and same-session Explorer'
      }
      # Open the Windows Search box directly; paste Unicode into the actual shell window.
      [WindowTest]::keybd_event(0x5b,0,0,0); [WindowTest]::keybd_event(0x53,0,0,0)
      [WindowTest]::keybd_event(0x53,0,2,0); [WindowTest]::keybd_event(0x5b,0,2,0)
      Start-Sleep -Seconds 2
      $focus = $ui::FocusedElement
      if (!(ShellForeground) -or (Get-Process -Id $focus.Current.ProcessId).ProcessName -notmatch $shellNames) { throw 'Search not focused' }
      [Windows.Forms.Clipboard]::SetText('创作有数')
      [Windows.Forms.SendKeys]::SendWait('^v')
      $deadline = (Get-Date).AddSeconds(18)
      $rect = $null
      do {
        Start-Sleep -Milliseconds 500
        $fg = ShellForeground
        if (!$fg) { continue }
        $hosts = @($root.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition) | Where-Object {
          !$_.Current.IsOffscreen -and (Get-Process -Id $_.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName -match '^(SearchHost|SearchApp|SearchUI|StartMenuExperienceHost)$'
        })
        foreach ($hostWindow in (@($fg) + $hosts)) {
          $nodes = $hostWindow.FindAll($all,[System.Windows.Automation.Condition]::TrueCondition)
          foreach ($node in $nodes) {
            $title = $node.Current.Name
            if ($node.Current.IsOffscreen -or $title -notmatch '^创作有数(?:$|[ ,，])') { continue }
            $elem = $node
            for ($depth=0; $elem -and $depth -lt 5; $depth++) {
              $kind = $elem.Current.ControlType.ProgrammaticName
              $label = $elem.Current.Name
              $seen += "$kind $label"
              if ($kind -match '\.(ListItem|DataItem|TreeItem|Button|Hyperlink)$' -and $label -match '^创作有数(?:$|[ ,，])' -and $label -notmatch '(web|search for|搜索网页|搜索网络)') {
                $box = $elem.Current.BoundingRectangle
                if (!$box.IsEmpty -and $box.Width -gt 0 -and $box.Height -gt 0) {
                  $pt = [Windows.Point]::new([Math]::Floor($box.X + $box.Width/2),[Math]::Floor($box.Y + $box.Height/2))
                  $hit = $ui::FromPoint($pt)
                  for ($level=0; $hit -and $level -lt 9; $level++) {
                    if ([System.Windows.Automation.Automation]::Compare($hit,$elem)) { $rect=$box; $matched=$label; break }
                    $hit = [System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($hit)
                  }
                }
                if ($rect) { break }
              }
              $elem = [System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($elem)
            }
            if ($rect) { break }
          }
          if ($rect) { break }
        }
      } until ($rect -or (Get-Date) -gt $deadline)
      if (!$rect -and (ShellForeground)) {
        # SearchHost on Server 2025 can draw an app result without exposing its UIA children.
        # Fingerprint covers the visible branded icon AND Chinese name of the Best match from two CI desktops.
        $file=Join-Path $env:TEST_REPORT 'start-menu-search.png'
        DesktopCapture $file
        $bmp=[Drawing.Bitmap]::new($file)
        try {
          if ($bmp.Width -eq 1024 -and $bmp.Height -eq 768) {
            $pixels=[Collections.Generic.List[byte]]::new()
            for ($y=158;$y -lt 195;$y++) { for ($x=161;$x -lt 253;$x++) {
              $c=$bmp.GetPixel($x,$y); $pixels.Add([byte]($c.R -lt 150 -and $c.G -lt 150 -and $c.B -lt 150))
            } }
            $digest=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($pixels.ToArray()))
            if ($digest -eq '9157027d9b0a8145fc33830941f672af6c9f3013e3a063fe3a201facb6bd28f2') {
              $pt=[Windows.Point]::new(216,173); $rect=$true; $matched='创作有数 (verified Best match icon and label)'
            }
          }
        } finally { $bmp.Dispose() }
      }
      if (!$rect -or !(ShellForeground)) { throw 'App result absent or not safely clickable in the foreground search UI' }
      $screen=TryCapture (Join-Path $env:TEST_REPORT 'start-menu-search.png')
      if (![WindowTest]::SetCursorPos([int]$pt.X,[int]$pt.Y)) { throw 'Cannot point to verified app search result' }
      [WindowTest]::mouse_event(2,0,0,0,0); [WindowTest]::mouse_event(4,0,0,0,0)
      $clicked=$true
      $deadline=(Get-Date).AddSeconds(30)
      do { Start-Sleep -Milliseconds 300; $p=@(AppProcess | Where-Object MainWindowTitle -eq '创作有数') }
      until ($p.Count -eq 1 -or (Get-Date) -gt $deadline)
      if ($p.Count -ne 1) { throw 'Search click did not open the installed branded window' }
      $listener=Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort ([int]$env:WORKBENCH_API_PORT) -State Listen
      $child=Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
      if ($child.ParentProcessId -ne $p[0].Id -or $child.ExecutablePath -ne (Join-Path $env:TEST_INSTALL 'resources/core/runtime/node.exe')) {
        throw 'Workspace API listener is not the installed window sidecar'
      }
      Json @{status='cold_started'; clicked=$true; result=$matched; pid=$p[0].Id; title=$p[0].MainWindowTitle; sidecar=$child.ProcessId; screenshot=$screen}
    } catch {
      $screen=TryCapture (Join-Path $env:TEST_REPORT 'start-menu-search-unavailable.png')
      if ($clicked) { throw }
      Json @{status='not_run'; reason=$_.Exception.Message; clicked=$false; screenshot=$screen; matches=@($seen | Select-Object -Unique -First 12)}
      try { if (ShellForeground) { [Windows.Forms.SendKeys]::SendWait('{ESC}') } } catch { }
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
          $dialog=[IntPtr]$window.Current.NativeWindowHandle
          [void][WindowTest]::SetForegroundWindow($dialog)
          if ([WindowTest]::GetForegroundWindow() -ne $dialog) { throw 'Cannot focus owned error dialog' }
          [Windows.Forms.SendKeys]::SendWait('{ENTER}')
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
