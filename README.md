# @dongasai/dsh-setting-pro

把 DSH Web 的**设置弹窗**从官方写死的 `800 × 800` 放大（开箱 `1180 × 920`），并把三件 Host 运维的事
收进 **「设置 → 高级设置」** 这一页：**重启 dsh**、**空闲后重启**、**最后启动时间**，
外加 **dsh 版本 / 更新提示**（可选 latest / next / alpha 通道，有新版本时 logo 处出现向上箭头）
与 **机器名字**（直接顶替左上角品牌区），以及输入框下方那一行的**「供应商 · 模型 · 思考档位」**。

**为什么需要它**：官方设置面板的几何没有任何入口（没有槽位、没有 CSS 变量、没有 `Config`）；
而改完 Host 半边的插件必须重启进程才生效，官方也没给界面入口，用户只能去终端敲 `systemctl`。
本插件补的就是这两半：**一个能改尺寸的设置页** + **一个不用离开界面就能重启的入口**。
（和「让 agent 帮你改」的区别：这里全是确定性操作 —— 尺寸立即生效、重启走 systemd 临时单元、
版本只提示不代劳升级，没有模型参与。）

**文档分工**（三份，别互相抄）：

| 想知道 | 看 |
| --- | --- |
| **怎么用**：装、用、协议、排错、验证、边界 | 本文件 |
| **为什么这么实现**：取舍、一次调用的路径、为什么不能那样做 | [IMPLEMENTATION.md](IMPLEMENTATION.md) |
| **给 agent 的约束与改动连带项** | [AGENTS.md](AGENTS.md) |

| 项 | 值 |
| --- | --- |
| 包名 | `@dongasai/dsh-setting-pro` |
| 版本 | **0.11.0**（与 `package.json` 一致，tag `0.11`）。⚠️ 老 tag **`0.10`** 只指向首个提交，**不含** 2026-10-18 那个「dsh 版本读错 → 更新检查废掉」的修复；要拿到最新代码请装 `#0.11` |
| profile 行 id | `setting-pro` |
| 源码 | `/data/ai/dsh/dsh_setting_pro` |
| 界面入口 | 「设置 → 高级设置」（左侧导航最后一项；图标是官方给未知 id 的默认齿轮） |
| 依赖 | **零依赖、无构建**：`index.js` 只用 `node:` 内建；`client.js` 是手写 bundle |

## 功能

| 功能 | 在哪 | 说明 |
| --- | --- | --- |
| 设置弹窗尺寸 | 设置 → 高级设置 → 面板宽度 / 面板高度 / 恢复默认尺寸 | 20px 一档，改完**立即生效**；默认 `1180 × 920`，范围宽 640–2400、高 480–1600 |
| 重启 dsh | 同页 → **Host** → 重启 DSH | 延迟 3 秒发出（让这次应答先回页面）；忙时二次确认；页面断连后自动重连 |
| 空闲后重启 | 同页 → **Host** → 空闲后重启 / 取消排程 | 所有会话空闲 10 秒后自动重启；重复点击是幂等的（不重置计时） |
| 最后启动时间 | 同页状态行 | `最后启动 <时刻>（已运行 …）`，与 `bootId` 一起用来确认「重启完成了」 |
| dsh 版本 / 更新提示 | 同页 → **Host** → DSH 版本 | 打开页面起 5 分钟轮询 npm dist-tags（Host 侧缓存 6h）；**可**选 `auto` / `latest` / `next` / `alpha` 等通道，按所选通道判断有没有新版，有就提示并**在 logo 处显示向上箭头** |
| 机器名字 | 同页 → **UI** → 机器名字 | 存 Host；保存后**直接顶替左上角品牌区**（官方 logo 让位），清空则官方 logo 回来 |
| 模型信息（那一行） | 输入框下方「性能与用量」行的**右侧并列一格**（开关在 **UI** 分区） | 只读显示 `供应商 · 模型 · 思考档位`（悬停给出内部 id 与数据来源）；**官方那两条 pill 原样保留**，可在「高级设置」里关掉 |
| 模型侧工具 | 同页 → **Agent** → **开放给 agent** | `dsh_restart_when_idle` / `dsh_restart_status` / `dsh_restart_cancel`（**没有**立即重启工具）。这个勾选框控制模型能不能看到它们：关掉即时注销、打开即时注册，**不用重启 dsh**；开关存在 Host 的状态文件里 |

## 快速开始

### 1. 装（三种装法，选一种）

