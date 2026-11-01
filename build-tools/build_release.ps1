param([int]$VersionCode=0,[string]$VersionName='',[switch]$BuildTests)
$versionConfig=Get-Content -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'version.json') -Raw | ConvertFrom-Json
if($VersionCode -eq 0){$VersionCode=$versionConfig.versionCode}
if(-not $VersionName){$VersionName=$versionConfig.versionName}
$ErrorActionPreference='Stop'
$taskBuildRoot='D:\ShanchuanjiBuild'
$signingRoot=Join-Path $taskBuildRoot 'pingjiang-release-keys'
New-Item -ItemType Directory -Force -Path $signingRoot | Out-Null
$identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $signingRoot /inheritance:r /grant:r ($identity + ':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F' | Out-Null
$secretFile=Join-Path $signingRoot 'signing-password.clixml'
$keyStore=Join-Path $signingRoot 'pingjiang-anlan-release.p12'
if (-not (Test-Path -LiteralPath $secretFile)) {
 if (Test-Path -LiteralPath $keyStore) { throw 'Keystore exists without password backup; do not replace it.' }
 $randomBytes=[Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
 $newPassword=[Convert]::ToBase64String($randomBytes)
 $secure=ConvertTo-SecureString $newPassword -AsPlainText -Force
 $secure | Export-Clixml -LiteralPath $secretFile
 $newPassword=$null
}
$secure=Import-Clixml -LiteralPath $secretFile
$credential=[Management.Automation.PSCredential]::new('release',$secure)
$env:SCJ_STOREPASS=$credential.GetNetworkCredential().Password
$env:SCJ_KEYPASS=$env:SCJ_STOREPASS
$env:SCJ_KEYSTORE=$keyStore
$env:SCJ_ALIAS='pingjiang-anlan-release'
$env:JAVA_HOME='D:\JDK17.0'
$env:GRADLE_USER_HOME=Join-Path $taskBuildRoot 'gradle-home'
$env:JAVA_TOOL_OPTIONS='-Djava.net.preferIPv4Stack=true -Djdk.net.unixdomain.tmpdir=D:/ShanchuanjiBuild/tmp'
$env:HTTP_PROXY=$null
$env:HTTPS_PROXY=$null
try {
 if (-not (Test-Path -LiteralPath $keyStore)) {
  & 'D:\JDK17.0\bin\keytool.exe' -genkeypair -keystore $keyStore -storetype PKCS12 -storepass:env SCJ_STOREPASS -keypass:env SCJ_KEYPASS -alias $env:SCJ_ALIAS -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=PingjiangAnlan Release, OU=Personal, O=PingjiangAnlan, C=CN' -noprompt *> (Join-Path $taskBuildRoot 'keytool-result.log')
  if ($LASTEXITCODE -ne 0) { throw 'Release key generation failed' }
 }
 $sourceRoot=Split-Path -Parent (Split-Path -Parent $PSCommandPath)
 $stage=Join-Path $taskBuildRoot 'pingjiang-project'
 New-Item -ItemType Directory -Force -Path $stage | Out-Null
 Copy-Item -LiteralPath (Join-Path $sourceRoot 'android'),(Join-Path $sourceRoot 'preview') -Destination $stage -Recurse -Force
 [IO.File]::WriteAllText((Join-Path $stage 'android\local.properties'),'sdk.dir=D:/ShanchuanjiBuild/android-sdk',[Text.UTF8Encoding]::new($false))
 & (Join-Path $taskBuildRoot 'gradle-8.9\bin\gradle.bat') -p (Join-Path $stage 'android') --no-daemon --console=plain ('-PscjVersionCode='+$VersionCode) ('-PscjVersionName='+$VersionName) assembleRelease *> (Join-Path $taskBuildRoot 'build-release.log')
 if ($LASTEXITCODE -ne 0) { Get-Content -LiteralPath (Join-Path $taskBuildRoot 'build-release.log') -Tail 45; throw 'Release build failed' }
 if ($BuildTests) {
  & (Join-Path $taskBuildRoot 'gradle-8.9\bin\gradle.bat') -p (Join-Path $stage 'android') --no-daemon --console=plain ('-PscjVersionCode='+$VersionCode) ('-PscjVersionName='+$VersionName) testReleaseUnitTest assembleReleaseAndroidTest *> (Join-Path $taskBuildRoot 'build-android-test.log')
  if ($LASTEXITCODE -ne 0) { Get-Content -LiteralPath (Join-Path $taskBuildRoot 'build-android-test.log') -Tail 50; throw 'Android test build failed' }
 }
 $releaseRoot=Join-Path $sourceRoot 'release'
 New-Item -ItemType Directory -Force -Path $releaseRoot | Out-Null
 $apk=Join-Path $releaseRoot ('pingjianganlan-'+$VersionName+'-'+$VersionCode+'.apk')
 Copy-Item -LiteralPath (Join-Path $stage 'android\app\build\outputs\apk\release\app-release.apk') -Destination $apk -Force
 & (Join-Path $taskBuildRoot 'android-sdk\build-tools\35.0.0\apksigner.bat') verify --verbose --print-certs $apk
 if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed' }
 Get-Item -LiteralPath $apk | Select-Object FullName,Length
 Get-FileHash -LiteralPath $apk -Algorithm SHA256
} finally {
 $env:SCJ_STOREPASS=$null
 $env:SCJ_KEYPASS=$null
 $credential=$null
}
