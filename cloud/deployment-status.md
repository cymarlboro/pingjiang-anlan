# 独立同步服务部署与验证

2026-11-01 已在现有 Supabase 项目 rzqzvhvydmqhtcuovcco 部署平江安澜独立的同步对象。

执行 `001-sync-prerequisites.sql` 与 `004-cross-device-sync.sql`：创建私有 `pja_admin_members`、`is_pja_admin()`、`pja_sync_payload_is_safe()`、公开但受 RLS 保护的 `pja_learning_state` 和所有者约束的 CAS RPC `pja_sync_commit`。原 `scj_` 表、函数、数据和管理员名单不修改，两个软件复用认证服务但同步记录分开。

控制台返回 `Success. No rows returned`。随后执行回滚式合成账户测试，返回：

`PASS: PJA owner isolation, CAS, direct-write rejection, credentials, anon, admin; original subject untouched; all synthetic fixtures rolled back`

验证 A/B 用户隔离、伪造 user_metadata 管理员失败、匿名读写拒绝、直接写表拒绝、CAS 冲突拒绝、密钥字段拒绝、管理员仅授权读取；原学科记录数量不变。所有合成用户、临时管理员及测试学习记录均在事务末尾回滚。截图见 `../release/cloud-verification-1.0.0.jpg`。

未创建持久管理员，未读取或复制用户资料与 API Key。`SECURITY DEFINER` CAS 函数沿用原有经过检查的设计：固定 `auth.uid()`、空 search_path、仅 authenticated 执行，防止客户端直接写表。数据库权限测试通过不等于两个真实设备的联机验收；后者仍需使用者实际登录并主动开启同步后验证。
