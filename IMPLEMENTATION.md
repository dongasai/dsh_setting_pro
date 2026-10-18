# IMPLEMENTATION.md · 为什么这么实现

面向改这个仓库的人。**怎么用**看 [README.md](README.md)，**给 agent 的约束与连带项**看
[AGENTS.md](AGENTS.md)；这里只写取舍、一次调用的路径，以及「为什么不能那样做」。

每节都是「约束 → 为什么 → 代价」，因为这里的每一条都对应一个已经踩过的坑。

## 一、尺寸：为什么用两个属性选择器去覆盖

官方设置面板的几何写死在 `@deepseek-ai/dsh-client-ui-settings-general` 的 `SettingsPanel` 里：

```css
.VOzbGW_panel{width:800px;height:min(800px,calc(100vh - 2*max(24px,var(--dsh-frame-overlay-top,24px))));max-width:calc(100vw - 48px)}
```

**官方没给这块几何留任何入口**：没有槽位、没有 CSS 变量、没有 `Config`。面板元素上唯一稳定的锚点是它自带的
`data-shortcut-modal="settings"`（快捷键命中属性，和 `role="dialog"` 一起）。于是注入一条指向**同一元素**、
优先级更高的规则：

```css
[data-shortcut-modal="settings"][role="dialog"]{
  width:var(--dspro-width,1180px);
  height:min(var(--dspro-height,920px),calc(100vh - 2*max(24px,var(--dsh-frame-overlay-top,24px))));
  max-width:calc(100vw - 48px)
}
```

- **两个属性选择器（0,2,0）压过官方单类名（0,1,0）**：既不依赖 `<style>` 的插入顺序，也不依赖官方那份
  哈希类名（`VOzbGW_panel` 每次构建都会变）。
- 官方原有的 `max-width:calc(100vw - 48px)` 与高度上限**必须保留**，否则窄屏溢出。
- 代价：锚点是**官方 DOM 属性，不是公开契约**。官方改掉它、或整块换掉设置面板实现时，覆盖会静默失效
  （回到 800×800），「高级设置」页仍在 —— 那时改 `PANEL_SELECTOR` 即可。

页面本身（`section(max-width:760px) > h2 + p.intro + rows`、行骨架 `row/rowText/title/desc/control/stepper/arrows`）
是照官方 `FontSizeRow` 抄的，颜色圆角全走主题 token，**不 import 官方 primitives 包**（箭头是自绘 SVG）——
`link:` 装法下多一个依赖就多一处解析不到的风险。

## 二、重启：为什么不自己拉起进程

`dsh.service` 是 `KillMode=control-group` + `Restart=always`（`SuccessExitStatus=0 143`）：

- 在本进程里 `spawn` 的任何 detached helper **仍在同一个 cgroup**，`setsid`/`detached` 都逃不出回收 ——
  重启时它会被一起杀掉，于是「服务停了、新的没起来」。这正是 `dshmarket` 的自我重启在 systemd 下
  **默认关闭**的原因（它自己的文案：重启会连带杀掉 cgroup 里的接管进程，服务将起不来）。
- 所以本插件不接管进程，而是把一个**游离的临时单元**（自己的 cgroup）交给 systemd：

  ```
  systemd-run --user --collect --unit=dsh-restart-setting-pro-<ts> \
    --on-active=3s systemctl --user restart <unit>
  ```

  `dsh.service` 被回收不影响它；`--collect` 让临时单元跑完即消失。

**为什么延迟 3 秒**：`systemctl restart` 一到就把宿主停掉，HTTP 应答根本回不到浏览器，用户只看到页面直接断。
先应答、由临时单元等 3 秒再动手，页面才来得及画「已发起，约 3 秒后断开」。

