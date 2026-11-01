'use strict';
const fs=require('node:fs');
const crypto=require('node:crypto');
let input='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',v=>{input+=v;if(input.length>262144)process.exit(1)});
process.stdin.on('end',()=>{
 try{
  const req=JSON.parse(input.replace(/^\uFEFF/,''));
  const manifest=JSON.parse(fs.readFileSync(req.manifestPath,'utf8').replace(/^\uFEFF/,''));
  if(!manifest.windows||!Number.isSafeInteger(manifest.windows.versionCode))throw Error();
  manifest.windowsSignature=crypto.sign(null,Buffer.from(JSON.stringify(manifest.windows)),req.privateKey).toString('base64');
  const publicKey=crypto.createPublicKey(req.privateKey);
  if(!crypto.verify(null,Buffer.from(JSON.stringify(manifest.windows)),publicKey,Buffer.from(manifest.windowsSignature,'base64')))throw Error();
  fs.writeFileSync(req.manifestPath,JSON.stringify(manifest,null,2)+'\n','utf8');
  input='';console.log('Windows update manifest signed and verified.');
 }catch{input='';console.error('Signing failed; no private key or payload logged.');process.exitCode=1}
});
