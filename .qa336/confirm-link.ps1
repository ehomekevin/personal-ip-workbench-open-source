$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,System.Windows.Forms,System.Drawing
$ui=[Windows.Automation.AutomationElement]
$root=$ui::RootElement;$deadline=(Get-Date).AddSeconds(10)
do {
  $ids=@(Get-Process Chuangzuoyoushu | Where-Object Path -eq "$env:TEST_INSTALL\Chuangzuoyoushu.exe" | Select-Object -ExpandProperty Id)
  $ws=$root.FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.Condition]::TrueCondition)
  $log=@()
  foreach ($w in $ws) {
    if ($w.Current.ProcessId -notin $ids){continue}
    $nodes=@($w.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition))
    $log+=@($nodes|ForEach-Object {$_.Current.ControlType.ProgrammaticName+' '+$_.Current.Name})
    if (!$log.Where({$_ -match '在浏览器打开外部链接'})) {continue}
    $button=$nodes | Where-Object {$_.Current.Name -match '^打开([(&（]|$)' -and $_.Current.ControlType.ProgrammaticName -eq 'ControlType.Button'} | Select-Object -First 1
    if (!$button){continue}
    $b=[Windows.Forms.Screen]::PrimaryScreen.Bounds;$img=[Drawing.Bitmap]::new($b.Width,$b.Height);$g=[Drawing.Graphics]::FromImage($img)
    try {$g.CopyFromScreen($b.Location,[Drawing.Point]::Empty,$b.Size);$img.Save("$env:TEST_REPORT/external-confirm.png")}finally{$g.Dispose();$img.Dispose()}
    $button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
    'confirmed';return
  }
  Start-Sleep -Milliseconds 300
}until ((Get-Date) -gt $deadline)
$log|Set-Content "$env:TEST_REPORT/dialog-tree.txt"
$b=[Windows.Forms.Screen]::PrimaryScreen.Bounds;$img=[Drawing.Bitmap]::new($b.Width,$b.Height);$g=[Drawing.Graphics]::FromImage($img)
try {$g.CopyFromScreen($b.Location,[Drawing.Point]::Empty,$b.Size);$img.Save("$env:TEST_REPORT/external-dialog.png")}finally{$g.Dispose();$img.Dispose()}
throw 'Did not identify owned confirmed-link button'
