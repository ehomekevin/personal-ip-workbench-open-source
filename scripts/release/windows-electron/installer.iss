[Setup]
AppId=org.chuangzuoyoushu.desktop
AppName=创作有数
AppVersion={#AppVersion}
AppPublisher=ehomekevin
DefaultDirName={localappdata}\Programs\Chuangzuoyoushu
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
DisableDirPage=yes
DisableProgramGroupPage=yes
OutputBaseFilename=chuangzuoyoushu-{#AppVersion}-windows-x64-setup
SetupIconFile=icon.ico
UninstallDisplayIcon={app}\Chuangzuoyoushu.exe
VersionInfoVersion={#AppVersion}.0
VersionInfoDescription=创作有数安装程序
Compression=lzma2/fast
SolidCompression=yes
RestartApplications=no

[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs

[Icons]
Name: "{userprograms}\创作有数"; Filename: "{app}\Chuangzuoyoushu.exe"; AppUserModelID: "org.chuangzuoyoushu.desktop"

[Run]
Filename: "{app}\Chuangzuoyoushu.exe"; Description: "启动创作有数"; Flags: postinstall nowait skipifsilent unchecked
