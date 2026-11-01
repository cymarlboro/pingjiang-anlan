# 平江安澜

水利工程概论复习软件，提供 Android 和 Windows 两端。独立仓库：`cymarlboro/pingjiang-anlan`。

## 安装

正式安装包在 [Releases](https://github.com/cymarlboro/pingjiang-anlan/releases/latest) 提供。首次发布版本为 1.0.0，版本代码 1。

- Android 8.0 及以上：`pingjianganlan-1.0.0-1.apk`。
- Windows x64：`pingjianganlan-1.0.0-windows-x64-setup.exe`。
- 与原自然地理学软件分别安装、分别存储和更新，可以并存。以后更新平江安澜时直接覆盖安装，勿先卸载。

## 复习与资料分析

内置 116 道题，覆盖 2026 年课程考纲 10 章 86 项知识点：86 道简答题、30 道判断纠错题。保留来源文件名、页码和需教师核对的标记。答案是课程资料整理稿，不是教师标准答案。完整知识点清单见 `content/hydraulic-study-notes.md`。

原间隔复习算法、题型处理、每日目标和提醒默认值保留。支持自定义称呼、资料导入、API 模型解析、答案草稿确认、备份恢复。Android 与 Windows 的模型提示词均专门分析水利工程概论资料，要求引用原文并区分水位/坝高、库容/流量、功率/电量，不编造公式、页码和工程参数。

## 项目隔离

Android 应用 ID 为 `cn.pingjianganlan.study`；Windows 应用 ID 为 `cn.pingjianganlan.study.desktop`，本地数据目录为 `%APPDATA%/PingjiangAnlan`。独立更新地址为 `https://raw.githubusercontent.com/cymarlboro/pingjiang-anlan/main/update.json`。

云端账号实现沿用原技术方案，水利资料的同步端点独立为 `pja_learning_state` / `pja_sync_commit`。独立表已部署并通过回滚式合成权限和冲突测试；两个真实设备联机验收尚未进行。详细证据见 `cloud/deployment-status.md`。用户 API Key 和登录令牌不参与资料同步。

## 持续更新

1. 修改 `content/hydraulic-study-notes.md`，运行 `python build-tools/build-hydraulic-bank.py`。`question-id-registry.json` 永久保存已有题号；删除的题号也不得重新分配。
2. 运行 `python build-tools/set-version.py 1.0.1 2`，版本代码必须递增。两端统一版本配置见 `version.json`。
3. 运行算法、题型、内容、桌面与 Android 回归测试，构建两端安装包。
4. 运行 `python build-tools/prepare-release.py`，用专属密钥签署 `update.json`，重新运行准备脚本生成源码包与校验文件。
5. 通过 `python release/publish-pingjiang.py --publish` 上传并逐文件验证。仅发布到本仓库；不允许强制推送或覆盖已发布版本。

APK 签名密钥和 Windows Ed25519 更新私钥在本机构建目录中由 Windows 用户加密保护，必须离线备份并长期保留；不在本仓库、源码包或安装包内。Windows 更新校验签名和 SHA-256，安卓同时校验包名、版本、SHA-256 与签名证书。安装仍需操作系统确认。

## 本地验证

```powershell
node algorithm-tests.cjs
node question-type-tests.cjs
node pingjiang-content-tests.cjs
cd desktop
npm ci
npm test
```

构建脚本适配当前本地 JDK17、Android SDK35、Gradle8.9 和已缓存 Electron45 环境；移动构建环境时先调整脚本中的工具路径。原始教材、课件全文、个人导入文件、账户凭据和签名私钥不公开分发。
