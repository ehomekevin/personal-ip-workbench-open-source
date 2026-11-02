param([string]$ExpectText,[string]$SaveText,[string]$Capture)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,System.Windows.Forms,System.Drawing
$proc=@(Get-Process Chuangzuoyoushu | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -eq '创作有数' })
if ($proc.Count -ne 1) { throw 'Expected one visible branded window' }
$ui=[Windows.Automation.AutomationElement]
$root=$ui::FromHandle($proc[0].MainWindowHandle)
function FindName([string]$name) {
  $c=[Windows.Automation.PropertyCondition]::new($ui::NameProperty,$name)
  return $root.FindFirst([Windows.Automation.TreeScope]::Descendants,$c)
}
function WaitName([string]$name) {
  for ($i=0;$i -lt 20;$i++) {$e=FindName $name;if ($e){return $e};Start-Sleep -Milliseconds 500}
  throw "Element unavailable: $name"
}
function Press([string]$name) {
  $conds=[Windows.Automation.Condition[]]@([Windows.Automation.PropertyCondition]::new($ui::NameProperty,$name),[Windows.Automation.PropertyCondition]::new($ui::ControlTypeProperty,[Windows.Automation.ControlType]::Button))
  $cond=[Windows.Automation.AndCondition]::new($conds)
  $last=''
  for ($i=0;$i -lt 35;$i++) {
    try {
      $e=$root.FindFirst([Windows.Automation.TreeScope]::Descendants,$cond)
      if ($e) {
        $a=$null
        if ($e.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$a)) {$a.Invoke();return}
        $e.SetFocus();[Windows.Forms.SendKeys]::SendWait(' ');return
      }
    } catch {$last=$_.Exception.Message}
    Start-Sleep -Milliseconds 300
  }
  throw "Could not activate $name ($last)"
}
try {
  $null=WaitName '独立验收：书架手记'
  Press '选题与创作 01'
  Start-Sleep -Milliseconds 900
  if (!(FindName '编辑核心稿')) {Press '核心稿'}
  $field=WaitName '编辑核心稿'
  $value=$field.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
  if ($value.Current.Value -ne $ExpectText) {throw 'Old draft text mismatch in visible UIA editor'}
  $field.SetFocus()
  if ($SaveText) {
    [Windows.Forms.Clipboard]::SetText($SaveText)
    [Windows.Forms.SendKeys]::SendWait('^a^v')
    Start-Sleep -Seconds 1
    if ($value.Current.Value -ne $SaveText) {throw 'Paste did not change visible editor'}
  }
  function Snap($name) {
  $b=[Windows.Forms.Screen]::PrimaryScreen.Bounds;$img=[Drawing.Bitmap]::new($b.Width,$b.Height);$g=[Drawing.Graphics]::FromImage($img)
  try {$g.CopyFromScreen($b.Location,[Drawing.Point]::Empty,$b.Size);$img.Save("$env:TEST_REPORT/$name.png")}finally{$g.Dispose();$img.Dispose()}
  }
  Snap $Capture
  if (!$SaveText) {
    Press '平台版本'
    Press '查看上版稿'
    $null=WaitName '第一次整理，先把常读的书放到桌边。'
    Snap 'search-history'
    Press '保留当前版'
    Press '素材与视频'
    Press '查看图片 本主题图片'
    $null=WaitName '本主题图片'
    Snap 'search-image'
  }
} catch {
  $root.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition) |
    ForEach-Object { $_.Current.ControlType.ProgrammaticName+' '+$_.Current.Name } | Set-Content "$env:TEST_REPORT/editor-accessibility.txt"
  throw
}