**① Web 插件页（推荐）**：GUI「设置 → 插件」里按本地目录安装，等价于
`plugin_manager(action="install_bundle", target="/data/ai/dsh/dsh_setting_pro")`。

**② `link:` 本地路径（开发用）**——本插件当前就是这种：

```bash
dsh plugin --profile web add /data/ai/dsh/dsh_setting_pro
```

装完 profile 里会有两处（缺第二处就不会被装配）：

```bash
grep -n setting-pro ~/.dsh/profiles/web/package.json
#  "dependencies":       "@dongasai/dsh-setting-pro": "link:/data/ai/dsh/dsh_setting_pro"
#  "dsh.profile.bundles": "@dongasai/dsh-setting-pro"
ls -l ~/.dsh/profiles/web/node_modules/@dongasai/   # 应有一条软链指回源码目录
```

**③ git 源**（已发布：`git@github.com:dongasai/dsh_setting_pro.git`，当前 tag `0.11`）：URL 后加 `#<tag|分支|commit>` 钉版本，**前缀必须是 `git+` 或 `github:`**：

```bash
dsh plugin --profile web add 'github:dongasai/dsh_setting_pro#0.11'   # 当前 tag 是 0.11
```

坑（三条都踩过）：

- `--profile <name>` **必填**，漏了会装到默认 profile 去；
- `git@github.com:…` 这种 **scp 写法会被 pnpm 当成本地路径**，装出一个 `link:` 死链（指向不存在的目录）；
- 钉版本的 tag **必须真实存在**（曾写过假 tag），发版时 `package.json` 的 `version`、git tag、
  本 README 的版本行**三处一起动**。

### 2. 用起来

打开「设置」→ 左侧导航选**「高级设置」**（最后一项，齿轮图标）→ 顶部有**三个分区**
（`UI` / `Host` / `Agent`，选中的那个记在本浏览器里）：

| 分区 | 放什么 | 为什么在这一栏 |
| --- | --- | --- |
| **UI** | 尺寸三行、机器名字、「输入框下方那一行」开关 | 改的都是**你看到的样子**（机器名的值虽然存 Host，但它改的是左上角显示） |
| **Host** | 重启 / 空闲后重启 / 取消排程、DSH 版本与更新通道 | 都是**你对着这台机器**做的运维动作 |
| **Agent** | 开放给 agent | 管的是**模型能看到什么**，读者和上面那些按钮不同 |

### 3. 确认它真的在工作

```bash
# a) 装配层：应该能看到这一行（⚠️ 会写 profile 的 cordis.yml，需在宿主 shell 跑；
#    agent 沙箱里 ~/.dsh 只读，会报 EROFS）
dsh --profile web --dump-config | grep -A2 setting-pro

# b) 路由是否已注册（未带认证时：已注册 → 403 JSON；未注册 → 200 text/html 的 SPA 兜底页）
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' http://127.0.0.1:3080/setting-pro/status
```

界面上：左侧导航多出「高级设置」，面板明显比默认大（`1180 × 920`），页面里有上面那五块。

## 界面长什么样

```
设置 → 高级设置
├─ [ UI ] [ Host ] [ Agent ]                ← 三个分区，选中的记在本浏览器
│
├─ UI
│   ├─ 面板宽度        [ 1180 ▲▼ ] px        改完立即生效，只记本浏览器
│   ├─ 面板高度        [  920 ▲▼ ] px
│   ├─ 恢复默认尺寸    [ 恢复默认 ]
│   ├─ 机器名字        [ 工作机      ] [保存] [清除]
│   │   └─ 说明行：左上角品牌区已换成这个名字 / 槽位占位失败，已退回 logo 下面的小字 / 还没设名字
│   └─ 输入框下方那一行
│       ├─ 显示模型信息 [✓]                  关掉后那一行只剩官方内容（只记本浏览器）
│       └─ 状态行：已挂到那一行（官方两条 pill 保留）/ 还没挂上… / 挂不上那一行：<原因>
│
├─ Host
│   ├─ 重启 DSH        [ 重启 ]              忙时先弹确认，再带 force 重发
│   ├─ 空闲后重启      [ 排程 ] / [ 已排程]   幂等：重复点不重置 10 秒计时
│   ├─ 取消排程        [ 取消 ]              只在已排程时可用
│   ├─ 状态行：当前空闲 · 最后启动 2026-10-17 00:12:34（已运行 3 小时 4 分）· 目标单元 dsh.service
│   └─ DSH 版本
│       ├─ 当前版本    0.2.0-rc.2
│       ├─ 更新通道    [ auto（所有通道取最高）▾ ]   ← latest / next / alpha …（按 registry 实际有的列）
│       └─ 最新版本    0.2.1-alpha.5 (alpha)  [检查更新]
│           ⚠ 有新版本 · 0.2.1-alpha.5 (alpha) · 当前 0.2.0-rc.2 — 重启 dsh 时由 npx 重新解析…
│
└─ Agent
    ├─ 开放给 agent    [✓]                   模型能不能看到这三个工具（即时生效）
    └─ 工具行：当前：已开放给 agent（3）／未开放（工具已注销）／⚠ 开关与实际不一致（没生效）：<原因>
```

