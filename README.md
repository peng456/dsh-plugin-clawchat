# dsh-plugin-clawchat

让 DeepSeek Harness 成为 ClawChat 里的一个 agent —— **自己持有连接，不需要 ClawChat 桌面 App**。

装上之后，dsh 一起来就自动连上；你在 ClawChat 里给它发消息，它用一轮 headless dsh 回答你。

```
ClawChat 服务器
   │  WebSocket（本插件自己持有）
   ▼
dsh 进程内的 clawchat 插件
   │  每收到一条你的消息
   ▼
spawn 一轮 headless 命令（默认 dsh --profile headless）
   │  stdout = 回复
   ▼
发回同一个会话
```

## 为什么需要它

ClawChat 官方给 dsh 准备的是**桌面托管**那条路：ClawChat 桌面 App 持有 WebSocket，dsh 只负责跑对话。那条路能用，但有两个约束 ——

- **App 关着就离线**，而且离线期间的消息不会补发；
- App 和 dsh 必须是它安排的那种搭配。

这个插件走的是**自持**那条路（官方 wiki 里叫 DIY lane）：连接由 dsh 自己拿着。App 可以完全不装。

## 安装

```bash
# 在你要用的 profile 目录里
cd ~/.dsh/profiles/<你的 profile>
pnpm add dsh-plugin-clawchat
# 或本地路径：pnpm add /path/to/dsh-plugin-clawchat
```

然后把插件加进该 profile 的 `package.json`：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-plugin-clawchat"
      ]
    }
  }
}
```

重启 dsh。

> `desktop` profile 由 DSH Desktop 独占管理，`dsh plugin --profile desktop` 会被拒绝；要装就手工改它的 `package.json`，或者装到别的 profile。

## 配对

第一次需要一个 connect code（在 ClawChat App 里 Add Agent 生成）：

```yaml
- id: clawchat
  config:
    connectCode: 'XXXXXXXX'
```

配对成功后**把它删掉** —— 码是一次性的，留着只会在状态文件被清掉时诱发重复配对（会在你联系人里多出一个 agent）。

配对时用的 `X-Device-Id` 会被服务器记下，之后**每一次** REST 调用都必须逐字节一致。如果你的身份原本是 ClawChat 桌面 App 配对的，必须显式指定它当时用的值：

```yaml
    restDeviceId: 'clawchat-desktop-local-agents'
```

否则 token 刷新会返回 `10003` —— 而那个码和「凭据被吊销」**完全同一句话**，客户端会误判成需要重新配对。这条坑很贵，已在下面「已知的坑」里详述。

## 配置

写在**你自己 profile** 的 `cordis.patch.yml` 里，按 id 覆盖（不要改插件自带的那个文件）：

```yaml
- id: clawchat
  config:
    # 身份状态（含 token，按密钥对待）
    stateFile: '~/.clawchat/state.json'

    # 单持有者锁
    lockFile: '~/.clawchat/holder.lock'
    takeover: false

    channel: 'dsh-clawchat'
    restDeviceId: ''

    # 跑一轮的命令：prompt 从 stdin/argv 进，回复从 stdout 出
    command: 'dsh'
    args: ['--profile', 'headless']
    cwd: ''
    turnTimeoutMs: 600000

    greeting: "你好！我已经上线了。"

    # 滚动对话记录（见下）
    historyMaxTurns: 12
    historyMaxChars: 6000

    logFile: '~/.clawchat/channel.log'
```

| 字段 | 说明 |
|---|---|
| `stateFile` | tokens + WS device id。**当密钥对待** |
| `lockFile` | 单持有者锁；本机所有持有者必须用同一个路径 |
| `takeover` | `true` = 无视已有持有者强行连接。会引发 4001 互踢 |
| `channel` | 通道名，参与 WS device id 推导。改了会被当成新设备 |
| `restDeviceId` | REST 常量，**必须与配对时一致**（见上） |
| `command` / `args` / `cwd` | 跑一轮的命令。建议写**绝对路径** —— GUI 启动的进程 PATH 很干净 |
| `turnTimeoutMs` | 单轮超时，超时 SIGKILL 并发送已有输出 |
| `greeting` | 首次配对成功后发一次；空串 = 不发 |
| `historyMaxTurns` | 滚动记录保留几轮；`0` = 关闭 |

### 换个 runtime 也能用

`command` 不绑定 dsh。任何有非交互模式的 CLI 都行：

```yaml
    command: 'claude'
    args: ['-p']
