# Antigravity Context Pro

[English](README.md) | **简体中文**

适用于 **Antigravity 2.0 桌面端**（支持 macOS、Windows、Linux）的上下文监控与底层性能遥测增强插件，包含 **聊天框内嵌上下文小圆环（含极简性能浮窗）** 与 **右侧边栏上下文账单 + DeepSeek Harness 风格单轮调用检查器**。

> [!NOTE]
> **致谢与来源说明（Fork Attribution）**
> 本项目侧边栏与基础解析器 **Fork 自 [`dimitr-io/antigravity-desktop-context`](https://github.com/dimitr-io/antigravity-desktop-context)**（原作者 Dimitrios Ioannidis，遵循 [MIT License](LICENSE)），并在此基础上进行了深度二次开发与问题修复。

![CLI 与侧边栏对比](docs/img/cli-vs-panel.png)

---

## 核心功能

- **聊天框内嵌上下文小圆环与性能浮窗**
  - 在聊天输入框右下角（发送按钮旁）内嵌实时上下文占用小圆环（`%`）。
  - 点击小圆环弹出克制、紧凑的性能概览浮窗，直观展示：**输出速度（`Output speed`）**、**首 Token 延迟（`TTFT`）**、**预填充吞吐（`Prefill throughput`）**、**缓存命中率（`Cache hit`）**、**上轮输出与会话累计输出**，并提供一键展开右侧详情面板入口。
- **交互式上下文增长曲线（Tokens vs. Turn）**
  - 原生 SVG 实时绘制整个会话的上下文增长曲线（横轴为 `turn` 轮次，纵轴为 `context` 上下文 Token 数）。
  - 自动标注用户提问节点、缓存复用以及上下文压缩回落（Compaction drop）。
  - 支持悬浮准星实时探针与点击曲线节点联动展开下方的单轮调用详情。
- **单轮调用详情检查器（DeepSeek Harness 风格）**
  - 在右侧面板的 **Recent turns** 列表中，点击任意一轮调用即可展开该轮完整底层数据：
    - **上下文与预填充（Context & Prefill）**：总输入 Prompt、缓存命中 Token 与新增输入拆分、本轮上下文增量（`Delta +tok`）、预填充速度。
    - **输出与耗时（Output & Latency）**：思考链（`Thinking`）与正文（`Response`）Token 拆分、首字等待（`TTFT`）、流式生成耗时、总耗时及输出速度。
    - **本轮工具调用账单（Tool Calls）**：列出该轮执行的全部工具（如 `read_file`、`edit_file`、`run_command`）、目标文件/行号或命令摘要，以及**每个工具调用新增的精确上下文 Token 数（`+tok`）**。
    - **内容摘要**：展示触发该轮的用户提问、模型思考链摘要与回复正文摘要。
- **零额外开销的精确上下文账单**
  - 直接只读解析 Antigravity 2.0 底层 SQLite 数据库（`steps` 与 `gen_metadata` 表中的 Protobuf 记录），与 `agy /context` 完全一致，刷新过程零 Token 消耗。
  - 提供 100 格上下文矩阵图、按分类统计的 Token 账单、活跃检查点（Checkpoints）以及已加载的规则/技能/产物文件列表。
- **原生生命周期（零系统常驻进程）**
  - 小圆环注入器直接由 Antigravity 内置的 Sidecar 进程（`main.mjs`）托管：**打开 Antigravity 自动启动，退出 Antigravity 自动停止**，不在系统中留存任何常驻后台守护进程。

---

## 安装方法

依赖环境：**Antigravity 2.0 桌面端** 及系统 `PATH` 中可用的 **Python 3**（`python3`、`python` 或 `py`）。

### 1. 克隆到 Antigravity 插件目录

**macOS / Linux**
```bash
git clone https://github.com/pigzzz104/antigravity-context-pro.git ~/.gemini/config/plugins/desktop-context
```

**Windows (PowerShell)**
```powershell
git clone https://github.com/pigzzz104/antigravity-context-pro.git "$HOME\.gemini\config\plugins\desktop-context"
```

### 2. 启用插件

1. 重启 Antigravity 2.0。
2. 进入左侧 **Customizations → Installed**，开启 **Context Usage**。
3. 打开任意对话，聊天框右下角即会自动显示**上下文小圆环**；点击小圆环浮窗底部的 `Open Context & Turn Inspector`（或在右侧栏 `+` 新建标签页列表中点击 `Context Usage`）即可打开侧边栏详情。

---

## 相比原版（Upstream）的二次开发与修复内容

| 模块 | 原版 (`antigravity-desktop-context`) | 本项目 (`antigravity-context-pro`) |
| :--- | :--- | :--- |
| **输入框指示器** | 无（仅有右侧栏） | 输入框内嵌动态小圆环 + 极简线性 SVG 性能浮窗 |
| **生成性能遥测** | 未统计 | 完整解析输出速度 (`t/s`)、首字延迟 (`TTFT`)、预填充吞吐、缓存命中率 |
| **逐轮调用日志** | 无 | 支持点击任意轮次展开单轮详情、工具调用 Token 账单及思考/回复摘要 |
| **侧边栏打开入口** | 未显示在新建标签列表中，必须手动搜索或固定 Tab | 自动注入到右侧栏 `+` 快捷列表，并支持从小圆环浮窗一键唤醒 |
| **固定 Tab 与切换对话** | 固定后切换对话不更新，或报 `no-conversation` 错误 | 实时同步主窗口当前激活对话 ID，切换历史对话时面板自动无缝跟随 |
| **无工作区模式加载** | 在 `Outside of Project` 模式下因 `getWorkspaceUris` 永久卡死在 `Loading…` | 移除阻塞等待，所有模式下均 `< 200ms` 秒开 |
| **工具 Token 统计** | `read_file` 等工具仅统计参数长度（误显示为 `32 tok`） | 补齐工具返回内容字节统计，真实反映文件读取对上下文的占用 |

---

## 命令行调用与测试

解析脚本也可在终端中独立运行：

```bash
# 查看最近活跃对话的终端版报告
python3 sidecars/context/context_report.py

# 输出包含性能遥测与逐轮明细的完整 JSON
python3 sidecars/context/context_report.py --json

# 运行单元测试
python3 -m unittest discover tests
```

## 开源协议

[MIT License](LICENSE) — 原版代码版权归 Dimitrios Ioannidis (`dimitr-io/antigravity-desktop-context`) 所有；二次开发与增强部分同样以 MIT 协议开源。