左上角 logo 行（有新版本时多一个向上箭头）：

```
[ logo / 机器名 ]  ↑
                   └ 有新版本时的向上箭头（悬停写版本与所选通道）
```

设了机器名字后，**品牌区（logo 那一行）被机器名取代**（20px 加粗）；没设名字、或点了「清除」，官方 logo 照旧。
有新版本时，品牌区**后面**再跟一个向上的箭头；侧边栏折叠成 rail 时它与名字都不显示
（官方本来也不渲染品牌名）。

输入框下方那一行（官方 `21 轮 521 步 · 164 tok/s` 与 `211M tok · 缓存命中 98%` 之后）：

```
⟨21 轮 521 步 · 164 tok/s⟩  ⟨211M tok · 缓存命中 98%⟩  ⊙ 阿里云百炼 · Qwen3 Max · 高   ⟨15%⟩
    └ 官方两条，原样不动                            └ 本插件加的这一格（只读）
```

悬停那一格给三行明细（值 + 内部 id，以及数据来源）：

```
供应商：阿里云百炼（bailian）
模型：Qwen3 Max（qwen3-max）
思考档位：高（high）
```

## 生效条件（两半分开看，这条最常被问）

| 改了什么 | 怎么生效 |
| --- | --- |
| `client.js`（浏览器半边：界面、CSS、品牌区顶替、那一行的模型格） | **刷新浏览器页面**即可 |
| `index.js`（Host 半边：7 条路由、工具、重启引擎、版本检查、状态文件存取） | **重启 dsh**（`link:` 装法下模块被进程缓存，重装 bundle 也不换模块） |
| `package.json` 的 `dsh.*` / `cordis.patch.yml` | profile 重新组装（GUI 安装实测当前进程热生效） |
| 界面上的尺寸 / 排程状态 | 即时生效；尺寸只写 `localStorage` |
| 那一行的模型格（`conversation.composer.dock` 里那一格） | 随 `client.js` 走：**刷新浏览器页面**即可（0.9.0 只动了浏览器半边） |
| 「开放给 agent」开关 | 随 `index.js` 走：需要**重启 dsh 一次**加载新 Host 半边；此后开关本身即时生效（不用重启） |

**升级到 0.3.0 之后要先在宿主机重启一次 dsh**（`systemctl --user restart dsh`）：新 Host 半边才注册
`/setting-pro/*` 这几条路由。在那之前，页面状态行会显示「Host 半边还没加载：这次升级需要先在宿主机上重启
一次 dsh」（不是故障，是升级的一次性动作）。此后这一页就能自己重启自己。

## 结构

| 文件 | 作用 |
| --- | --- |
| [index.js](index.js) | Host 半边：7 条 HTTP 路由 + 3 个模型工具（带网关注册/注销）+ 重启引擎 + 版本检查 + 状态文件读写（只用 `node:` 内建） |
| [client.js](client.js) | 浏览器半边：面板几何覆盖、`settings.section` 设置页（含「开放给 agent」开关）、品牌区顶替、DOM 兜底、状态轮询、那一行的模型格 |
| [cordis.patch.yml](cordis.patch.yml) | bundle patch：只 `insert` 一行 `id: setting-pro` |
| [package.json](package.json) | manifest：`dsh.bundle.patch` 指向 patch；`dsh.client` 声明 `platform/immediately/inject` |
| [probe.mjs](probe.mjs) | 静态回归探针：`node probe.mjs`，**386 项**，不出网、不写真实状态文件 |
| [README.md](README.md) / [IMPLEMENTATION.md](IMPLEMENTATION.md) / [AGENTS.md](AGENTS.md) | 怎么用 / 为什么 / 给 agent 的约束 |