**为什么判据是 cgroup 叶子，而不是父进程 comm**：本机 `ExecStart=npx -y @deepseek-ai/dsh web`，
真正跑 dsh 的 node 进程父进程是 `npx`（实测 `_PID` 的父进程是 npx、`_SYSTEMD_CGROUP=…/app.slice/dsh.service`）。
照 dshmarket「父进程 comm === systemd」那条判据，会把一个正常的 systemd 服务误判成「没人管」，
于是重启后按钮照样不可点。现在读 `/proc/self/cgroup` 的**叶子 `.service`**：既准，又直接给出了要重启的单元名。
叶子不是 `.service`（docker / 裸终端）时**明确报 `unsupported-host`**，不做猜测性降级 —— 宁可不做，
也不制造「服务起不来」。也**绝不向上回退**到 `user@1000.service`（那会杀掉整个用户会话）。

**空闲闸为什么是 10 秒静默窗 + 2 秒复查**：正在跑的会话（含子代理、AgentTeams 成员）会被重启打断。
开火前那一刻必须**重新**看一遍 `ctx.agents.list()`；繁忙就把静默窗清零，不能拿上一次的结论当依据。
代价：agent 的 `maintenance`（收尾维护）阶段 `status` 也是 `idle`，静默窗只能降低、不能消除打断维护的概率。

## 三、一次「点重启」的完整路径

1. 浏览器：点「重启 DSH」→ `POST /setting-pro/restart`，body `{}`（忙时二次确认后带 `{"force":true}`）。
2. Host：`connection.requestRejection(req)` 信任围栏 → 方法闸（只收 POST）→ `readJsonBody`（只收 JSON、有上限）。
3. `control.restartNow({force})`：读 `ctx.agents.list()`；有 `running` 且未 `force` → `409 {code:'busy', runningCount, running[]}`。
4. 客户端收到 409 → 弹一次确认 → 带 `force:true` 重发 → `fire('immediate')`：
   `describeHost()` 已判定 supported → `restartUnitArgv()` 造命令 → `spawn('systemd-run', …)`（detached、`unref`）
   → 等 150ms 让异步 `ENOENT` 露头（没有 systemd-run 时报得出来，而不是静默成功）。
5. 返回 `{ok:true, transientUnit, unit, fireAt, delaySec}`；客户端把当前 `bootId` 记进
   `localStorage['dsh.setting-pro.pending-restart']`，显示「已发起…」，继续 2s 轮询 `/status`。
6. systemd 3 秒后跑 `systemctl --user restart dsh.service` → 本进程收到 SIGTERM（143，算正常退出）→
   `Restart=always` 拉起新进程。
7. 页面断连 → 自动重连 → `/status` 的 `bootId` 变了 → 清掉 pending → 显示「DSH 已重启完成」。

## 四、版本检查：为什么不能只看 `latest`

本机当前 `0.2.0-rc.2`，registry 的 `latest` 也是 `0.2.0-rc.2`，但 `alpha` 已是 `0.2.1-alpha.5`：
**只看 `latest` 会报「已是最新」，把用户所在那条线的新版本吞掉**（dshmarket 在 #867 记过同一个坑）。
所以对所有 dist-tag 取最高版本，并注明它挂在哪个 tag。比较用 semver 规则（正式版 > 预发布、数字段按数值比），
**解析不出就返回 `null` 并显示「无法比较」，不装作相等**。

查询走轻量端点 `GET {registry}/-/package/@deepseek-ai%2Fdsh/dist-tags`（几个字节，不是整包元数据），
Host 侧缓存 6h。**一次网络抖动不得抹掉已有结论**：失败只记 `error` 并保留上一次成功的 dist-tags；
当前版本是本地读文件，不依赖网络。

### 四.1 「当前版本」怎么读到：为什么必须先 realpath

不 import 官方包（`link:` 装法解析不到），也**不写死路径**：从 `process.argv[1]` 往上找 dsh 包的
`package.json`。但**这条路径在 0.4.0 上线后一直是错的**，直到 2026-10-18 才从 `dsh_restart_status`
的输出里撞出来 —— 那行报 `dsh: 1.7.1 (nearest)`，而 `npm ls -g` 说的是 `0.2.0-rc.2`。

