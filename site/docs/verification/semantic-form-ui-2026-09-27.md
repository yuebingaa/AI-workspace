# 基础控件与语义模型表单验收 · 2026-09-27

已在 3001 使用独立浏览器、独立本地项目和两份合成 CSV 完成验收。脚本为 `scripts/verify-semantic-form-ui.mjs`；最终目录为 `.runtime/semantic-form-ui-20260927/browser-1790439274941/`。不读取用户项目，不调用外部模型、数据库或 Notebook 执行接口；AI 配置状态为无凭据的合成回执。

## 实现与范围

- `components/ui/` 统一按钮、表单字段、普通弹窗、确认弹窗和搜索选择；`app/ui-controls.css` 使用现有主题变量、可见键盘焦点和减少动态效果偏好。引入固定版本 `@radix-ui/react-dialog@1.1.23`、`@radix-ui/react-alert-dialog@1.1.23`、`cmdk@1.1.1`，复用已有 Radix Popover；依赖及 pnpm 锁文件已更新。
- `SemanticModelManager.tsx` 与 `app/semantic-models.css` 使用三段布局、可搜索字段、固定操作区、真实计算预览；新增 `semantic-form.ts` 将输入校验映射为字段旁的中文提示，已有核心保存和计算验证继续执行。
- 尚未迁移全站其他表单、整张数据表和 Notebook 工具栏；未改 Agent 架构、语义模型契约、存储格式或删除引用保护。

## 最终实际截图

以下 9 张图片均已由主代理通过图片工具逐张查看。字段值和模型名称均为本次合成数据。

| 截图 | 场景与结论 |
| --- | --- |
| [01 初始表单](../../.runtime/semantic-form-ui-20260927/browser-1790439274941/01-empty-form-1440.png) | 层级、空态、统一控件与固定底栏可读。 |
| [02 必填错误](../../.runtime/semantic-form-ui-20260927/browser-1790439274941/02-required-error-1440.png) | 缺少名称和指标均在对应位置提示；焦点落在名称输入框，未保存模型。 |
| [03 搜索无结果](../../.runtime/semantic-form-ui-20260927/browser-1790439274941/03-search-empty-1440.png) | 搜索空态可见；另实际验证 Escape 关闭并回到触发按钮、ArrowDown 打开和 Enter 选择。 |
| [04 重复标识](../../.runtime/semantic-form-ui-20260927/browser-1790439274941/04-duplicate-key-1440.png) | 维度和指标的相同标识均标红并提示；修改后错误消失。 |
| [05 预览成功](../../.runtime/semantic-form-ui-20260927/browser-1790439274941/05-preview-success-1440.png) | 实际 DataRecipe 分组：华东 100 + 50 = 150，华南 80；字号 12 px。 |
| [06 更换来源确认](../../.runtime/semantic-form-ui-20260927/browser-1790439274941/06-source-confirmation-1440.png) | 站内嵌套确认可读，默认焦点在保留当前数据表。 |
| [07 取消来源切换](../../.runtime/semantic-form-ui-20260927/browser-1790439274941/07-source-cancelled-1440.png) | 原数据源仍可见，成员和标识保留通过实际控件值验证。 |
| [08 保存后重开 1024](../../.runtime/semantic-form-ui-20260927/browser-1790439274941/08-saved-model-1024.png) | 本地项目实际持久化成功；确认更换来源只重置草稿，取消编辑后重开恢复已保存内容，模型库与删除影响提示仍可见。 |
| [09 预览 1024](../../.runtime/semantic-form-ui-20260927/browser-1790439274941/09-preview-1024.png) | 预览数据清楚，正文无横向溢出、底栏完整；外层 Escape 关闭已验证。 |

完整布局数据和断言见[机器报告](../../.runtime/semantic-form-ui-20260927/browser-1790439274941/report.json)。保存证据来自实际隔离项目 API 的模型读取及比较，不能仅以截图证明持久化。最终 0 页面错误、0 意外 API / 外部请求。

## 检查和限制

- 5 个相关测试文件 40 项通过，包括 6 项新增校验反馈用例、领域语义计算、引用保护和工作区操作。
- `npm run typecheck`、目标文件严格 ESLint、`npm run build` 通过；构建前 Agent 指纹检查通过（236 个文件），保留已有大 chunk 提示。此次未运行全量测试。
- 初次校验单测发现错误过滤条件吞掉保留标识提示，已收窄为仅跳过组级重复提示。浏览器首轮发现 cmdk 隐藏标签覆盖自定义名称，已修正；随后脚本补齐异步焦点 / 视口绘制等待，以及确认弹窗开启时对被隐藏父弹窗的布局定位。早期失败目录保留，不作为最终验收。
- 最终截图复查发现表格继承旧小字号，已显式改为 12 px 并重新完成全部浏览器场景及生产构建。未为只读角色、忙碌状态或真实外部模型另作本轮端到端验收，不宣称已验证这些场景。
- 仅当前源码和 3001 生效；未发布到 3000，未手动启停任何既有服务。