**Host 半边注入的服务**（`index.js`）：`webServer`（挂路由）、`connection`（信任围栏）、
`agents`（空闲判定，读 `ctx.agents.list()` 的 `status`）、`tools`（注册工具）。
**浏览器半边注入**（`client.js`）：`slots`、`locale`。
**客户端依赖声明**（`package.json` 的 `dsh.client.inject`）：`@deepseek-ai/dsh-client-ui-settings-general`、
`@deepseek-ai/dsh-client-locale`（只声明「先到达」，本插件只 `require('react')` 这个平台种子）。

### 扩展点占用表

排查冲突时先看这张表。

| 扩展点 | 谁 | id / order / priority | 说明 |
| --- | --- | --- | --- |
| `settings.section`（list 槽） | 本插件 | `id: advanced`、`order: 50` | 左侧导航新增一页；`label` 是 thunk（语言切换即时跟上）；**不声明 `children`**，页面自绘 |
| `sidebar.brand.mark`（single 槽） | 本插件（**条件占用**） | `priority: -1` | 仅在**有机器名字**时占位；渲染 `null`（让位给名字）。官方 `dsh-client-ui-brand-official` 用 `priority: 0` |
| `sidebar.brand.name`（single 槽） | 本插件（**条件占用**） | `priority: -1` | 渲染机器名（`.dspro_brandName`，20px/600，行高锁 24px 贴合官方行盒）；清空名字即撤销占位 |
| `conversation.composer.dock`（list 槽） | 本插件 | `id: model-usage`、`order: 1` | 与官方那条（`id: stats`、`order: 0`）**并列**，不顶替；只读、无 `priority` |
| `settings.general.item` | **本插件不占** | — | 0.1.0 曾往「通用」里塞一行，0.2.0 起改独立页；探针里有断言确保这里不再有 `setting-pro` |
| 面板几何 CSS | 本插件 | 选择器 `[data-shortcut-modal="settings"][role="dialog"]` | 见 [IMPLEMENTATION.md](IMPLEMENTATION.md) 第一节 |
| 页面 DOM（兜底） | 本插件 | `[class*="_logoRow"]` 之后插 `.dspro_machine` | 只在品牌区占位失败时才出现 |

## 线上协议

7 条精确路由，全部过官方 **Connection 信任围栏**（`ctx.connection.requestRejection`：可信 Host/Origin 检查 +
浏览器认证），**只发 JSON、只收 `application/json`**。

| 路由 | 方法 | 请求 | 应答 |
| --- | --- | --- | --- |
| `/setting-pro/status` | GET | — | `{bootId, pid, startedAt, uptimeMs, dshVersion, dshVersionSource, machineName, machineNamePath, agentTools, agentToolsExposed, agentToolsNames[], agentToolsError, runningSessions[{sessionId, workspace, title}], supervisor, parentManaged, supported, unit, unitSource, reason, mechanism, plan, delaySec, quietWindowMs, pollMs, busy, runningCount, running[], idle, armed, quietMs, firedAt, transientUnit, lastAction, lastError}` |
| `/setting-pro/restart` | POST | `{force?: true}` | `200 {ok:true, transientUnit, unit, fireAt, delaySec}` ／ `409 {code:'busy', runningCount, running[]}` ／ `501 {code:'unsupported-host', message}` ／ `500 {code:'spawn-failed', message}` |
| `/setting-pro/schedule` | POST | `{}` | `200 {ok:true, armed:true, busy, running[], quietWindowMs}`；已排程时 `{already:true}`（幂等） |
| `/setting-pro/cancel` | POST | `{}` | `200 {ok:true, armed:false}` |
| `/setting-pro/version` | GET（`?refresh=1` 强制重查；`?channel=alpha` 按所选通道给结论，缺省 `auto`） | — | `{package, registry, ttlMs, current, currentSource, currentPath, tags[{tag,version}], channels[], channel, channelRequested, channelMissing, newest, newestTag, newer, upToDate, line, comparable, checkedAt, attemptAt, error}` |
| `/setting-pro/agent-tools` | GET / POST | GET 无体；POST `{enabled}`（**只认布尔**） | GET `{enabled, exposed, names[], path, error}`；POST `200 {ok:true, enabled, exposed, names[]}` ／ `400 {code:'bad-request'}` ／ `500 {code:'write-failed'}`。`enabled` 是开关值、`exposed` 是**实际注册状态**（改完即时生效，不用重启） |
| `/setting-pro/machine` | GET / POST | GET 无体；POST `{name}`（空串＝清除） | GET `{name, path, error, maxLength}`；POST `200 {ok:true, name, path, maxLength}` ／ `400 {code:'bad-request'}` ／ `500 {code:'write-failed'}` |

