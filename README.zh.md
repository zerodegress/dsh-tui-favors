# dsh-tui-favors

给 dsh-TUI 钉住「开新对话时的四个默认值」：**模型路由、推理强度、agent preset、权限模式**。

装好之后，每次启动 dsh-TUI、每次 `/new`，对话都从你指定的这四个值开始——即使上一次会话里用 `/model`、`/effort`、`/preset`、`/permission` 换过别的，下一个对话也会自动回到你钉住的那组。

## 它是怎么做到的

dsh-TUI 自己就把这四项的「标准默认值」放在四个持久化文件里，启动和每次 `/new` 都会重新读：

| 旋钮 | 文件 | dsh-TUI 何时读它 |
| --- | --- | --- |
| 模型 | `~/.dsh-tui/model.json` `{provider, model}` | 启动 + 每次 `/new`（完整一对才生效；优先级高于 `cordis.yml` 的 `provider`/`model`） |
| 推理强度 | `~/.dsh-tui/effort.json` `{effort}` | 启动时（通道建立）一次，之后每个会话绑定都套用 |
| preset | `~/.dsh-tui/agent-preset.json` `{preset}` | 启动 + 每次 `/new` |
| 权限模式 | `~/.dsh-tui/permission.json` `{permission}` | 每次会话绑定（只对「自己没选过权限面」的新会话生效，走官方 `/permission` 路径） |

这四个文件本来是「上一次的选择」记忆：你用 `/model` 挑个别的，文件就被改写。**本插件把这份记忆变成固定偏好**——启动时写入你的收藏值，并在 `pin` 模式下持续把它改回去，于是任何新对话都会落在收藏值上。

插件是宿主侧的一个 Cordis row，`apply` 里**同步**写完这四个文件。dsh-TUI 的运行时 row 会等整棵 loader 树落定后才去读这些文件，所以收藏值先落地、再被读取，不需要任何拦截或授权。

## 安装

在 TUI 里：

```
/plugin install github:zerodegress/dsh-tui-favors
```

安装后**重启 dsh-TUI**：`apply` 在启动时执行。

## 配置

收藏值有两层，**同一个形状**（同样的键、同样的校验）：`~/.dsh-tui/favors.json` 优先于 profile 里那行的 `config`，逐键覆盖。

### 第 1 层：profile 的 `cordis.patch.yml`

配置写在这个 bundle 的 row 上——在你自己 profile 的 `cordis.patch.yml` 里按 id 覆盖，这样本机路由不会进包：

```yaml
- id: dsh-tui-favors
  name: dsh-tui-favors
  config:
    enabled: true
    provider: <provider>
    model: <model-id>
    effort: max
    preset: standard
    permission: workspace-write
    pin: true
    pollMs: 2000
```

### 第 2 层：`~/.dsh-tui/favors.json`（日常改这里）

和 `model.json` 那几个文件放在一起，纯 JSON、扁平——就是上面 `config:` 段里的键：

```json
{
  "provider": "magpie",
  "model": "group/cheap-deepseek-v4-1-flash",
  "effort": "max",
  "preset": "ptc",
  "permission": "workspace-write",
  "_comment": "本机私有，不进 git"
}
```

改完**不用重启**：`pin` 模式下一次巡检（默认 2 秒）就会重读并生效。只写一项也合法，没写的键继续用 profile 行里的值。

规则：

- **严格 JSON**（容忍 BOM）；`_` 开头的键当注释；不认 `!!js` 表达式——这里是数据文件，不是 patch。
- **写错的值不会生效，也不会悄悄顶掉 profile 里的值**：`"effort": 42`、`"preset": "Cordis"` 这种会记一条 problem，并回落到 profile 行。
- **整行贴进来会被拒**：带 `id`/`name`/`config` 的对象（从 `cordis.patch.yml` 整段复制）会提示「只保留 `config` 里的键」。
- 不认识拼错的键会报一条（`permision`），但不影响其他键生效。
- 文件坏了（语法错 / 根不是对象 / 超过 64 KiB）就整份忽略，回落到 profile 行，只记一条日志、不抛错。
- **profile 行里的 `enabled: false` 是硬开关**：一关，`favors.json` 连读都不读，不能靠它把插件重新打开。

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | `false` = 完全不写任何文件（写在 `favors.json` 里只关自己，写在 profile 行是硬开关） |
| `provider` + `model` | 空 | 模型路由，**必须成对**；半对会被忽略并记一条 problem |
| `effort` | 空 | 推理强度 id（`off`/`low`/`medium`/`high`/`xhigh`/`max` 或路由自带的 id）。路由不提供的档位由 dsh-TUI 自己**向下**取最近档，永不向上 |
| `preset` | 空 | agent preset id（小写字母/数字/连字符） |
| `permission` | 空 | `read-only` / `workspace-write` / `danger-full-access`；`auto` 是会话级值，永远不会被钉住 |
| `pin` | `true` | 持续把被改动的文件改回收藏值；`false` = 每次启动只写一次 |
| `pollMs` | `2000` | `pin` 的检查间隔（最小 250 ms） |

