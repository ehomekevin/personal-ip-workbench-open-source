#Requires -Version 7.0
param([Parameter(Mandatory)][string]$OutputDir)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
if (-not $IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
  throw 'Build on Windows x64 with PowerShell 7.'
}
$OutputDir = [IO.Path]::GetFullPath($OutputDir)
$package = Get-Content "$PSScriptRoot/package.json" -Raw | ConvertFrom-Json
if ($package.version -ne '0.1.2') { throw 'Unexpected desktop package version' }
$installer = "$OutputDir/chuangzuoyoushu-$($package.version)-windows-x64-setup.exe"
if (Test-Path -LiteralPath $installer) { throw "Refusing to overwrite $installer" }
New-Item $OutputDir -ItemType Directory -Force | Out-Null
$scratch = (New-Item (Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid())) -ItemType Directory).FullName

function Get-Pinned($url, $dest, $digest) {
  if (-not (Test-Path -LiteralPath $dest)) {
    $temp = "$scratch/download"
    Invoke-WebRequest $url -OutFile $temp -MaximumRetryCount 3
    if ((Get-FileHash $temp).Hash -ne $digest) { throw "Download checksum mismatch: $url" }
    Move-Item -LiteralPath $temp -Destination $dest
  }
  if ((Get-FileHash $dest).Hash -ne $digest) { throw "Checksum mismatch: $dest" }
}

try {
  $gh = 'https://github.com'
  $coreName = 'chuangzuoyoushu-0.1.1-windows-x64.zip'
  $coreZip = Join-Path (Split-Path $OutputDir) $coreName
  Get-Pinned "$gh/ehomekevin/personal-ip-workbench-open-source/releases/download/v0.1.1/$coreName" $coreZip 'a1b9c48a2ea48496be3ede3ebae4e6c839d2124a93a202cec4f66947f74822cb'
  Get-Pinned "$gh/electron/electron/releases/download/v45.2.1/electron-v45.2.1-win32-x64.zip" "$scratch/electron.zip" '7c342aee45d5b4ccafe5dfe9037028796b082735a576e21e2b4e2d8422ebb727'
  Get-Pinned "$gh/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe" "$scratch/rcedit.exe" '3e7801db1a5edbec91b49a24a094aad776cb4515488ea5a4ca2289c400eade2a'
  Get-Pinned "$gh/jrsoftware/issrc/releases/download/is-7_1_1/innosetup-7.1.1-x64.exe" "$scratch/inno.exe" '8a5a6711c3766a6e5fb74f280ba0e3551e719ce94538d901fdbd1f8f9920b3f0'

  $stage = (New-Item "$scratch/stage" -ItemType Directory).FullName
  tar.exe -xf "$scratch/electron.zip" -C $stage
  Remove-Item -LiteralPath "$stage/resources/default_app.asar"
  $app = (New-Item "$stage/resources/app" -ItemType Directory).FullName
  foreach ($file in 'package.json','main.cjs','policy.cjs','sidecar.mjs','icon.ico') { Copy-Item -LiteralPath "$PSScriptRoot/$file" $app }
  $core = (New-Item "$stage/resources/core" -ItemType Directory).FullName
  # Windows tar fails even when only scanning the old ZIP's UTF-8 launcher names.
  [IO.Compression.ZipFile]::ExtractToDirectory($coreZip, "$scratch/legacy")
  foreach ($file in 'app','web','licenses','LICENSE','THIRD_PARTY_NOTICES.md','release.json') {
    Move-Item -LiteralPath "$scratch/legacy/$file" -Destination $core
  }
  New-Item "$core/runtime" -ItemType Directory | Out-Null
  Move-Item -LiteralPath "$scratch/legacy/runtime/node.exe" -Destination "$core/runtime"
  $base = Get-Content "$core/release.json" -Raw | ConvertFrom-Json
  if ($base.commit -ne '3f85c440595f8fd3a114e34bfe3abc95edefbbd3' -or $base.nodeVersion -ne '26.9.0' -or
      (Get-FileHash "$core/runtime/node.exe").Hash -ne '8490398f5e0082772dfb0ae5a6ebdff98a97696a20cb9778b4f82eec79b6d0a1') {
    throw 'Incorrect workbench core or Node sidecar'
  }

  Rename-Item "$stage/electron.exe" Chuangzuoyoushu.exe
  if (Test-Path "$stage/electron_wer.dll") { Rename-Item "$stage/electron_wer.dll" Chuangzuoyoushu_wer.dll }
  & "$scratch/rcedit.exe" "$stage/Chuangzuoyoushu.exe" --set-icon "$PSScriptRoot/icon.ico" --set-file-version $package.version --set-product-version $package.version --set-version-string ProductName '创作有数' --set-version-string FileDescription '创作有数' --set-version-string OriginalFilename 'Chuangzuoyoushu.exe' --set-version-string InternalName 'Chuangzuoyoushu' --set-version-string CompanyName 'ehomekevin'
  $compiler = "$scratch/inno"
  $setup = Start-Process "$scratch/inno.exe" -ArgumentList "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /PORTABLE=1 /CURRENTUSER /DIR=`"$compiler`"" -Wait -PassThru
  if ($setup.ExitCode -ne 0) { throw "Inno Setup installation failed ($($setup.ExitCode))" }
  Copy-Item "$compiler/license.txt" "$core/licenses/Inno-Setup-LICENSE.txt"
  & "$compiler/ISCC.exe" "/DStageDir=$stage" "/DAppVersion=$($package.version)" "/O$OutputDir" "$PSScriptRoot/installer.iss"
  Get-FileHash -LiteralPath $installer
} finally { Remove-Item -LiteralPath $scratch -Recurse -Force }
