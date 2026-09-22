# AdventureWorks 隔离测试库工具

此目录只管理本工具 `setup` 新建的 Windows PostgreSQL 16 测试实例，不管理网站服务或已有数据库。需要已经取得并解压的 PostgreSQL Windows x64 portable `bin/lib/share`，包括 `tablefunc` 与 `uuid-ossp` 扩展；本工具不会下载、安装或注册系统服务。

## 当前 portable 路径限制

`--bin-dir` 和 `--runtime-dir` 必须使用纯 ASCII 路径，规范化后仍需满足这一要求。当前 Windows portable 发行包在 UTF-8 初始化过程中可能用 Windows 本地代码页写入带中文的安装路径，造成 bootstrap 编码错误；工具会在创建实例前给出明确报错。

**这只是当前 PostgreSQL portable 测试工具的限制，不是网站、项目名称或上传文件名不能使用中文。** 网站工作区与 SQL 样本文件无需因此迁移。本工具不修改样本 SQL，也不把路径问题当作数据库内容问题。

## 使用

所有命令从 `site/` 执行；路径应替换为本机明确指定的位置。runtime 的父目录须存在，目标目录必须尚不存在。

```text
node scripts/test-database/adventureworks.mjs setup --runtime-dir <新建的纯ASCII绝对目录> --bin-dir <纯ASCII绝对目录/pgsql/bin> --port 55432
node scripts/test-database/adventureworks.mjs status --runtime-dir <同一目录>
node scripts/test-database/adventureworks.mjs start --runtime-dir <同一目录>
node scripts/test-database/adventureworks.mjs stop --runtime-dir <同一目录>
node --test scripts/test-database/adventureworks.test.mjs
```

- setup 默认核验并恢复根目录 `artifacts/test-databases/adventureworks-pg-2026-09-14/` 的固定 SQL；可显式传 `--dump-dir`，内容仍须匹配固定哈希。
- 成功后数据库保留运行，返回的状态不会包含密码。`credentials.private.json` 含独立管理员和只读账号凭据；网站只使用只读账号，不能导入管理员凭据。
- runtime 使用私密 ACL，凭据不进入源码或 `.env`。不要把整个 runtime 加入 Git、备份到公开位置或复制到错误日志。
- setup 遇到已有目录拒绝覆盖；失败保留所有仍存在的证据，不自动重置或重试恢复。`initdb` 本身可能清理它刚创建的未完成 data 目录，工具的 owner、credentials 与失败日志仍保留。
- 停止操作只针对已通过目录、PID、监听端口、可执行文件和集群标识检查的本工具实例，不按进程名称结束服务。stop 保留数据，不自动删除目录。
- Windows 启动等待 `pg_ctl -w` 本身退出，不等待 PostgreSQL 后代继承的输出管道关闭；长期服务日志写入私密 `postgres.private.log`。恢复用的 `psql` 仍等待完整输出结束。
- 单测只验证参数和安全边界；真实恢复、网站连接及输出端验收需要另行执行，不能用单测结果替代。

## 注册到现有开发站

先遵守网站运行约定执行 `npm run site:status`。确认实例 ready 后：

```text
node scripts/test-database/bind-dev-adventureworks.mjs <同一实例绝对目录> [项目handle，默认local]
```

注册器校验实例标记、reader 身份、受管网站归属和独立的 dev 状态目录。写入前检查目录本身已私有（Windows 允许当前身份、SYSTEM、Administrators 和创建者拥有者），不对共享目录先写秘密再补权限。它只保存 reader 凭据，不保存管理员凭据；检查现有环境连接 / 凭据冲突和合并容量，仅追加同一测试连接的项目范围，不覆盖其他连接或已被用户改变的同名配置。文件采用既有快照原子写入与并发检查，Windows 另限制私有文件 ACL。Vite 使用独立缓存，不加载 dotenv。不会改环境文件、稳定站、端口或重启服务。开发站 Notebook 的“数据库连接 → 刷新连接”即可看到 `AdventureWorks 本地测试`。

默认仅允许手动查询，不授权 AI。10 张可读表在 `CORE_TABLES` 中明确列出；数据库角色权限而非应用关键词过滤是写入安全边界。表结构、目录、显式 SQL 和保存的结果仍可能具有数据敏感性，私有运行目录不得公开提交。

## 真实数据库到输出端验收

实例处于 `ready` 且运行中时，从 `site/` 执行：

```text
node scripts/test-database/verify-adventureworks.mjs --runtime-dir <同一实例绝对目录> --evidence-dir <尚不存在的验收证据绝对目录>
```

证据目录父目录须已存在，可放在已忽略的 `site/.runtime/` 中。此脚本只使用 reader 凭据，先核对实例所有权和正在运行的进程/数据库身份；不会导入数据、修改现有网站配置或打开 HTTP 端口。它通过不监听端口的 Vite SSR 加载实际应用模块，创建独立的本地项目和状态目录，保留测试现场和 `report.json`。

验收覆盖：

- 项目范围、默认拒绝 AI、恰好 10 张授权表的真实 Schema 目录。
- 实际 PostgreSQL 查询与另一原生 `pg` 连接的独立查询结果逐行比较：31,465 张订单、38 个月和 10 个销售地区。`numeric` 原值与 `::text` 保持字符串；图表数值显式转换 `double precision`，不宣称一般 decimal 转换无损。
- Notebook 实际 API 实现执行 PostgreSQL → DuckDB 年度汇总 → 表格/图表，核对完整性标记与上游结果引用。
- 显式 Dataset 快照的类型、来源链、无 TTL、待确认 AI 授权，以及本地项目重开；Dashboard 预览、确认应用、数据绑定和撤销。
- 1,000 行截断后的下游计算/保存拒绝、数据库拒绝未授权表、取消查询后的正常重试。
- 确定性的模型测试替身驱动 Harness 的真实工具调用、数据库执行、验证和待确认草稿，保留原文档并拒绝过期版本。仅在该脚本进程内开启此测试连接的 AI 授权，不修改开发站授权。

不调用真实收费模型；脚本禁止 HTTP `fetch`。该验收证明真实数据与执行链，不评价 LLM 的生成质量，也不替代浏览器视觉、实际 HTTP/SSE 传输测试。保存的是显式快照，不是实时看板数据库绑定；Schema 版本也不等于数据库数据版本，无法获得的扫描字节数仍为 `null`。

## 真实开发站浏览器验收

```text
node scripts/test-database/browser-adventureworks.mjs <同一实例绝对目录>
node --test scripts/test-database/adventureworks.test.mjs scripts/test-database/bind-dev-adventureworks.test.mjs
```

浏览器验收只访问已经运行的 `127.0.0.1:3001`，启动自己的无头 Edge 隔离会话，阻断 AI 端点而不 Mock 数据库 / HTTP 查询。通过真实 UI 创建新测试项目，再调用上述注册器仅追加这个 handle；真实查询 10 个地区与 31,465 张订单，核对表格、图表、磁盘 Dataset、来源下载、看板预览确认和刷新重开。截图与项目保存在 `site/.runtime/hex-foundation-2026-09-16/browser-*/`，不会改已有用户项目，也不自动清理失败证据。

验收时不要并行修改应用源码、重新生成路由类型或构建，以免开发热更新中断操作。数据库不注册系统启动服务，机器重启后须用前述 `start` 显式启动本工具实例；网站服务仍只用 `npm run site:*` 管理。
