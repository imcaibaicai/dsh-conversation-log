# dsh-conversation-log

[English](README.en.md) | 简体中文

DeepSeek Harness（dsh）对话记录外置可读化插件。**每个会话自动写成可读单文件**（Markdown + JSONL 双格式）落到固定目录，文件名自带日期、时间、主题；同时维护可检索索引，支持**用一句话找回任意历史对话**。纯插件实现，不改核心、不动官方任何文件。

## 它解决什么

DSH 的会话日志是每会话一个多帧 zstd 压缩的 JSONL（`~/.dsh/sessions/<工作目录>/<会话id>/session.v3.jsonl.zstd`），外面读不了、文件名是 UUID、没有标题。时间与主题其实都在日志里（`session/title` 事件 + 记录头），缺的只是一层可读镜像。本插件就是这层镜像：

- 每会话一个 `2026-09-26_14-32_海报设计初稿_ab12cd34.md`（外加 `.jsonl` 机器版）
- MD 头部元数据表：会话 id、创建/最近活动时间、轮次、消息数、工具调用数、工作区
- 正文按轮次排版：用户消息、助手正文、思考（`<details>` 折叠）、工具调用参数与结果

## 功能

| 功能 | 用法 |
|---|---|
| 自动记录 | 无感。启动时全量扫描一次，之后每 5 秒增量：非当前会话比对文件指纹，当前会话读内存快照做内容指纹，有新事件即更新（一轮结束最多 5 秒进记录） |
| 一句话找回对话 | 对话里直接说“帮我找上次做海报设计的对话”“昨天关于 Verilog 的讨论”，模型调用 `conversation_recall` 工具模糊匹配（标题 + 关键词 + 时间词），返回候选会话与记录文件路径 |
| 设置页检索 | 设置 → 对话记录：搜索框 + 结果列表（打开会话 / 查看记录预览 / 在文件夹中显示 / 复制路径） |
| 会话 Header 按钮 | 会话右上角下载图标，随时手动保存当前会话 |
| 斜杠命令 | `/conversations [关键词]` 检索或列出；`/save-conversation [--id <id>]` 立即保存 |

## 输出位置

默认按存在性依次回退（设置页可改）：

1. `~/Documents/dsh-conversations/`
2. `<DSH_HOME>/conversation-logs/`

部署方也可在插件行的 `config.outDir` 钉到任意目录。

## 安装

```bash
dsh plugin --profile web add -w dsh-conversation-log
```

重启 DSH（host 端插件需完整重启），首次启动自动全量扫描历史会话。

## 配置

插件行 `config` 初始默认值（均可省）：

```yaml
- insert:
    - id: conversation-log
      name: 'dsh-conversation-log'
      config:
        outDir: ''              # 留空用默认回退链
        intervalSeconds: 5      # 扫描间隔 5–600
        enabled: true
        contentMode: full       # full=含思考与工具 | text=仅对话正文
        formats: [md, jsonl]
```

运行时设置（开关 / 目录 / 间隔 / 内容范围 / 格式）在 设置 → 对话记录 里改，持久化于 `<DSH_HOME>/conversation-log-settings.json`。

## 实现要点

- 读取走官方 `ctx.sessionQuery` 服务（live 优先、冷会话可读、版本归一），**自身绝不改写会话日志**
- 只收真人消息（`source.kind` 为 `user`/`steering`），自动滤掉 AGENTS.md 指令与插件运行时快照
- 兼容 v0（`assistant/chunk` 增量）与 v3（`assistant/message` 整合）两种日志格式
- 所有注册（模型工具 / 斜杠命令 / HTTP 路由 / 扫描定时器）各自独立 try/catch，插件自身故障不影响插件树
- HTTP 路由前缀 `/ds-convo`（state / settings / search / save / file / reveal），POST 带同源校验，file/reveal 严格限制在记录目录内
- 脱敏：记录默认原样；需要脱敏副本时可配合官方内置的 `@deepseek-ai/dsh-session-log-export`（`/export`）

## 卸载

删 `cordis.patch.yml` 里的 `conversation-log` 插入行 + 删包目录，重启即可。记录文件保留在输出目录，不随卸载删除。

## 兼容性

- DeepSeek Harness `0.1.5-rc.1`（web profile）
- 客户端仅 require `react` / `react/jsx-runtime`（平台基线表内）
- 插槽均为官方预留 list 槽：`settings.general.item`、`settings.section`、`conversation.session.header.utilities`

## License

MIT