示例（浏览器里带 cookie 才会 200；命令行未认证会被围栏挡掉）：

```bash
curl -s http://127.0.0.1:3080/setting-pro/status
curl -s -X POST -H 'content-type: application/json' \
     -d '{"name":"工作机"}' http://127.0.0.1:3080/setting-pro/machine
```

**本地错误码（9 个）**：`busy`、`unsupported-host`、`spawn-failed`、`write-failed`、`version-check-failed`、
`bad-request`、`method-not-allowed`、`unsupported-media-type`、`body-too-large`。

**HTTP 状态**：`401`/`403` 来自信任围栏（未认证 / 不可信来源）；`405` 方法不对；`400` 非 JSON、坏 JSON、
`name` 不是字符串；`413` 请求体超 64KB；`409` 忙且未 `force`；`500` 写入或 spawn 失败；
`501` 宿主不支持（不是 systemd 服务，或 cgroup 叶子不是 `.service`）。

**模型工具**：`dsh_restart_when_idle`（排程）、`dsh_restart_status`（含将要执行的完整 `systemd-run` 命令，可核对）、
`dsh_restart_cancel`。**刻意没有「立即重启」工具**：那会杀掉模型自己正在跑的回合，没有回合能在自杀后回报结果。

## 安全模型

- **所有路由都过官方信任围栏**，且只接受 `application/json`（跨源要预检，等于多一道闸）。
- **机器名字只走 `textContent`**，用户输入绝不进 `innerHTML`；Host 侧先剥控制字符/换行、折叠空白、截断 64 字。
- **状态文件原子写**（临时文件 + rename），保留同文件里的其它键；读失败不覆盖文件。
- **不做猜测性降级**：宿主判不出是不是 systemd 服务时明确报 `unsupported-host`，不尝试自我重启。
- **不代劳升级**：版本检查只提示，不下载、不切通道、不改 profile。

## 与 Agent 的关系

| 工具 | 什么时候用 |
| --- | --- |
| `dsh_restart_when_idle` | 改完 Host 半边插件后，让它在所有会话空闲 10 秒后自己重启 |
| `dsh_restart_status` | 想知道「现在忙不忙、排了没有、要重启哪个单元、命令长什么样」 |
| `dsh_restart_cancel` | 撤销已排程的空闲重启 |

立即重启**只能由人在界面上点**（忙时二次确认）。原因见 [IMPLEMENTATION.md](IMPLEMENTATION.md)。

上表这三个工具**可以不开放给模型**：「Host 运维」块里的「开放给 agent」勾选框（默认开）。
关掉时 Host 侧把它们**注销**（`ctx.tools.register()` 返回的就是注销用的 disposer），
所以模型的工具列表里立刻没有它们；**界面上人点的按钮不受影响**。开关存在 Host 的
`$DSH_HOME/setting-pro.json`（全机共享，不是每个浏览器一份），改完**即时生效、不用重启 dsh**。
代价：对**已经开场**的那一轮不追溯（工具列表是那次请求发出去的），要「绝对没有模型能用」
就关掉后再把在跑的会话停掉。

## 排错