```

```yaml
    command: 'codex'
    args: ['exec']
```

## 两个必须知道的行为

### ① 一条身份只有一个持有者

ClawChat 的一条身份只允许一个活跃连接。两个持有者**不会**共享，而是服务器用 close code `4001` 踢掉其中一个，被踢的按退避重连、再把身份抢回来 —— 如此往复，**不会自己收敛**。

所以本插件启动时先抢一把锁文件：

- 抢到 → 正常连接；
- 没抢到（本机已有别的持有者，例如 launchd 常驻桥接、另一个 dsh 实例、旧插件残留进程）→ **保持待命不连接**，并把持有者写进日志。

这就是「插件和常驻桥接可以共存」的实现方式：先到先得，谁也不踢谁。想让插件强行接管，设 `takeover: true`。

锁的存活判定看 **pid 是否还活着**，而不是时间戳 —— 被 `SIGKILL` 的持有者会留下锁文件，按时间判会白等一个超时，按 pid 判则立刻回收。

### ② 出厂 headless profile 没有会话续接

`dsh --profile headless` 一次一轮、**不支持 `--resume`**（实测报 `unknown option '--resume'`）。不处理的话每一轮都是全新会话：它会说「我看不到之前的对话」，而且每轮都要从零重新探索（实测一轮可达 140 秒）。

所以插件在自己这侧维护一份**滚动对话记录**（`historyMaxTurns` / `historyMaxChars`），把最近的往来折进 prompt。实测有效：第 1 轮告知的事实，第 2 轮能正确回忆。

代价是每轮重发上下文。如果你的 runtime 本身支持会话续接（`claude -p --resume` 之类），把它写进 `args` 并把 `historyMaxTurns` 设为 `0` 更省。

## 已知的坑

- **REST device id 必须与配对时逐字节一致。** 不一致时刷新返回 `10003 invalid refresh token`，和「凭据被吊销」**同码同一句话** —— 服务端**故意**让两者不可区分，所以无法从错误信息判断，只能靠规则。实测：用无效 token 分别在正确/错误的 device id 下请求，返回完全相同。
- **Node 必须 ≥ 22.18.0。** 更低的版本（包括 22.4.0）让 `import.meta.main` 是 `undefined`，dsh 会**退出码 0 但什么都不打印** —— 静默失败。本插件自身只要求 22+，但默认命令 `dsh` 有这个更硬的下限。
- **WS device id 不要重新推导。** 要沿用状态文件里服务器回显过的值。用随机值/时间戳/pid 拼出来的 id 会让每次重连都被当成新设备：服务器重放你整个离线收件箱，而且每个用过的 id 都会永久占一个重放位、拖住服务端清理。
- **`fetch` 只保留入站消息。** 读到空不代表你发出去的消息没送到。
- **首轮问候只发一次。** 记录写在 `message.ack` **到达之后**，不是发送时 —— 否则一次网络抖动就会变成永久沉默。
- **推理过程走 stderr。** dsh 把 reasoning 写到 stderr，单轮可达 40KB。那是诊断输出，不是错误；日志只留前 600 字符摘要。

## 测试

```bash
npm install
npm test
```

49 项离线测试，不需要网络、凭据或 dsh 进程，覆盖那几处**错了也不会报错**的地方：入站九步过滤链、路由顺序（`permission_result` 必须早于过滤链，且只在 `payload.metadata` 里）、重连退避（接管地板精确等于 `[5,10,20,40,80,160,320,600,600]`）、`hello-fail` 分类（只有 `authentication failed` 是终态）、分片切分、单持有者锁、轮次串行化。

`npm run check` 做语法检查。

## 协议来源

ClawChat 的线协议来自 **ClawChat Connection Wiki**
（`https://agent-connection.clawling.com`，快照 `2026-10-08-bc1f98a`），
该 wiki 明确说明它发布的参考实现**可以照抄**。本仓库的协议层是据此重写的独立实现，
常量与章节在源码注释中逐条标注（`connect/03-handshake.md` 等）。

本插件与 ClawChat 官方无隶属关系。

## License

MIT
