param()
$ErrorActionPreference='Stop'
$source=Split-Path -Parent $PSScriptRoot
$desktopStage='D:\ShanyuejiDesktopBuild\desktop'
$stageRoot=Split-Path -Parent $desktopStage
if(-not (Test-Path -LiteralPath (Join-Path $desktopStage 'node_modules\electron-builder'))){throw 'Existing desktop build dependencies missing'}
foreach($name in @('src','scripts','test','build-resources')){Copy-Item -LiteralPath (Join-Path $source ('desktop\'+$name)) -Destination $desktopStage -Recurse -Force}
foreach($name in @('package.json','package-lock.json')){Copy-Item -LiteralPath (Join-Path $source ('desktop\'+$name)) -Destination (Join-Path $desktopStage $name) -Force}
Copy-Item -LiteralPath (Join-Path $source 'preview') -Destination $stageRoot -Recurse -Force
Copy-Item -LiteralPath (Join-Path $source 'test-fixtures') -Destination $stageRoot -Recurse -Force
$runtimeSource='D:\ShanyuejiDesktopBuild\electron-runtime-45'
$runtimeClean='D:\ShanyuejiDesktopBuild\electron-runtime-45-clean'
if((Get-Content -LiteralPath (Join-Path $runtimeSource 'version') -Raw).Trim() -ne '45.0.0'){throw 'Unexpected Electron runtime version'}
New-Item -ItemType Directory -Force -Path $runtimeClean | Out-Null
foreach($item in Get-ChildItem -LiteralPath $runtimeSource -File){
 if($item.Name -eq 'electron.exe' -or $item.Extension -in @('.dll','.pak','.dat','.bin','.json') -or $item.Name -in @('version','LICENSE','LICENSE.electron.txt','LICENSES.chromium.html')){Copy-Item -LiteralPath $item.FullName -Destination $runtimeClean -Force}
}
Copy-Item -LiteralPath (Join-Path $runtimeSource 'locales') -Destination $runtimeClean -Recurse -Force
New-Item -ItemType Directory -Force -Path (Join-Path $runtimeClean 'resources') | Out-Null
$defaultApp=Join-Path $runtimeSource 'resources\default_app.asar'
if(Test-Path -LiteralPath $defaultApp){Copy-Item -LiteralPath $defaultApp -Destination (Join-Path $runtimeClean 'resources') -Force}
$env:CSC_IDENTITY_AUTO_DISCOVERY='false'
$env:ELECTRON_BUILDER_CACHE='D:\ShanchuanjiBuild\electron-builder-cache'
Push-Location $desktopStage
try {
 & 'C:\Program Files\nodejs\npm.cmd' run dist -- --config.electronDist='D:/ShanyuejiDesktopBuild/electron-runtime-45-clean' *> (Join-Path $source 'release\pingjiang-windows-build.log')
 if($LASTEXITCODE -ne 0){Get-Content -LiteralPath (Join-Path $source 'release\pingjiang-windows-build.log') -Tail 60;throw 'Windows build failed'}
 $version=(Get-Content -LiteralPath (Join-Path $source 'desktop\package.json') -Raw | ConvertFrom-Json).version
 $exe=Join-Path $desktopStage ('dist\pingjianganlan-'+$version+'-windows-x64-setup.exe')
 if(-not (Test-Path -LiteralPath $exe)){throw 'New Windows installer not found'}
 Copy-Item -LiteralPath $exe -Destination (Join-Path $source 'release') -Force
 Get-FileHash -LiteralPath $exe -Algorithm SHA256
} finally {Pop-Location}