| 症状 | 原因 | 处置 |
| --- | --- | --- |
| 「高级设置」整页不见了 | `client.js` 的 `settings.section` 注册失败（例如与别的插件撞 `id: advanced`） | 看浏览器控制台；改本插件的 `id` 或停掉冲突插件 |
| 面板尺寸没变 | 官方改掉了 `data-shortcut-modal` 锚点，或官方换了设置面板实现 | 覆盖静默失效（页仍在）。改 `PANEL_SELECTOR` |
| 「重启 DSH」「空闲后重启」点了没反应 | Host 半边还没加载（升级后没重启过） | 状态行会写「Host 半边还没加载」；先在宿主机跑 `systemctl --user restart dsh` |
| 状态行一直「正在读取 Host 状态…」 | 同上（旧版客户端只认 404；现在会明确提示） | 刷新页面拿新客户端；再不行就重启 dsh |
| 重启按钮点下去弹「宿主不支持」 | 进程不在 systemd 用户服务里（docker / 裸终端 `dsh web`） | 这种部署自己重启；状态行的「原因」会写清楚 |
| 机器名字保存成功，但左上角还是官方 logo | 品牌区占位失败（官方改了槽位或优先级） | 设置页说明行会写「已退回 logo 下面的小字」；改 `BRAND_PRIORITY` 或槽位名 |
| 那一行没有「供应商 · 模型 · 思考档位」 | ① 设置页那个开关被关过（`localStorage`）；② 官方把 `conversation.composer.dock` 改名或不再渲染；③ 这个会话还没选过模型（投影为空） | 看「高级设置 → 输入框下方那一行」的状态行：会写「已挂到那一行」/「还没挂上」/「挂不上那一行：<原因>」；没选过模型时**故意不画**（不画个假值） |
| 模型格显示的是 `bailian/qwen3-max` 这种 id，不是中文名 | 模型目录服务（`modelDirectories`）还没挂上或那次取失败了，退到会话投影（投影里本来只有 id） | 悬停最后一行会写明「这里显示的是内部 id」；目录加载好后自动换成可读名，不用刷新 |
| 模型格的档位显示「供应商默认」 | 该模型的目录元数据里确实没给档位，或没选过档 | 与官方那个下拉一致（同一个判据），不是本插件算错 |
| 关掉「开放给 agent」后模型还能调用 | 那一轮的工具列表是**开场时**发出去的，不追溯 | 正常（README「与 Agent 的关系」里写了）；关掉后再开一个新回合就看不到了 |
| 更新提示不出现 | 各 dist-tag 都不高于当前版本；或 registry 不可达 | 状态行会写「更新检查失败：…」；`DSH_SETTING_PRO_REGISTRY` 可换镜像 |
| 当前版本显示成**别的项目**的版本号（本机曾显示 `1.7.1`，真实 `0.2.0-rc.2`），并且永远说「已是最新」 | 全局装的 dsh 从 `<prefix>/bin/dsh` 符号链接启动，不 realpath 时往上找包会先撞上 `<prefix>/package.json`（本机是版本管理器自己的 manifest） | 这是 **0.10.0 之后**修的 bug，未随 tag `0.10` 发布：重启 dsh 加载新 `index.js` 后即恢复正常（来源显示 `package`）。急用可设 `DSH_SETTING_PRO_DSH_VERSION=真实版本` 直接指 |
| 排程后迟迟不重启 | 还有会话在跑（含子代理 / 团队成员的回合） | 状态行会写「仍有 N 个会话在运行」；等它们空闲，或点「取消排程」 |
| 改了 `index.js` 没生效 | Host 半边被进程缓存 | 重启 dsh（或先点页面上的「重启 DSH」） |

## 怎么验证

### 命令行能覆盖的部分

```bash
# 0) 静态回归探针：386 项（宿主判据 / 命令构造 / 空闲状态机 / 路由契约 / 版本比较与更新检查 /
#    机器名与开关的清洗存取（假 fs，不碰 ~/.dsh）/ 组件渲染 / 品牌区顶替与 DOM 兜底 /
#    设置页三分区（归类 · 隔离 · 选中态跟随 store）/ 版本通道（通道矩阵、切换不重打 registry、
#    空基准不判更新）/ 模型格（三段拼法、id 退路、开关落盘、挂不上时不冒异常）/
#    工具网关（即时注册注销、状态两个字段分开报、apply 不被注册失败带崩）/ 产物形状）
node probe.mjs
node --check index.js && node --check client.js && node --check probe.mjs

# 1) manifest 与 patch
python3 -c "import json;json.load(open('package.json'))"
python3 -c "import yaml;yaml.safe_load(open('cordis.patch.yml'))"

# 2) 装配（宿主 shell；沙箱内 EROFS）
dsh --profile web --dump-config | grep -A2 setting-pro

# 3) 路由是否已注册（403 JSON = 已注册；200 text/html = 没注册）
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' http://127.0.0.1:3080/setting-pro/status
```

探针**刻意不触发真实重启、不出网、不写真实状态文件**（分别用假 ctx、假 fetch、假 fs）。

### 只能在浏览器里看的（逐条打勾）

尺寸三条：

- [ ] 打开设置面板，左侧导航多出「高级设置」，外框明显比原来大（宽 `1180`、高 `920`）；
- [ ] 该页有「面板宽度 / 面板高度 / 恢复默认尺寸」三行，步进器可点、面板随点随变；
- [ ] 「通用」里**没有**插件加的那一行；刷新页面后尺寸仍是上次设定的值。

Host 分区三条（会真的重启，需你本人点）：