查出来的是安装方式决定的：全局装的东西靠 `<prefix>/bin/dsh` 这个**符号链接**启动，
链接指向 `../lib/node_modules/@deepseek-ai/dsh/lib/bin.js`。如果拿 `bin/dsh` 这个路径往上走，
经过的是 `<prefix>/bin` → `<prefix>`，那里**没有** dsh 包的 `package.json`，
却先撞上了 `<prefix>/package.json` —— 本机 `<prefix>` 是 `~/.nvs/node/24.13.0/x64`，
那个 manifest 属于 **nvs 自己**，版本 `1.7.1`。

后果比「显示错一个数字」严重得多：`1.7.1` 被当成当前版本拿去和 registry 比，
`0.2.1-rc.2` < `1.7.1` → 永远判「已是最新」，**更新检查整个废掉**（真实情况恰好是有新版本可升）。
而且它不会报错，看起来一切正常 —— 是最难发现的那类 bug。

于是：① 入口先 `realpath`（可注入，探针能喂假链接）；② realpath 失败退回原路径，
宁可少认一层也别整个判不出来；③ **`nearest` 从此不再带版本号**（`version: null`，只留
`source`/`name`/`path` 当线索）。第 ③ 条是更根本的那道防线：哪怕将来又冒出别的链接/路径花样，
也不会把**别的项目**的版本号冒充成 dsh 的版本 —— 与「解析不出就说不知道，不装作相等」
（§四、约束 15）同一条纪律。界面那边相应把 `comparable === false` 的文案改成
「没读到可识别的 dsh 版本」，而不是原来那句只提 semver 的说法。

代价：如果哪天 dsh 被搬进一个没有 `package.json` 的裸目录跑，版本会显示「未知 · 来源 nearest」，
需要 `DSH_SETTING_PRO_DSH_VERSION` 手动指一下。这是**诚实的不知道**，比一个看起来可靠的错数字好。

## 五、机器名字：为什么存 Host、为什么用槽位 priority

**为什么不是 localStorage**：机器名字是**这台机器**的属性，换浏览器、清站点数据都不该丢。所以落
`$DSH_HOME/setting-pro.json`（键 `machineName`）。写入走「临时文件 + rename」并保留同文件里的其它键；
读不到/坏 JSON 退回空名字并记 `error`，**不要**因为读失败就把文件覆盖掉。

**为什么能顶掉官方 logo**：`sidebar.brand.mark` / `sidebar.brand.name` 都是 `kind: "single"`，
官方 `dsh-client-ui-brand-official` 用默认 `priority: 0` 占着。slots 源码里两句话决定了做法：

- 注册只在**同一 priority** 上查冲突：`register at a different priority to shadow it (lowest renders)`；
- 投影按 priority **升序取第一个**：`the first live entry of each cell in priority order`。

于是 `priority: -1` 就是官方认可的「顶掉它」，而不是去抢 DOM。两个前提：

- **只在有名字时占位**：没名字要能退回官方 logo。做成「静态占位 + 空名字渲染 `null`」会把 logo 弄没。
- 注册要等槽位被声明（`ctx.slots.inject`），否则抛 `slot … is not declared`；槽位被重新声明（侧边栏重挂）时，
  旧占位已失效，要先清掉再重新占，否则「还以为占着」，名字不再出现。

**为什么 DOM 只是兜底**：万一占位失败（官方改成 keyed / 占用者优先级也降到 -1），退回「logo 行下面一行小字」，
并在设置页写明原因。兜底锚点用**类名后缀** `[class*="_logoRow"]`（官方 CSS Modules 是 `<hash>_logoRow`，
哈希会变、本地名稳定），再退到 `[data-window-drag]` 里含 `[class*="_brandIdentity"]` 的。

> ⚠️ 踩过的坑（2026-10-17，用户报「配了名字但没出现」）：早先的判据里写了「不含 button」，
> 而 **logo 行里就有收起/展开侧边栏的按钮** —— 那条判据把目标元素自己排除了，于是永远找不到锚点。
> **别再按有没有 button 筛。**

名字永远走 `textContent`（不是 `innerHTML`），Host 侧先剥控制字符/换行、折叠空白、截断 64 字。

## 六、运行中指示：为什么用 Host 口径，而不是照抄 DOM

