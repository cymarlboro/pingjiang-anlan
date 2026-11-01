param([ValidateSet('init','sign')][string]$Mode='init',[string]$ManifestPath='')
$ErrorActionPreference='Stop'
$taskKeyRoot='D:\ShanchuanjiBuild\pingjiang-release-keys'
$taskPrivatePath=Join-Path $taskKeyRoot 'desktop-update-private.clixml'
$taskPublicPath=Join-Path (Split-Path -Parent $PSScriptRoot) 'release\windows-update-public-key.pem'
if(-not (Test-Path -LiteralPath $taskKeyRoot)){throw 'Existing release key directory is required'}
if($Mode -eq 'init'){
  if(-not (Test-Path -LiteralPath $taskPrivatePath)){
    $taskKeyJson=& node -e 'const c=require("node:crypto");const p=c.generateKeyPairSync("ed25519");console.log(JSON.stringify({privateKey:p.privateKey.export({format:"pem",type:"pkcs8"}),publicKey:p.publicKey.export({format:"pem",type:"spki"})}));'
    if($LASTEXITCODE -ne 0){throw 'Key generation failed'}
    $taskPair=$taskKeyJson | ConvertFrom-Json
    ConvertTo-SecureString $taskPair.privateKey -AsPlainText -Force | Export-Clixml -LiteralPath $taskPrivatePath
    [IO.File]::WriteAllText($taskPublicPath,$taskPair.publicKey,[Text.UTF8Encoding]::new($false))
    $taskKeyJson=$null; $taskPair=$null
  }
  if(-not (Test-Path -LiteralPath $taskPublicPath)){throw 'Public key missing. Do not replace private signing identity.'}
  'Windows update signing identity ready; private key protected by current Windows user.'
  Get-FileHash -LiteralPath $taskPublicPath -Algorithm SHA256 | Select-Object Hash
  exit
}
if(-not (Test-Path -LiteralPath $taskPrivatePath)){throw 'Signing identity missing'}
$taskManifestResolved=(Resolve-Path -LiteralPath $ManifestPath).Path
$taskSecret=Import-Clixml -LiteralPath $taskPrivatePath
$taskCredential=[Management.Automation.PSCredential]::new('desktop-update',$taskSecret)
try {
  $taskRequest=@{privateKey=$taskCredential.GetNetworkCredential().Password;manifestPath=$taskManifestResolved} | ConvertTo-Json -Compress
  $taskRequest | & node (Join-Path $PSScriptRoot 'sign-update-manifest.cjs')
  if($LASTEXITCODE -ne 0){throw 'Manifest signing failed'}
} finally {$taskRequest=$null; $taskCredential=$null; $taskSecret=$null}