**没填的旋钮不会被碰**：只填 `effort` 就只管推理强度，其余三项继续用 dsh-TUI 自己的记忆。

`pin` / `pollMs` 决定的是巡检本身，在启动时读取——从 `favors.json` 改这两项要重启才生效；四个旋钮和 `enabled` 都是热生效。

## `/favors` 命令

在 TUI 里输入：

- `/favors` 或 `/favors status` — 列出四个旋钮：收藏值、当前文件里的值、是否一致，以及这一项是谁给的（`[favors.json]` / `[profile row]`）；末尾还有 `source:` 一行说明配置文件的状态（没有、生效、被忽略），和压过插件的东西。
- `/favors apply` — 立刻重读 `favors.json` 并重写这四个文件（不用等 `pollMs`）。

## 优先级：插件压不过的东西

配置层内部（高 → 低）：`~/.dsh-tui/favors.json` 里**有效**的键 > profile 行的 `config` > 内置默认。`enabled: false` 写在 profile 行时不受这条规则约束（硬开关）。

下面这些是 dsh-TUI 的部署/启动级指令，优先级在偏好文件**之上**。`/favors` 会明确提示：

- **preset**：`DSH_TUI_PRESET` 环境变量 > `agent-preset.json`
- **权限模式**：`DSH_PERMISSION_MODE` 环境变量 > `permission.json`（dsh-TUI 见到它就完全不读偏好文件）
- **推理强度**：`/settings` 里的「默认推理强度」（`settings.json` 的 `effortDefault`）> `effort.json`
- **模型**：`model.json` 本身就是最上层（`cordis.yml` 的 `provider`/`model` 只是它下面的部署默认值）

## 诚实说明的边界

- **`pin` 会把 dsh-TUI 的「上次选择」记忆变成固定值。** 在会话里 `/model` 换成别的模型，当前会话照常使用新模型，但 2 秒内 `model.json` 会被改回收藏值；于是 `/new` 又回到收藏值，`/reload` 也会把收藏值应用到当前会话。想要一劳永逸换默认值：改上面的 config，或者临时 `pin: false`。
- **推理强度是「启动级」的。** dsh-TUI 在进程内缓存首选强度，`/new` 沿用内存里的值（这是它自己的设计），所以一次运行内用 `/effort` 改过的档位会持续到下次启动；`effort.json` 已经被插件改回收藏值，重启即恢复。模型 / preset / 权限模式则在每次 `/new` 重新读文件，`pin` 模式下都会被拉回收藏值。
- **`permission.json` 只给「还没自己选过权限面」的新会话打底**，这是 dsh-TUI 的规则；已经用 `/permission` 或 Shift+Tab 选过模式的会话不会被改写。
- **dsh-TUI 之外的 profile 无意义**：其它前端不读 `~/.dsh-tui/*`，插件在那里只会写几个没人读的文件。别把它装进 Web UI 的 profile。

## 验证

```bash
node scripts/verify.mjs       # 纯逻辑：配置校验、写文件、pin 回写、/favors 报告
node scripts/verify-host.mjs  # 反向契约：用 dsh-TUI 真正的读取器读插件写的文件
```

`verify-host.mjs` 直接 import 已安装 dsh-tui 的 `modelPrefs.js` / `effortPrefs.js` /
`presetPrefs.js` / `permissionPrefs.js`，断言两边格式互相兼容——这是「插件写的东西
dsh-TUI 真的会读」的证据，而不是靠猜。

## 结构

```
index.js                 # 插件本体（name / apply / resolveConfig / applyFavorites / renderStatus）
cordis.patch.yml         # bundle patch：一行 dsh-tui-favors，带中性默认 config
scripts/verify.mjs       # 离线自检
scripts/verify-host.mjs  # 与真实 dsh-TUI 读取器的交叉验证
```

运行时还会读 `~/.dsh-tui/favors.json`（用户自己的文件，不入包、不进 git）。