已装的 orca 皮肤（`@smalltailqwq/dsh-client-ui-skin-orca-link`）在 logo 后面有一个信号 chip，
文案含 `TASK RUNNING`。它的判据是**纯读官方 DOM**：`[data-state='running']`、停止按钮图标
`svg[data-orca-link-icon='stop']`、对话根 `[data-phase]`、`[data-approval-key]`/`[data-plan-review-key]`/
`[data-question-key]`、composer 的 `[data-phase]`、以及 `[data-chat-flow]` 末行的
`[data-state='error'|'interrupted']` 与 `data-chat-flow-kind="turn-tail"`；再配一个 MutationObserver
（只过滤 5 个属性）+ transcript 防抖。

**它那样做是对的**：皮肤只需要反映「你正看着的那个会话」。我们不行 —— 这个指示要和
「空闲后重启」说同一件事：**有没有会话在跑**。而重启的判据必须覆盖子代理、AgentTeams 成员、
其它会话里的回合（Host 侧 `ctx.agents.list()` 里 `status === 'running'` 的个数）。
如果指示改成读 DOM，就会出现「指示说空闲、排程却迟迟不重启」这种自相矛盾的界面。

所以：指示读 Host 的 `/status`（`busy` / `runningCount`），**5 秒**轮询一次（设置页自己另有 2 秒轮询；
两处口径同一份数据，只是频率不同）。代价：

- 最多晚 5 秒翻转；
- 只说「有几个在跑」，不说是哪个会话；
- Host 半边没加载（`/status` 拿不到）时**保持上一次结论**，不闪。

**位置与实现**：插在 `[class*="_brandIdentity"]` **之后**（与 orca 的信号 chip 同一个位置），
复用「机器名兜底行」那套锚点/MutationObserver/卸载清理；文案走 `textContent`，
`prefers-reduced-motion: reduce` 下不做呼吸动画。

### 六.1 常显两态与悬停明细（0.8.0）

用户反馈「没有运行中也给个提示」→ chip 改成**常驻两态**：忙 `● 运行中 ×N`（绿、呼吸），
空闲 `● 空闲`（灰、静止）。三个刻意的细节：

- **状态未知时不画**。`busyStore.known` 在第一次成功读到 `/status` 之前是 false ——
  没读到 ≠ 空闲，画个「空闲」就是假回执（与约束 13「非 JSON 绝不当成功」同一个精神）。
- **明细从 Host 来，不在浏览器猜**。`/status` 新增 `runningSessions: [{sessionId, workspace, title}]`：
  `workspace` 用官方 `defaultWorkspaceTitle` 的同款算法（`basename(header.cwd)`，
  这是 dshmarket 等已装插件也在读的公开字段）；`title` 读 `ctx.get('sessionTitle').get(session)` ——
  可选服务，拿不到就留空，**查不到写空**。`running: string[]` 原契约不动、只加字段，
  所以旧客户端照常工作；反过来新客户端遇到旧 Host（没这字段）就回退成纯计数悬停。
- **标题必须缓存**。`sessionTitle.get()` 的实现是 `foldSessionTitle(session.snapshotEvents())`，
  每次扫全量事件；而 `/status` 会被两路轮询反复读（设置页 2s + 指示 5s）。所以按 sessionId
  缓存 `TITLE_TTL_MS = 30s`（悬停新鲜 30 秒足够），会话不在时清掉条目。
  取工作区与取标题**各自包 try**：标题失败不能把已经拿到的工作区一起丢掉。

## 七、客户端：为什么「非 JSON 响应」一律当失败

路由不存在时，SPA 兜底会给一个 **`200 text/html`**（实测，不是 404）。早先的客户端只认 404，
`response.json()` 抛错被 `catch` 吞掉 → `status` 永远是 `null` → 按钮全灰、状态行卡在「正在读取…」，
用户看到的是「不可点」而不知道原因。现在 `opsPost`/`refresh` 都以 `content-type` 判定，并把它标成 `missing`，
显示「Host 半边还没加载：这次升级需要先在宿主机上重启一次 dsh」。**绝不给「已发起重启」的假回执。**