- [ ] 状态行给出**最后启动时间与已运行时长**、当前空闲或有 N 个会话在运行、目标单元名；
- [ ] 「重启 DSH」「空闲后重启」两个按钮**都可点**（Host 半边未加载时点一下会直接说明原因）；
- [ ] 点「空闲后重启」→ 状态行变「已排程：已静默 N 秒 / 10 秒」（忙时显示还剩几个会话在跑），
      「取消排程」可用；再点一次不重置计时；点取消即撤销；
- [ ] 点「重启 DSH」（忙时会先弹二次确认）→ 页面断连，几秒后自动重连，`bootId` 与**最后启动时间**都变了；

Agent 分区一条：

- [ ] 「开放给 agent」取消勾选 → 下面那行立刻变成「未开放（工具已注销）」，且**新起的回合里模型看不到** `dsh_restart_*`
      （当前这一轮已经带上的工具列表不会追溯改变）；勾回来 → 那行变回「已开放」，不用重启 dsh。

分区本身三条：

- [ ] 顶部有 `UI` / `Host` / `Agent` 三个 tab，点一下只显示那一栏的内容；
- [ ] 刷新页面后**停在上次选的那一栏**（`localStorage`；清掉站点数据则回到 `UI`）；
- [ ] `UI` 栏里没有「重启 DSH」，「Host」栏里没有「开放给 agent」（两者不混）。

机器名字三条：

- [ ] 输入一个名字保存 → **左上角的 logo 被这个名字取代**（20px 加粗），设置页说明行写「左上角品牌区已换成这个名字」；
- [ ] 刷新页面后仍在（值来自 Host 的 `$DSH_HOME/setting-pro.json`，不是浏览器缓存）；
- [ ] 点「清除」→ 官方 logo 回来；侧边栏折叠成 rail 时这一行不显示，展开后自动回来。

那一行的模型格四条：

- [ ] 输入框下方那一行，官方两条 pill **还在**，右边多出一格「供应商 · 模型 · 思考档位」；
- [ ] 悬停它 → 三行「供应商 / 模型 / 思考档位」，每行带内部 id（目录没加载完时最后一行会说明「显示的是内部 id」）；
- [ ] 改模型（用官方那个下拉）后，这一格跟着变（不用刷新页面）；
- [ ] 到「高级设置」取消勾选「显示模型信息」→ 那一格**当场消失**，只剩官方内容；刷新页面后仍是关的。

DSH 版本四条：

- [ ] 打开设置页即显示当前版本，与 `npm ls -g @deepseek-ai/dsh`（全局装法）一致，且来源写着 `package`
      —— 不是 `nearest`。（`nearest` 意味着没认出 dsh 包，见排错表）；
- [ ] 若某个 dist-tag 高于当前版本，出现 warn 色「有新版本 · …」；点「检查更新」强制重查；
- [ ] 反向确认它不再瞎报「已是最新」：拿当前版本和 registry 的 `next`/`alpha` 心算一下，
      有更新就必须出现那一行提示；
- [ ] 「更新通道」下拉里有 `auto` 与 registry 里实际存在的每个 tag（本机是 `latest` / `next` / `alpha`）；
      选 `latest` 与选 `alpha` 得到的结论**可以不同**（本机 `latest` = 当前版本 → 已是最新；
      `alpha` 更新 → 有新版本）；选一个 registry 里没有的通道会明说「这个通道没有发布过」，
      **不会**骗你说「已是最新」；
- [ ] 有更新时，**左上角 logo 旁出现一个向上箭头**（悬停写「dsh 有更新：<版本> (<通道>) · 通道 <所选通道>」）；
      切到没有更新的通道后箭头消失。

⚠️ 这一条要**重启 dsh 之后**才成立（2026-10-18 修的是 Host 半边的 `index.js`）。

## 已知边界

- **只支持 systemd 用户服务**：docker / 裸终端里跑 `dsh web`（cgroup 叶子是 scope）时报 `unsupported-host`
  并把原因显示在状态行，不猜着重启。代价：这些部署要自己重启。
- **重启会打断正在运行的会话**：立即重启需二次确认；排程模式等所有 agent 空闲 10 秒。
  agent 的 `maintenance`（收尾维护）阶段 `status` 也是 `idle`，静默窗只能降低、不能消除打断维护的概率。
- **两个锚点都不是公开契约**：面板几何锚在 `data-shortcut-modal="settings"`，DOM 兜底锚在 `[class*="_logoRow"]`。
  官方改结构时，前者静默失效（回到 800×800，页仍在），后者静默不显示（设置页的值不受影响）。
