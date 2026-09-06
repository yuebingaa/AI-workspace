# Harness 视觉验证

Harness 对依赖最终渲染结果的 UI、图表、布局、颜色、可读性和响应式任务执行额外视觉验收。普通代码测试或 AppSpec 检查不能代替这一步。

## 本地配置

在 `.env.local` 中配置：

```dotenv
HARNESS_VISUAL_VERIFICATION_ENABLED=1
HARNESS_VISUAL_BASE_URL=http://127.0.0.1:3102/
HARNESS_VISUAL_VERIFICATION_TIMEOUT_MS=35000
HARNESS_VISION_API_URL=https://api.openai.com/v1/chat/completions
HARNESS_VISION_API_KEY=your-server-side-key
HARNESS_VISION_MODEL=your-image-input-model
# 可选；留空时使用本机 Microsoft Edge channel
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=
```

`HARNESS_VISION_API_URL` 所指服务必须兼容 Chat Completions 的多模态消息格式，能够接收 `image_url` data URL，并支持 JSON 对象输出。

## 验证规则

- Planner 的模型语义路由判断任务是否依赖视觉结果；图表变更还会被 Verifier 的强制策略覆盖。
- Playwright 只允许访问 loopback 地址，并拦截页面向非同源网络发出的请求。
- 默认截取 1440×1000 与 900×1000 两个视口。
- 截图只在当前请求内存中传给多模态模型；任务记录只保存视口、字节数、SHA-256、模型结论和检查项。
- 截图缺失、浏览器失败、模型不可用、响应格式异常或任一视觉检查失败，`completed` 都会被拒绝并进入现有 Replan 流程。
- ChangeSet 尚未应用时，任务保持 `awaitingConfirmation`，视觉证据标记为 `deferred`，不会宣告最终渲染已经通过。

## 用户上传图片

- AI 助手输入框左下角提供“＋”图片按钮；支持 JPEG、PNG、WebP，最多 3 张，单张不超过 3 MiB、合计不超过 6 MiB。
- 图片使用 multipart 文件传输，服务端校验 MIME、文件签名、大小和 SHA-256 后，才会发送给已配置的多模态模型。
- 图片中的文字和界面内容一律作为不可信数据，只用于回答当前用户问题，不能成为系统指令、授权或工具调用要求。
- 原始图片不进入聊天正文、Working Memory、任务摘要、LocalStorage、磁盘缓存或审计记录；Harness 只接收多模态模型生成的结构化概述、可见文字、发现和不确定项。
- 用户上传图片用于理解截图、照片或图表内容；Playwright 截图用于自动验收当前工作台最终渲染，两者互不替代。