同理，界面按钮不因「不确定」灰掉：「重启 DSH」「空闲后重启」始终可点，点下去由 Host 用真实原因回答
（未加载 / 不支持 / 忙 / 已排程）。禁用态是「没有反馈的失败」，不能拿它代替说明。

## 八、为什么没有 Host 配置项（`Config`）

导出 `Config` 需要 `schemastery`，而 `link:` 装法下 `@deepseek-ai/*` 从这里解析不到。所以：

- 能固定的一律写常量（延迟 3s、静默 10s、复查 2s、缓存 6h、名字上限 64、尺寸范围与步进）；
- 需要按机器调整的走**环境变量**：`DSH_SETTING_PRO_UNIT`（覆盖要重启的单元名）、
  `DSH_SETTING_PRO_DSH_VERSION`（覆盖当前版本，测试用）、`DSH_SETTING_PRO_REGISTRY`（换 registry 镜像）；
- 用户偏好走浏览器 `localStorage`（尺寸、重连判定），机器属性走 Host 状态文件（机器名字）。

## 九、那一行的「供应商 · 模型 · 思考档位」：为什么并列、为什么读两条数据源

输入框下方官方那一行（`21 轮 521 步 · 164 tok/s` 与 `211M tok · 缓存命中 98%`）是
**list 槽** `conversation.composer.dock`。官方契约文档那句话决定了做法：

> a fresh id is added beside the shipped entries, while reusing a shipped id puts you **IN THAT cell and replaces it**

所以本插件用**自己的 id `model-usage` + `order: 1`**，官方那条（`id: stats`、`order: 0`）原样保留。
list 槽按 `id` 分格，**不同 id 之间不存在顶替关系**，位置只由 `order` 决定 —— 这一点和第五节的
品牌区不同：那两个是 **single** 槽，一个格子只有一个赢家，才需要 `priority: -1` 去 shadow。
（探针里对应两条断言：`id !== 'stats'`、`options.priority === undefined`。）

**不去顶替官方那个模型下拉**（`conversation.input.model`，single 槽）：用户要的是「多显示三项」，
不是「换一个选择器」。顶掉它要自己重做搜索、键盘导航、pending 态、Toast、失败分组……
收益是 0，风险是把唯一能改模型的入口弄坏。**只读的一格 + 官方入口**是更小的动作。

### 九.1 数据源为什么是两条

| 优先级 | 来源 | 拿得到什么 | 拿不到时 |
| --- | --- | --- | --- |
| ① | 可选服务 `ctx.get('modelDirectories')` → `directoryFor(sessionId).store` | **和官方那个下拉同一份快照**：分组名 `group.name`、模型显示名 `model.name`、`reasoning.efforts[].name`、`defaultEffort`、`retainedEffort` | 服务不在 / `directoryFor` 抛 → 退 ② |
| ② | 会话投影 `useProjection('modelSelection')` | 只有内部 id：`{next, lastUsed}` 各自的 `provider` / `model` / `reasoningEffort` | 两个都没有 → **整格不画** |

关键取舍：**退到 ② 时显示内部 id，并在悬停里如实写「这里显示的是内部 id」**，不猜中文名。
这和第六.1 里「查不到写空，不猜标题」是同一条纪律 —— 显示 `bailian/qwen3-max` 是事实，
显示一个编出来的「百炼 千问3」是幻觉。①命中时显示 `阿里云百炼 · Qwen3 Max · 高`，
悬停仍然把内部 id 附上（`供应商：阿里云百炼（bailian）`），因为排查配置时用得着。

供应商名里 `deepseek-account` 这一组特殊处理成「DeepSeek 账号」：**照抄官方 `ModelSelect` 的同一条判据**
（它对同一个 id 也是这么替换的），不是本插件自创的词表。

### 九.2 为什么解析要带缓存 + 有上限的重试

`modelDirectories` 是另一个插件（`dsh-client-ui-model-selection`）在**它自己的 apply** 里
`ctx.plugin(ModelDirectoryResolver)` 挂上的服务，装配顺序不保证早于我们；`directoryFor(sessionId)`
在会话尚未装配时**直接抛**。两个坑叠加：

