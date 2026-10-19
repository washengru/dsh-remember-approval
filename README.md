# dsh-remember-approval

> 同一会话里，**已经人工批准过**的审批请求不再重复询问。

**状态：v0.1.0 · beta** —— 目前只在 DSH 桌面版（Windows、`desktop` profile）上做过
真机验证；核心逻辑有单元测试覆盖，但其他平台/版本是否完全一致尚未验证，遇到问题
请开 issue。

**EN** — A DeepSeek Harness plugin: once you manually approve a request in a
session, later requests matching the same `tool + action prefix` are allowed
without prompting (session-scoped). DSH has no allow-always natively; this
plugin adds that memory in front of the `approval/request` waterfall. Install
by copying this folder into `~/.dsh/profiles/<profile>/node_modules/`, mounting
it in that profile's `cordis.patch.yml`, then restarting the client.

DSH 原生只支持一次性授权：审批 outcome 只有 `allowed-once` / `rejected` /
`cancelled` / `unavailable`，官方 README 写明“没有 allow-always、没有记忆规则、
没有授权存储；会话策略只有 `ask` / `never`”。所以只要沙箱拦一次，同类操作
之后仍会逐个弹窗。

本插件补上这一层：在 `approval/request` 应答者瀑布的最前面挂一个 listener。

```
审批请求 ──▶ [remember-approval] ──命中──▶ 直接 allowed-once（不弹窗）
                    │
                    └──未命中──▶ next() → 人工 UI / IM / auto-review
                                        │
                                        └─ 结果为 allowed-once → 记入本会话
```

## 行为

| 情形 | 结果 |
| --- | --- |
| 本会话内批准过「同工具 + 同动作前缀」 | 直接放行，不再询问 |
| 本会话内批准过，但工具或动作前缀不同 | 仍然会问（这是安全边界） |
| 拒绝过 / 超时 / 取消 / 无应答者 | 不记忆，下次仍然问 |
| 下游秒批（`< minHumanDelayMs`，如 Auto 档） | 判定为自动批准，不记忆 |
| `reason` 为空的请求 | 默认不记忆（无法区分同类请求） |
| 命中 `skipTools` 或 `neverRemember` | 永远人工确认 |

粒度局限（官方限制）：审批请求只带工具名、`reason`、`callId`，**不带工具参数**。
而且 `reason` 的真实形态是「动作前缀: 模型每次现写的理由」，例如
`escalate sandbox to danger-full-access: 第三次探针写入……`——冒号后的正文
每次都不一样。所以记忆键只取冒号前的**动作前缀**，正文不参与；否则同类请求
永远命中不了（真机验证时最初的版本正是栽在这里）。

这意味着一次批准会让「同工具 + 同动作前缀」的后续请求一起放行，也意味着一次
误批会让同类请求一路通行，请配合 `neverRemember` 给自己留安全阀。

## 安装

### 方式 A：插件管理器（若你的 DSH 版本支持）

先确认你的 DSH 有插件管理子命令（`dsh plugin --help` 能看到 `add`），然后：

从 GitHub 直装：

```bash
dsh plugin --profile desktop add https://github.com/washengru/dsh-remember-approval
```

或从包名装（发布到 npm 之后）：

```bash
dsh plugin --profile desktop add dsh-remember-approval
```

从本地目录安装也可以：

```bash
dsh plugin --profile desktop add ./dsh-remember-approval
```

> 这条路径依赖具体 DSH 版本的插件管理命令，作者只在方式 B 上做过真机验证；
> 方式 A 失败时请直接用方式 B。手动挂载不需要 `package.json` 里的
> `dsh.bundle.patch` 字段，删掉它也不影响方式 B。

### 方式 B：手工挂载

1. 把整个目录拷到 `%USERPROFILE%\.dsh\profiles\<profile>\node_modules\dsh-remember-approval\`
   （`<profile>` 默认是 `desktop`；Windows 上可以直接双击本目录的 `install.cmd` 一步完成）
2. 在 `%USERPROFILE%\.dsh\profiles\<profile>\cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: remember-approval
      name: dsh-remember-approval
```

3. **重启 DSH 客户端**（host 插件在启动时装配，热重载不会加载新包）。

## 配置

在 profile 的 `cordis.patch.yml` 里该 `insert` 行下加 `config:`：

```yaml
- insert:
    - id: remember-approval
      name: dsh-remember-approval
      config:
        enabled: true
        rememberEmptyReason: false   # 无理由的请求是否也记忆（默认否）
        minHumanDelayMs: 200         # 下游耗时低于此值视为自动批准，不记忆
        maxKeysPerSession: 200       # 单会话最多记多少条
        maxSessions: 64              # 最多跟踪多少会话
        skipTools: [pwsh]            # 这些工具不记忆
        neverRemember:               # reason 命中即永不记忆
          - 'danger-full-access'
          - '删除|rm -rf|format'
        log: true                    # 控制台打印命中/记忆日志
        debug: false                 # 把每次审批的调用/reason/命中写到 debugLogPath
        debugLogPath: ''             # 调试日志路径；默认系统临时目录下的 dsh-remember-approval.debug.log
```

## 卸载

从 `cordis.patch.yml` 删掉该 `insert` 条目并重启即可；没有落盘状态，
记忆只存在于内存中，随会话结束消失。

## 验证

重启后做两次同类操作（理由文字可以完全不同）：第一次会问，批准后第二次应直接
通过。打开 `debug: true` 时，`debugLogPath`（默认系统临时目录下的
`dsh-remember-approval.debug.log`）里能看到：

```
IN  tool=write scope="escalate sandbox to danger-full-access" reason="...第一次的理由"
OUT tool=write outcome=allowed-once elapsed=6308ms
HIT tool=write scope="escalate sandbox to danger-full-access" reason="...完全不同的理由"
```

## 注意

- 只影响 `approval/request`；「沙箱拒绝（denial）」是另一条接缝，不受影响。
- 记忆作用域是会话：同一会话内有效，跨会话不继承。
- 本插件只是减少重复确认，不改任何权限默认值；如果想让模型在越界时随时
  “再做一次”，需要下游应答者（人工 UI）仍然在第一次出现时明确批准。
- **建议给自己设一道安全阀**：把最敏感的动作放进 `neverRemember`，让它们永远
  人工确认，即使你之前批准过。例如：

  ```yaml
  neverRemember:
    - 'escalate sandbox'
    - 'danger-full-access'
    - '删除|rm -rf|format|drop'
  ```

  这样升权、删除类操作不会被“记住”，只有其余高频的温和操作才享受免重复询问。
  代价是这几类仍然每次弹窗——但它们本来就应该每次由人看一眼。