- **品牌区占位依赖槽位优先级**：`priority: -1` 压过官方的 `0` 是官方认可的 shadowing 写法，
  但槽位本地名与占用者优先级是实现细节；官方若把这两个槽改成 `keyed`、或占用者优先级也降到 -1，
  占位会失败 —— 那时自动退回「logo 下面一行小字」并在设置页说明，不白屏、不报错。
- **机器名字是全机共享的**（一个 `$DSH_HOME` 一份），不是每浏览器一份；多人共用一台机器的同一个 dsh 时
  改的是同一个名字。
- **工作区名 = `basename(header.cwd)`**（官方 `defaultWorkspaceTitle` 同款算法），不是工作区的显示别名：
  两个不同目录同名时看起来会一样。会话标题读不到（服务不在 / 还没生成）就留空——**查不到写空，不猜**。
- **那一行的模型格是只读的**：改模型仍走官方那个下拉（`conversation.input.model` 是 single 槽，顶掉它风险大、
  收益小）。它读的是官方目录服务 `modelDirectories` 与 `directory.store` 的快照 —— 那是**面向官方插件的实现细节**，
  官方换实现时这一格会退化成「显示内部 id」或直接不显示（都不报错，也不影响官方那两条）。
- **重试有上限**：目录服务比我们晚装配时，按 200/500/1000/2000/4000ms 试 5 次就放弃（不永久轮询别人的内部服务）。
  放弃后仍会随官方下拉的更新而恢复（下拉会 `load()` 并通知同一份 store）。
- **「开放给 agent」这个开关存在 Host**（`$DSH_HOME/setting-pro.json` 的 `agentTools`），是全机共享的：
  关掉之后**所有**会话里的模型都看不到这三个工具（页面上人点的按钮不受影响）。改它**即时生效**、不用重启；
  但对**已经开场**的回合不追溯 —— 工具列表是在那次请求里发给模型的，正在跑的那轮仍可能带着它调用（会被 Host 侧
  正常执行，因为路由一直在）。想要「绝对没有模型能用」，关掉后再把在跑的会话停掉。
- **浏览器侧偏好只存在本机浏览器**（`localStorage`，共五个键，不跨设备同步、Host 半边不存）：
  `dsh.setting-pro.size`（面板尺寸）、`dsh.setting-pro.pending-restart`（重连判定用的 `bootId`）、
  `dsh.setting-pro.modelPill`（那一格显不显示）、`dsh.setting-pro.tab`（设置页停在哪个分区）、
  `dsh.setting-pro.channel`（更新通道）。改键 = 用户已有偏好失效。
- **更新提示只看 dist-tags，不替你升级**：不下载、不改 profile、不替你把 dsh 换成别的通道 ——
  「更新通道」下拉只决定**拿哪条线做比较**（进而决定 logo 上有没有箭头），不改你的安装。
  要知道「重启后是不是变成新版」，重启完再看一次当前版本。
- **工具名 `dsh_restart_*` 由本插件占用**；装其它提供同名工具的重启类插件会撞名。
- 本仓库已入 git 并推到 `git@github.com:dongasai/dsh_setting_pro.git`（`main` + 附注标签 `0.11`；`0.10` 是更早那个）。
  tag 用**裸版本号**：`0.11` ↔ `package.json` 的 `0.11.0`。
- **第一个 tag 就是 `0.10`**，早期 0.1.0…0.9.0 只是文档里的版本阶梯（`0.1.0` 指「控制项塞在通用里」
  的旧版），**没有对应 tag** —— 别按 tag 名推算功能顺序，也别去 `#0.9`（不存在）。

## 相关文件

| 文件 | 作用 |
| --- | --- |
| [index.js](index.js) | Host 半边（1514 行） |
| [client.js](client.js) | 浏览器半边（2515 行） |
| [probe.mjs](probe.mjs) | 静态回归探针（386 项） |
| [IMPLEMENTATION.md](IMPLEMENTATION.md) | 为什么这么实现 |
| [AGENTS.md](AGENTS.md) | 给 agent 的约束（27 条硬性约束、改动连带项） |
| [CHANGELOG.md](CHANGELOG.md) | 完整变更史（逐条原始记录，含当时写错的数字与被推翻的结论） |
| [.agents/index.json](.agents/index.json) | 仓库扫描索引（模块、覆盖率、缺口、下一步） |
| [cordis.patch.yml](cordis.patch.yml) / [package.json](package.json) | bundle patch 与 manifest |