- 如果在挂载时一次性解析，服务晚到一格就**永久**退化成内部 id；
- 如果无上限重试，就变成「第三方插件长期轮询官方面向内部的服务」——不体面也白烧 CPU。

所以：解析函数按 `(ctx, sessionId)` 建一次，**命中就永久缓存**；没命中时按
`MODEL_RETRY_STEPS = [200, 500, 1000, 2000, 4000]` 退避试 **5 次**（合计约 7.7 秒）后放弃。
放弃也不会永远错过：官方下拉自己会 `load()` 并通知**同一份 store**，那一格跟着就活了 ——
重试只是把「服务晚到」这段时间补上，不是唯一的数据通路。

读 store 用 `useSyncExternalStore`（与官方同一对 `subscribe`/`getSnapshot`），**不是**
「`useEffect` 里订阅 + 渲染时读快照」：后者会漏掉「渲染之后、订阅建立之前」那一次通知，
正好是目录晚到时最容易踩的窗口。

### 九.3 为什么 `slots.inject` 的回调里还要一个 try

`ctx.slots.inject(key, cb)` 的 cb **不一定在 `apply` 的同步栈里跑**：槽位已声明时同步跑，
未声明时延迟到**它被声明的那一刻**跑（`renderer` 里的 `inject`：`runs synchronously when the
declaration already exists; otherwise it runs inside the declaring register() call`）。
而 `SlotCore.notifyDeclaration` / `flush` 是**裸 `for` 循环、不隔离异常**：

```js
for (const fn of [...rec.declarationListeners]) fn();
```

也就是说：从我们的 cb 里抛出去，会连累同一次声明里**其它插件**的注册（整块界面可能挂不上）。
`apply` 外面那层 `try` 对此毫无办法 —— 它早就跑完了。所以注册那段必须在 cb **内部**兜住，
失败只记 `modelPillState.reason`（设置页显示「挂不上那一行：<原因>」），不画、也不抛。

> 这条是探针用**假 `inject`**（先不跑回调，`declare()` 时才跑）验出来的：把内层 `catch` 改成
> `throw error`，探针立刻 2 项失败。外层 `try` 那种写法在这个场景下会「看起来被处理了」，
> 实际把异常交给官方通知循环 —— 这正是假 `inject` 与真 `inject` 时序差异必须建模的原因。

### 九.4 为什么开关放浏览器、不放 Host

「显示不显示这一格」是**每台显示器/每个浏览器的观感偏好**，和尺寸同类；机器名字那种「这台机器叫什么」
才是全机共享、要落 `$DSH_HOME`。所以走 `localStorage['dsh.setting-pro.modelPill']`（缺省＝开，
关掉写 `'0'`），不进状态文件。代价：换浏览器要重设；好处：Host 半边不用为显示偏好新增路由与持久化。

## 十、「开放给 agent」开关：为什么能即时生效、为什么两个字段分开报

用户对着功能表里「模型侧工具」那一行说：「这个增加个开关，是否开放给 agent」。动手前先查了三件事，
它们决定了方案，而不是先写代码再找理由：

1. **工具能不能在运行时撤掉？** `dsh-tools` 的 `register()` 文档写着
   「@returns the exact disposer that unregisters the tool」—— 能。
2. **撤掉后模型多快看不到？** 工具表是每次派发时现取（`view.visible` 的投影），不是开场缓存 —— 所以下一步就没了。
3. **注销后能不能再注册同名？** `NamedEntries` 是按名插入/删除，允许（探针里 `再打开又回来` 那条就是在证这点）。

三条都成立，才敢做成**即时生效**的开关。如果第 1 条不成立，就只能做成「改完要重启 dsh」，
或者「注册着但调用时拒绝」—— 后者最糟：模型看得到工具、点了才吃闭门羹，正是不许用禁用态代替说明的那类假反馈。

### 十.1 生命周期：为什么必须在 `apply` 里注册，而不是在路由里

