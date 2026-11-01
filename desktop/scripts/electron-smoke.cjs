"use strict";
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { app, BrowserWindow, safeStorage } = require("electron");
const root = process.env.SCJ_SMOKE_ASAR || path.resolve(__dirname, "..");
if (!path.isAbsolute(root) || (process.env.SCJ_SMOKE_ASAR && !path.resolve(root).startsWith("D:\\ShanyuejiDesktopBuild\\"))) throw Error("Dedicated build path required");
const dataRoot = process.env.SCJ_SMOKE_DATA;
if (!dataRoot || !path.isAbsolute(dataRoot) || !path.resolve(dataRoot).startsWith("D:\\ShanyuejiDesktopBuild\\")) throw Error("Dedicated D: test directory required");
app.disableHardwareAcceleration();
// Isolated smoke profile must not reuse the user's already-running app window.
app.requestSingleInstanceLock = () => true;
BrowserWindow.prototype.show = function() {};
const originalGetAppPath = app.getAppPath.bind(app);
app.getAppPath = () => root;
require(path.join(root, "src/main/main.cjs"));
app.setPath("userData", dataRoot);
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
const timer = setTimeout(() => { console.error("Smoke timeout"); app.exit(1); }, 60000);
(async () => {
 await app.whenReady();
 let win;
 for(let i=0;i<100;i++){ win=BrowserWindow.getAllWindows()[0]; if(win && !win.webContents.isLoadingMainFrame() && win.webContents.getURL().endsWith("index.html"))break; await delay(100); }
 assert.ok(win, "window exists");
 await delay(600);
 const call = (method,payload={}) => win.webContents.executeJavaScript("window.NativeApp.call("+JSON.stringify(method)+","+JSON.stringify(payload)+")");
 const initial=await win.webContents.executeJavaScript(`(() => ({url:location.href,bridge:typeof window.AndroidBridge.request,platform:window.AndroidBridge.platform, nodeType:typeof require,questions:window.STUDY_DATA.questions.length,tabs:Array.from(document.querySelectorAll('.tab-button')).map(b=>b.dataset.tab),error:document.querySelector('#storage-warning').hidden?null:document.querySelector('#storage-warning').textContent}))()`);
 assert.equal(initial.url,"app://bundle/index.html"); assert.equal(initial.nodeType,"undefined"); assert.equal(initial.platform,"windows"); assert.equal(initial.questions,116); assert.deepEqual(initial.tabs,["review","select","stats","me"]); assert.equal(initial.error,null);
 const identity=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));assert.equal(require(path.join(root,'src/main/security.cjs')).APP_ID,'cn.pingjianganlan.study.desktop');assert.equal(identity.version,'1.0.0');
 const water=await win.webContents.executeJavaScript('({title:document.title,valid:window.STUDY_DATA.questions.every(q=>q.id>=200001&&q.answer&&q.locator),chapters:new Set(window.STUDY_DATA.questions.map(q=>q.chapter)).size})');assert.ok(water.title.includes('平江安澜'));assert.equal(water.valid,true);assert.equal(water.chapters,10);
 for(const file of ['index.html','app.css','app.js','study-data.js','generated-answers.js','question-images.js','question-types.js','question-type-support.js','native-adapter.js','memory-scheduler.js','ai-settings.js','cloud-account.js','cloud-sync.js'])assert.deepEqual(fs.readFileSync(path.join(root,'build/renderer',file)),fs.readFileSync(path.resolve(__dirname,'../../preview',file)),file);
 const policy=require(path.join(root,'src/main/update-policy.cjs'));assert.ok(policy.DEFAULT_UPDATE_MANIFEST_URL.includes('cymarlboro/pingjiang-anlan/'));assert.equal(policy.verifyWindowsSignature(JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../update.json'),'utf8'))),true);
 for(const tab of initial.tabs){await win.webContents.executeJavaScript("document.querySelector('[data-tab="+tab+"]').click()");await delay(50);assert.ok(await win.webContents.executeJavaScript("document.querySelector('#main-content').innerText.length>100"));}
 const secret="pja-SYNTHETIC-only-release-test-100";
 const mode=process.env.SCJ_SMOKE_MODE||"seed";
 if(mode==="seed"){
   const cfg=await call("saveApiConfig",{serviceName:"本地测试",baseUrl:"https://api.deepseek.com",model:"deepseek-chat",maxQuestions:5,apiKey:secret});assert.equal(cfg.hasKey,true); assert.equal(JSON.stringify(cfg).includes(secret),false);
   await call("saveReminder",{enabled:false,time:"21:16"});
   await win.webContents.executeJavaScript("document.querySelector('[data-tab=select]').click()");
   const controls=await win.webContents.executeJavaScript("({buttons:Array.from(document.querySelectorAll('#main-content button')).map(x=>x.textContent),checkboxes:document.querySelectorAll('#main-content input[type=checkbox]').length})");
   await win.webContents.executeJavaScript("localStorage.setItem('pja.smoke.persist','records-100')");
   fs.writeFileSync(path.join(dataRoot,"controls.json"),JSON.stringify(controls,null,2));
 }else{
   assert.equal((await call("getApiConfig")).hasKey,true);
   assert.equal((await call("getReminder")).time,"21:16");
   assert.equal(await win.webContents.executeJavaScript("localStorage.getItem('pja.smoke.persist')"),"records-100");
 }
 assert.equal(await safeStorage.isAsyncEncryptionAvailable(),true);
 const ciphertext=fs.readFileSync(path.join(dataRoot,"secrets","api-key.bin")); assert.equal(ciphertext.includes(Buffer.from(secret)),false);
 const result=await safeStorage.decryptStringAsync(ciphertext);assert.equal(result.result,secret);
 await win.webContents.executeJavaScript("document.querySelector('[data-tab=me]').click()");await delay(500);
 const copy=await win.webContents.executeJavaScript("document.querySelector('#native-reminder-section').innerText");assert.ok(copy.includes("保持应用运行"));assert.equal(copy.includes("系统已允许精确提醒"),false);
 fs.writeFileSync(path.join(dataRoot,"desktop-"+mode+".png"),(await win.webContents.capturePage()).toPNG());
 fs.writeFileSync(path.join(dataRoot,"result-"+mode+".json"),JSON.stringify({passed:true,mode,...initial,encryptedOnDisk:true,restartStateRetained:mode!=="seed",versions:process.versions},null,2));
 console.log(JSON.stringify({passed:true,mode,questions:initial.questions,platform:initial.platform,encryptedOnDisk:true}));clearTimeout(timer);app.exit(0);
})().catch(e=>{ console.error(e.message); clearTimeout(timer);app.exit(1);});