cordis 的服务代理在**调用时**把 `this.ctx` 绑到**调用方**，所以哪怕 `register()` 是从
HTTP 处理函数里被调的，那个 effect 仍挂在**本插件的 fiber** 上（插件卸载时一起收掉）。
这看起来像「随便在哪儿调都行」，但要区分两件事：

- 挂错作用域的后果（不会发生，因为调用方就是我们）；
- **重复注册**的风险：如果路由处理函数每次都调一次 `register()`，第二次就会抛
  「tool ... is already registered」。所以网关内部有 `if (disposers.length > 0) return;` 这道闸
  （探针里 `重复 sync 不重复注册` 那条就是在钉它）。

`Context.effect()` 的 disposer 也是幂等的（`disposing` 标志 + `disposables.splice(0)`），
所以「人手动关掉」和「插件卸载」两路都会调到同一个 dispose 不会炸 —— 这是查过源码才敢依赖的，
不是猜的（见约束 25）。

### 十.2 为什么状态里是 `agentTools` + `agentToolsExposed` 两个字段，而不是一个

一个字段必然要说谎，因为有两种不同的「关」：

- 你把它关了（`agentTools: false`，`agentToolsExposed: false`）—— 一致；
- 你想开、但注册抛错（撞工具名等）（`agentTools: true`，`agentToolsExposed: false`）—— **没生效**。

只报后者的话，界面会指着你说「未开放」，而用户从没点过关；只报前者的话，就是「设置成功」的假回执。
所以两个都报，并在不一致时把 `agentToolsError` 一起显示出来。网关还没挂上时是 `null` =
**未知**，界面说「不知道（还没读到 Host 状态）」—— 与约束 13、第六.1 里「未知不画」是同一个纪律。

变异测试跑过：把 `agentToolsExposed: view.exposed` 改成 `view.enabled`（也就是抹平），
探针立刻 1 项失败（`apply: 开关开着但没挂上 → 状态如实报不一致`）；
客户端那句如果把未知说成「未开放」，3 项失败。

### 十.3 为什么这个开关存 Host，而不是像「显示模型信息」那样存 localStorage

判据是**这条设置的作用范围**：

- 「显示模型信息」只影响**你这块屏幕**上那一行 → 浏览器偏好（`localStorage`）；
- 「模型能不能重启宿主」影响的是**这个 Host 进程对所有会话**暴露什么工具 → 全机属性，存
  `$DSH_HOME/setting-pro.json`。换浏览器、换机器视图都不该出现「A 关着 B 却开着」这种
  和 Host 实际状态不符的界面。

代价：它不是每台显示器各自的偏好，而是一个全局闸 —— 关掉后**所有**会话里的模型都看不到。
这也是为什么缺省值是**开**：0.3.0 起这三个工具一直注册着，加开关不该偷偷改变既有行为
（`AGENT_TOOLS_DEFAULT = true`，探针钉着）。

顺带一个坑：这个文件现在有两个键（`machineName` / `agentTools`）。如果 `write()` 与
`writeAgentTools()` 各自「读旧文件→改自己那个键→整体写回」，两条路径看起来都对，
但并发或交替使用时会互相抹掉。所以它们共用同一个内部 `patch(updates)`：
一次读、一次合并、一次原子写。探针里「改名字后开关仍是关 / 改开关后名字没被抹掉 /
落盘 JSON 两键都在」三条就是防这个（约束 25 的最后一句）。

### 十.4 为什么仍不给模型「立即重启」工具，哪怕开关是开的

开关管的是**已有三个工具**可不可见，不是加新的能力口子。立即重启会杀掉模型自己正在跑的回合，
没有回合能在自杀后回报结果（约束 7）。把「是否开放给 agent」理解为「能不能更狠」是错的：
它只能把权限收到零，不能放大。

## 十一、三处后来的调整：区、通道、箭头（2026-10-19）

三条需求都来自「这一屏信息太多/太少」这类观感问题，但各自的取舍点不同。

### 1. 设置页为什么分「UI / Host / Agent」三栏，而不是按存储位置分

按**读者是谁**分：`UI` 改的是你看到的样子，`Host` 是你对着这台机器做的运维动作，`Agent` 管的是
**模型能看到什么**。所以「机器名字」放进 `UI` 即使它的值存在 Host 的状态文件里 —— 用户脑子里的分类
是「它改左上角」，不是「它写哪个文件」。同理「开放给 agent」从原来的「Host 运维」块里**拆出去**：
它和旁边三个按钮长得一样，但读者完全不同，混在一起会让人以为它也是「点一下让 dsh 重启」那一类。

实现上分区状态用 store 而不是 `useState`，有两个不那么显然的理由：
① 假 React 的 `useState` setter 是空操作（切不了态），探针就**测不到**分区隔离 —— 而隔离正是这个改动
唯一可能出错的地方（块漏放、块重复、块丢失）；换成 `useSyncExternalStore` 后，探针能把三栏各渲染一遍。
② 两个块（Host 运维、开放给 agent）都要读 `/status`，各自轮询就是两份 2s 请求；抽成
`hostStatusStore` + 引用计数的 `useHostStatusPolling` 之后只有一份定时器，且「提示语」也跟着共享
（顺带修好「点了排程再切栏，提示就没了」）。

### 2. 更新通道为什么放在 Host 侧算、缓存却只存原始 dist-tags

通道选择影响「有没有新版本」这个**结论**，而比较规则（预发布排序、数字段按数值比）只有一份实现，
在 Host 的 `compareVersions` 里。让客户端自己按通道过滤就要复刻一份 semver 规则 —— 那是最容易漂的东西。
所以路由收 `?channel=`，结论在 Host 现算。

关键细节：缓存里**只存 registry 返回的原始 dist-tags**，不存算好的结论。于是切通道是纯本地重算：
不打 registry、不用等 6 小时缓存过期、也不会因为「缓存里存的是上一个通道的结论」而互相污染。

通道缺失时**不偷偷退回 `auto`**：那会把「你选的这条线没有发布」说成「已是最新」，是假回执。
所以额外给 `channelMissing`，并且 `newer` / `upToDate` 都不置真 —— 与约束 15「解析不出就说不清」同一纪律。

### 3. logo 上的箭头：为什么轮询要提到 `apply()` 里

`VersionBlock` 只在「设置 → 高级设置」打开时挂载，而箭头要**常驻**在 logo 上。所以版本轮询从组件里
提到 `apply()`，做成共享的 `versionStore`（5 分钟一次；Host 侧对 registry 缓存 6h，再勤也快不过它）。
设置页那块与箭头读同一份 store，两处不会给出两个结论。

判据 `updateAvailable()` 里有一条硬规则：**`current` 为空时绝不标「有更新」**。拿不到基准就没资格下结论 ——
这正是 2026-10-18 那个版本误报 bug 的反面（当时把 nvs 的 `1.7.1` 当 dsh 版本，导致永远「已是最新」；
反过来「基准不可信但照样标箭头」同样是在骗人）。

arrow 的位置在品牌身份之后、与「运行中」分开：`运行中` 已经迁到左下角，logo 那一行现在只有
「机器名 + 可选箭头」，宽度压力从「名字要省略」降到几乎没有。

## 相关文件

| 文件 | 作用 |
| --- | --- |
| [README.md](README.md) | 怎么用：装、用、协议、排错、验证、边界 |
| [AGENTS.md](AGENTS.md) | 给 agent 的约束与改动连带项（28 条硬性约束，`awk '/^## 硬性约束/,/^## AI/' AGENTS.md \| grep -c '^[0-9]\+\. \*\*'`） |
| [CHANGELOG.md](CHANGELOG.md) | 完整变更史（原始记录照搬；新增条目写这里，不往 AGENTS 那节堆） |
| [index.js](index.js) | Host 半边：7 条路由 + 3 个工具（带网关注册/注销）+ 重启引擎 + 版本检查 + 状态文件存取 |
| [client.js](client.js) | 浏览器半边：CSS 覆盖、设置页（三分区）、品牌区顶替、DOM 兜底、左下角状态指示、那一行的模型格、更新通道与 logo 箭头 |
| [probe.mjs](probe.mjs) | 静态回归探针（427 项，不出网、不写真实状态文件） |
