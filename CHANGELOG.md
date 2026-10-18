[根目录](./AGENTS.md) > **变更记录 (Changelog)**

# CHANGELOG.md — dsh_setting_pro 完整变更史

> 本文件从 [AGENTS.md](AGENTS.md) 拆出：那份是**每个 agent 回合都要注入的工作区指令**，
> 历史叙事独占约 1/3 体积，把它留在原地等于每次注入一段过期历史。
>
> **这里是原始记录，逐条照搬、不改写**（含当时写错的数字与被后续推翻的结论 ——
> 保留原文才能回溯「当时为什么这么判」）。每条都对应一个 git 提交，可 `git log` 复核。
>
> 想知道**现在**是怎么回事：约束与连带项看 [AGENTS.md](AGENTS.md)，
> 取舍看 [IMPLEMENTATION.md](IMPLEMENTATION.md)，用法看 [README.md](README.md)。
>
> ⚠️ 条目里的**现场数字**（探针项数、行数、路由数、字典键数、字号）都是**当时**的快照，
> 后续改动过的以代码与 `node probe.mjs` 当前输出为准，**别照着旧条目改代码**。
> 已知的两处漂移：① 探针项数（现 348）；② 机器名字号 —— 0.5.0/0.6.0 那两条写的 `16px`
> 是当时的值，现在 `.dspro_brandName` 是 **20px/600 + 行高 24px**、状态 chip **16px**
> （2026-10-18 用户指定，探针已把这三个值钉住）。

## 变更记录 (Changelog)

- `2026-10-16T23:37:54+0800` · **init-architect 首次生成**：全仓清点 5 文件（覆盖 100%）、单模块扁平
  结构；新增本文件与 [.agents/index.json](.agents/index.json)。缺口：无 `IMPLEMENTATION.md`、无测试目录、
  无 `.gitignore`（非 git 仓库）。验证结论：`node --check` 两半与 JSON/YAML 解析通过；`dsh --profile web
  --dump-config` 在 agent 沙箱内因写 `~/.dsh/profiles/web/cordis.yml` 报 EROFS。

- `2026-10-16T23:52:19+0800` · **功能：Host 重启 / 空闲后重启（0.3.0）**。参考 `dshmarket` 的自我重启
  实现后确定：它在 systemd 下默认关闭（`KillMode=control-group` 会连 detached helper 一起回收），
  故本插件改走游离临时单元。新增 `index.js` 的四条路由、三个工具、探测与空闲闸；`client.js` 新增
  「Host 运维」三行与状态轮询；新增 `probe.mjs`（84 项，全绿）；README / AGENTS / package.json 同步到 0.3.0。
  未验证项：真实重启需用户点击触发（首次需宿主手动重启一次以加载新 Host 半边）。

- `2026-10-17T00:58:29+0800` · **修复 + 功能：按钮可点、宿主判据、最后启动时间**。用户报「空闲重启不可点」
  → 查证：journal 里 23:42 之后再无条目、`_PID=2510837` 未变，说明 **dsh 从未重启**，新 Host 半边没加载；
  且路由不存在时 SPA 兜底回的是 **`200 text/html`**（不是 404），旧客户端只认 404，`json()` 抛错被吞，
  状态永远为 `null` → 三个按钮全灰。三处修复：① 以 `content-type` 判定非 JSON 响应并标 `missing`；
  ② 「重启 DSH」「空闲后重启」不再因 `!supported/armed` 禁用，点击由 Host 返回真实原因；
  ③ **宿主判据从「父进程 comm === systemd」改为「cgroup 叶子 `.service`」** —— 本机是
  `npx -y @deepseek-ai/dsh` 拉起（父进程 npx、`_SYSTEMD_CGROUP=…/app.slice/dsh.service`），旧判据会让
  重启后依然判为不支持。新增 `describeHost()`（带 `reason`）、状态里新增 `startedAt`/`uptimeMs`/
  `parentManaged`/`reason` 与 `formatDuration()`，界面状态行显示**最后启动时间与已运行时长**；
  排程改为幂等（重复点击不重置静默窗）。探针 84 → **110 项全绿**（新增 describeHost 五例、启动时间四例、
  字典键覆盖与按钮状态静态断言）。

- `2026-10-17T01:08:59+0800` · **功能：dsh 版本显示 + 打开页面检查更新（0.4.0）**。新增
  `resolveDshVersion()`（从 `process.argv[1]` 往上找 `@deepseek-ai/dsh` 的 package.json；env 覆盖；
  找不到则记 nearest/none，绝不 import 官方包）、`parseVersion`/`compareVersions`（semver + 预发布规则，
  坏数据返回 null）、`summariseVersions`（**所有** dist-tag 取最高 —— 本机 `latest=0.2.0-rc.2` 但
  `alpha=0.2.1-alpha.5`，只看 latest 会漏；这一条与 dshmarket #867 同坑）、`createVersionChecker`
  （轻量端点 `/-/package/@deepseek-ai/dsh/dist-tags`，6h 缓存，失败保留上次成功结论）、
  新路由 `GET /setting-pro/version`（`?refresh=1` 强制重查）；`status` 新增 `dshVersion`/`dshVersionSource`，
  工具输出新增 `dsh:` 行；界面新增「DSH 版本」块（打开页面即查一次，有更新给 warn 色提示 + 「检查更新」按钮）。
  新增字典键 16 个（zh/en 同步）。探针 110 → **151 项全绿**（版本比较六例、resolveDshVersion 四例、
  summariseVersions 六例、checker 缓存/失败/抖动七例、版本路由契约三例、组件树与字典键覆盖）。
  仍未验证：真实重启与真实 registry 响应都需在宿主环境跑一次（探针两者都用假实现）。

- `2026-10-17T01:43:58+0800` · **功能：机器名字 + 显示在左上角 logo 下面（0.5.0）**。用户要「机器名字设置，
  设完显示在 dsh web 左上角 logo 下」。查证：`sidebar.brand.mark` / `sidebar.brand.name` 都是
  `kind: "single"` 且被官方 `dsh-client-ui-brand-official` 占了（**重复注册会抛错**），logo 与「新会话」
  之间也没有 list 槽 → 只能 DOM 注入。Host 侧新增 `stateFilePath`（`$DSH_HOME/setting-pro.json`）/
  `sanitizeMachineName`（剥控制字符、折叠空白、截断 64、非字符串 → null）/ `createMachineStore`
  （tmp+rename 原子写、保留同文件其它键、坏数据退回空名并记 error），新增路由
  `GET/POST /setting-pro/machine`（非字符串 name → 400，空串＝清除），`status` 新增
  `machineName`/`machineNamePath`，工具输出新增 `machine:` 行；浏览器侧新增「机器名字」行（输入 +
  保存/清除，存后广播自定义事件）与 `startMachineLabel()`（DOM 注入到品牌行之后；锚点＝
  `[data-window-drag]` 且含 svg、不含 button、有 `[aria-hidden="true"]`；MutationObserver + 30s 轮询
  重新对齐；名字只走 textContent；卸载时断开观察者并撤节点）。新增字典键 18 个（zh/en 同步）。
  探针 151 → **195 项全绿**（机器名清洗/路径/store 十二例、路由契约四例，外加**假 DOM + 假 MutationObserver**
  驱动的标签生命周期六例：插对位置、不插 topStrip、文案来自 Host、改名即时更新、清空撤节点、卸载清理）。
  仍未验证：真实浏览器里的观感（锚点是否命中、侧边栏折叠时的表现）需在页面上看。

- `2026-10-17T02:30:52+0800` · **修复 + 功能：机器名直接顶替左上角品牌区（0.6.0）**。用户先报「配了名字但没出现」
  → 查证：早先 DOM 锚点判据里写了「不含 button」，而 **logo 行里就有收起/展开按钮**，等于把目标元素自己排除，
  永远找不到锚点；改用类名后缀 `[class*="_logoRow"]` 后用户确认「现在看到了」。随后用户要「直接替换 logo」，
  并指出已装的 `@smalltailqwq/dsh-client-ui-skin-orca-link` 就是完全替换（查证：那个皮肤**不用槽位**，
  走纯 CSS `visibility:hidden` 官方品牌区 + 自绘图案，并大量依赖 `[data-slot=sidebar]` 这类稳定锚点）。
  本插件改用**官方槽位优先级**：single 槽只在**同一 priority** 重复注册才抛错、投影按 priority 升序取第一个，
  于是 `priority: -1` 即可顶掉官方 `dsh-client-ui-brand-official`（priority 0）。实现：`machineNameStore`
  （唯一名字来源：进页面读一次 + 30s 轮询 + 同页面事件）、`startBrandReplacement()`（等 `slots.inject` 声明后，
  有名字才注册 `MachineBrandMark`/`MachineBrandName`，清空则撤销、官方 logo 自动回来）、
  `startMachineNameSource()`、`useMachineName()`；DOM 那条降级为**兜底**（`mode: 'dom'` 时才画），
  并在设置页加一行「左上角现在是什么样」的说明。`.dspro_brandName` 用 16px/600 显示（原来的小字是 11-12px）。
  探针 195 → **204 项全绿**（品牌区两条路：占位/撤销/组件渲染/不重复画兜底；兜底路：锚点回归、
  不插 topStrip、改名、卸载；并给假 DOM 补上 `document.querySelector` 委派、类名与「logo 行含 button」的真实结构）。

- `2026-10-17T02:40:00+0800` · **文档：README 按「dsh 插件 README 编写经验」重写，新建 IMPLEMENTATION.md**。
  经验要求：README 只写怎么用、「为什么」归 IMPLEMENTATION.md、开篇立论 + 三行文档分工、必写三种装法与坑、
  `--profile` 必填、生效条件分两半、界面入口用官方物件定位、扩展点占用表、验证分命令行与浏览器两层、
  数字要能被命令复算。据此 README 269 → **306 行**：开篇立论 → 功能表 → 快速开始（三种装法 + 三条坑 +
  逐步用起来 + 「确认它真的在工作」）→ 界面逐块走查（ASCII 版式）→ 生效条件两半 → 结构（文件表 +
  两侧 `inject` 清单 + **扩展点占用表**）→ 线上协议（6 条路由 + 9 个本地错误码 + HTTP 状态映射 + 示例）→
  安全模型 → 与 Agent 的关系 → 排错表（11 条症状）→ 验证（命令行 5 步 + 浏览器 12 条打勾）→
  已知边界（8 条，每条带原因与代价）→ 相关文件表；取舍搬到新建的 [IMPLEMENTATION.md](IMPLEMENTATION.md)
  （151 行，七节「约束 → 为什么 → 代价」，含一次「点重启」的完整路径）。
  数字全部实测复算：探针 204、路由 6、工具 3、本地错误码 9、Host inject 4、客户端 inject 2、
  localStorage 键 2、环境变量 3、字典键 79×2、`index.js` 1161 行 / `client.js` 1307 行、版本 0.6.0；
  README 内 9 个相对链接用脚本逐个核对存在。

- `2026-10-17T02:57:47+0800` · **功能：logo 后面的「运行中」指示（0.7.0）**。用户问「哪个插件在 logo 后面有 running
  状态」，查证是已装的 `@smalltailqwq/dsh-client-ui-skin-orca-link`：它的信号 chip 挂在
  `[data-slot=sidebar] > :first-child > [class*=logoRow]` 行末，状态由 `resolveStatus()` **纯读官方 DOM** 推出
  （`[data-state='running']` / 停止按钮图标 / `[data-phase]` / `[data-*-key]` / composer phase / chat-flow 末行），
  10 个文案（working = `TASK RUNNING`），MutationObserver 只过滤 5 个属性 + transcript 防抖。
  **本插件按同一位置、不同口径实现**：读 Host `/status` 的 `busy`/`runningCount`（5s 轮询 → `busyStore`），
  有会话在跑时在 `[class*="_brandIdentity"]` 之后插 `.dspro_run`（`● 运行中 ×2`，呼吸动画、
  `prefers-reduced-motion` 下不动），空闲即撤；复用「机器名兜底行」那套锚点/观察器/卸载清理。
  为什么不用 DOM 口径：它只反映当前挂载会话，会漏子代理/其它会话，与「空闲后重启」自相矛盾
  （写进 IMPLEMENTATION.md 第六节 + 硬性约束 21）。探针 204 → **214 项全绿**
  （新增：忙时出现/挂在品牌身份之后/文案带计数/title/只走 textContent/空闲撤掉/卸载撤掉/轮询可手动触发）。
  顺手修了探针两处：假 locale 的 `bind` 没认官方 `{zh,en}` 字典形状、假 DOM 缺 `append()`。

- `2026-10-17T17:19:54+0800` · **功能：状态指示常显 + 悬停明细（0.8.0）**。用户两点反馈：
  ①「运行中 ×2 指向后提示 xx工作区 xx会话」；②「没有运行中也给个提示」。
  Host `/status` 新增 `runningSessions: [{sessionId, workspace, title}]`（`running: string[]` 原契约不动）：
  `workspace` = `basename(header.cwd)`（官方 `defaultWorkspaceTitle` 同款；dshmarket 等已装插件也在读这个公开字段），
  `title` = 可选服务 `ctx.get('sessionTitle').get(session)`，取不到留空、不猜。
  **查证成本后加缓存**：`sessionTitle.get()` 实现是 `foldSessionTitle(session.snapshotEvents())`（每次扫全量事件），
  而 `/status` 被两路轮询反复读 → 按 sessionId 缓存 `TITLE_TTL_MS = 30s` 并清理已消失的会话；
  工作区与标题**各自包 try**（标题失败不能连带丢掉已拿到的工作区）。新增纯函数 `describeRunningSession`，
  `dsh_restart_status` 的 busy 行也带明细。客户端 `busyStore` 加 `sessions` 与 `known`
  （**未知不画** —— 没读到 ≠ 空闲，否则就是假回执），chip 从「忙时才显示」改成**常驻两态**
  （`data-state=running|idle`，空闲灰色静止），悬停按会话拼多行「工作区 · 标题」（`runningHoverText`），
  `signatureOf` 让「计数没变但标题变了」也能刷新。旧 Host 没这字段时回退成纯计数悬停。
  探针 224 → **230 项全绿**（明细悬停、签名变化、空闲不撤只切态、未知不画、`describeRunningSession` 五例、
  `runningSessions` 有/无元信息两例、**TTL 内两次读只折一次标题**的缓存计数）；顺手把文档里遗留的「四条路由」纠正为**六条**（历史 changelog 里
  0.3.0 当时确实是四条，保留原文）。仍未验证：真实浏览器观感（空闲态灰度、rail 折叠、悬停多行）。

- `2026-10-17T19:26:44+0800` · **功能：输入框下方那一行加「供应商 · 模型 · 思考档位」（0.9.0）**。
  用户给出那两枚官方 pill 的实际 DOM（`21 轮 521 步 · 164 tok/s` / `211M tok · 缓存命中 98%`），要求
  「只有模型名字和思考档位，增加 供应商 模型 思考档位」。**查证挂载点**：那行是 list 槽
  `conversation.composer.dock`（官方占用 `id: stats`、`order: 0`；官方契约文档写明「a fresh id is added
  beside the shipped entries, while reusing a shipped id puts you IN THAT cell and replaces it」，
  `replaceRisk: none`）→ 用**自己的 id `model-usage` + `order: 1` 并列**，官方两条原样保留（约束 23）。
  **数据来源查证**：官方 `ModelSelect` 的 trigger 只显示 `model.name` + 档位（`conversation.input.model`
  是 single 槽，不去顶替 —— 用户要的是「多显示」不是「换一个选择器」）；供应商名在目录分组 `group.name` 里，
  且 `deepseek-account` 这一组官方也是用本地化文案替换（照抄这条判据）。于是读**可选服务**
  `ctx.get('modelDirectories')` → `directoryFor(sessionId).store`（与那个下拉同一份快照，名字天然一致），
  取不到再退会话投影 `useProjection('modelSelection')` —— 投影里只有内部 id（`{next,lastUsed}`），
  所以退路显示 `provider/model` 并在悬停里**如实说明「这里显示的是内部 id」**，不编中文名。
  档位判据与官方 trigger 逐条对齐：显式 `reasoningEffort` → 目录 `defaultEffort` →
  无 `reasoning` 元信息时用 `retainedEffort` → 都查不到就显示 id。设置页新增一块「输入框下方那一行」：
  勾选框（偏好键 `dsh.setting-pro.modelPill`，缺省开）+ **真实挂载状态行**（已挂上 / 还没挂上 / 挂不上：<原因>）。
  **两个时序坑**（写成约束 24）：① `directoryFor()` 会抛（session 未装配）→ 整段包 try；
  ② `modelDirectories` 由**另一个插件的 apply** 挂载、可能晚于我们 → 不在挂载时一次性解析，改成渲染时
  惰性解析 + 命中缓存 + 退避重试 `MODEL_RETRY_STEPS = [200,500,1000,2000,4000]`，**试完就放弃**
  （不做永久轮询别人内部服务的循环）。另外 `slots.inject` 的回调内部单独包 try：那个回调跑在槽位
  **被声明的那一刻**，`apply` 外层 try 抓不到，而官方 `notifyDeclaration`/`flush` 是**裸循环、不隔离异常**
  —— 从这里抛出去会连累同一次声明里其它插件的注册。
  新增字典键 16 个（zh/en 同步，82 → **98**）；`client.js` 1467 → **1904 行**；探针 230 → **270 项全绿**
  （第 15 类：`describeModelState` 六种输入、挂载形状验 `id`/`order`/不带 `priority`、目录可用与
  `directoryFor` 抛错两条渲染路、开关「关掉 → 落盘 `'0'` → 那一格真的不渲染」、重新物化模块时默认值
  真的读 localStorage、错误隔离断言异常没冒回通知循环）。
  **顺手修了探针一个真漏洞**：假 `window.localStorage` 引用了一个**从未声明**的 `storage`，于是所有走
  localStorage 的分支（尺寸、重启排程记号、这次的开关）都被 try/catch 静默吞掉、等于从没被测过（写进约束 9）。
  并用变异测试确认新断言真在咬：内层 `catch` 改成 `throw` → 2 项失败；复用官方 `id: stats` → 2 项失败；
  `order` 改 0 → 1 项失败；开关失效 / 落盘写死 / 忽略关闭 → 各 1–4 项失败。
  仍未验证：真实浏览器观感（窄屏会不会挤压官方两条、目录晚到时多久跟上）。

- `2026-10-17T20:56:26+0800` · **功能：重启工具是否开放给 agent 的开关（0.10.0）**。用户对着功能表里
  「模型侧工具」那一行说「这个增加个开关，是否开放给 agent」。
  **查证能否即时生效**：`ctx.tools.register()` 的返回是「the exact disposer that unregisters the tool」，
  且工具表在每次派发时现取（`dsh-tools` 里 `view.visible` 的投影），所以**注册/注销不需要重启 dsh** ——
  这决定了整个方案（否则就得走「重启后生效」那种差体验）。注销后同名可再注册（`NamedEntries` 按名增删）。
  **生命周期查证**：cordis 的服务代理在调用时把 `this.ctx` 绑到**调用方**，所以从 HTTP 处理函数里调
  `ctx.tools.register()` 时，effect 仍落在**本插件的 fiber** 上（卸载一起收掉），不会挂到短命的请求作用域；
  `Context.effect()` 的 disposer 是幂等的（`disposing` 标志 + `disposables.splice(0)`），
  所以提前手动调用再等插件卸载时二次调用是安全的（写进约束 25）。
  实现：Host 侧新增 `createToolGate(ctx, control)`（按状态文件里的 `agentTools` 决定注册还是注销，
  暴露 `view` 实时状态）+ `registerTools(ctx, control, register)`（改收注册回调）+
  `describeAgentTools(status)` 纯函数 + 第 7 条路由 `GET/POST /setting-pro/agent-tools`；
  状态文件 `$DSH_HOME/setting-pro.json` 多一个键 `agentTools`（缺省 **开**：0.3.0 起这三个工具一直注册着，
  加开关不该改变既有行为），两个键**必须共用同一套合并写**（新增内部 `patch()`），否则存名字会抹掉开关。
  `/status` 新增 **四个**字段并刻意把「开关值」与「实际注册」分开：`agentTools` / `agentToolsExposed` /
  `agentToolsNames[]` / `agentToolsError` —— 不一致就是没生效，必须显式讲（约束 25，与约束 13 同一精神）；
  `dsh_restart_status` 也多一行 `agent tools:`。浏览器侧在「Host 运维」块加一个复选框 + 一行实际状态
  （已开放 / 未开放 / **不知道**（还没读到状态，不说成「未开放」）/ ⚠ 不一致），
  数据直接取自每 2s 已在刷的 `/status`，**不再单独 GET**（一处真相）；POST 完立刻重读，
  显示 Host 报回来的实际状态而不是我们发过去的那个布尔。
  注册抛错（撞工具名）在 `apply` 里兜住：**不许把整个插件带崩**（那会连累七条路由与设置页）。
  新增字典键 8 个（zh/en 同步，98 → **106**）；`index.js` 1238 → **1453 行**、`client.js` 1904 → **1991 行**；
  探针 270 → **334 项全绿**（第 15 类：`describeAgentTools` 五种组合、一个文件两个键互不覆盖、
  假 fs + 假 ctx 的完整闭环「关掉 → 工具表真的空了 → 再开又回来 → dispose 收干净」、路由契约、
  `apply` 层面用临时 `DSH_HOME` 验「文件里是关 → 一个都不注册」与「没这个键 → 按缺省注册三个」、
  注册抛错不外抛且报不一致；外加浏览器半边卸载时**真的注销三个工具**这条回归）。
  **本轮又修了探针一处结构性问题**：组 7 末尾的「收摊」以前只是清计时器，现在会真的注销工具，
  于是第 10 组复用同一份 fake 时拿不到工具 → 改成自建一份（顺带把「卸载即注销」变成断言）。
  变异测试确认新断言在咬：合并写丢 `machineName` → 2 项失败；`enabled` 类型闸失效 → 1 项；
  状态把开关值当实际注册 → 1 项；`catch` 里把开关说成关 → 1 项；客户端把未知说成未开放 → 3 项；
  不一致当一致 / 不标错误色 / `checked` 写死 → 各 1 项。（另两类改动经核对是**等价变异**：
  `agentTools` 恒为布尔时 `=== true` 与 `!== false` 无法区分，不强求。）
  同时：仓库首次入库（`main` + `.gitignore`），tag `0.10` 与 `package.json` 的 `0.10.0` 对应。
  仍未验证：真实页面上勾选后**当前正在跑的回合**是否还带着旧工具列表（设计上是「不追溯」，见 README 已知边界）。

- `2026-10-18T10:15:14+0800` · **修复：dsh 版本读成了别的项目的版本号（更新检查因此整个废掉）**。
  起因是核对推送状态时随手看了一次 `dsh_restart_status`：那行写 `dsh: 1.7.1 (nearest)`，而
  `npm ls -g` 装的是 `0.2.0-rc.2`。**先查证再动手**：`ls -l <prefix>/bin/dsh` 是指向
  `../lib/node_modules/@deepseek-ai/dsh/lib/bin.js` 的**符号链接**，而本机 `<prefix>` =
  `~/.nvs/node/24.13.0/x64`；`resolveDshVersion` 拿 `argv[1]`（那个链接路径）**往上走**时，
  `bin/` 这一支根本碰不到 dsh 包，先撞上的是 `<prefix>/package.json` —— 属于**版本管理器 nvs 自己**，
  版本 `1.7.1`。用 `realpath` 后再走就命中 `source: 'package' / 0.2.0-rc.2`（实测两条都跑过）。
  **危害不只是显示错**：`1.7.1` 被当成当前版本送进 `summariseVersions`，比 registry 的
  `next=0.2.1-rc.2`、`alpha=0.2.1-alpha.5` 都「新」→ 永远判「已是最新」，更新检查静默失效，
  而且界面一切正常 —— 最难发现的那类 bug（0.4.0 上线起就带着，本机全局装法必现）。
  修法两条，第二条才是根本的：① 入口先 `realpath`（注入 `realpath`，探针能喂假链接；
  realpath 失败退回原路径，宁可少认一层也别整个判不出来）；② **`nearest` 不再带版本号**
  —— `version: null`，只留 `source`/`name`/`path` 当线索；将来再冒出别的路径花样也不会把
  别人的版本号冒充成 dsh 版本（与约束 15「解析不出就说不清，不装作相等」同一纪律，写成约束 26）。
  界面那句 `comparable === false` 的文案跟着改准（原来只提 semver，现在还包括「没找到它的 package.json」）。
  **另外补了约束 27 和一类新断言**：README 协议表抄了一份 `status()` 字段清单，本轮刚加过
  `agentTools*` 四个字段，正是最容易漂的时机 → 用 `topLevelFields`（按花括号深度切；清单里有
  嵌套的 `runningSessions[{…}]`，朴素的 `[^}]*` 只会匹到最内层那一段 —— 这个坑本轮踩过一次，
  第一版断言因此恒真）把它解析出来与代码实际键**双向**比对。
  探针 338 → **344 项全绿**（新增 realpath 三例 + nearest 不冒充 + 文档自洽双向两例）；
  `index.js` 1453 → **1470 行**；**未发版**（用户选「先只提交」）：`package.json` 仍是 `0.10.0`，
  tag `0.10` 指向首个提交、**不含**本修复，下次发版必须 bump `0.11`，不要 force-push 覆盖已推的 tag。
  验证边界：本修复改的是 `index.js`，**要重启 dsh 才生效**；沙箱里不能自重启（`systemctl --user`
  连不上 user bus），所以「重启后界面显示 `0.2.0-rc.2`、来源 `package`」这一条仍需用户在界面上核。
  顺带把文档里所有现场数字重算同步（探针数、行数、类数、DSH 版本清单三条、硬性约束 27 条）。

- `2026-10-18T10:35:23+0800` · **样式 + 探针缺陷：字号按用户指定放大，探针不再读真实状态文件**。两件事一起做，
  因为第二件是用户操作直接撞出来的。
  ① 用户给出左上角实际 DOM（`span.dspro_brandName`）并要求「字体 20、dspro_run 字体 16」。
  改之前先查官方那一行的盒模型（`grep -o "_brandName{[^}]*}" …/dsh-client-ui-sidebar/lib/client.js`）：
  官方 `_brandName`/`_brandIdentity` 都写死 `height:24px` + `align-items:center`，
  `_logoRow` 是 `height:60px; padding:8px 0`（净 44px）。所以**字号放大时行高必须 ≤24px**，
  否则会把官方那一行的行盒撑变形 —— 我第一版顺手写的 `line-height:28px` 就是这么错的，查证后收回
  24px（chip 用 20px + 上下 2px 内距 = 24px 总高）。圆点 5px→7px、`gap` 4→5、内距 1px 6px→2px 8px
  随字号一起放大。CSS 是注入的字符串、假 DOM 不看样式，渲染层测不到 → 用三条源码断言钉住
  （20px / 行高 24px / chip 16px+20px），变异测试四个方向全被咬（改回 16px、行高写 28、chip 回 10px、
  chip 行高写 24 各 1 项失败）。README 三处「16px 加粗」同步为 20px。
  ② 跑探针时它**崩了**（组 7 `fake.tools.get('dsh_restart_status').execute()` → TypeError）：
  用户 10:28 在界面上把「开放给 agent」关掉了，而 `apply()` 读的是**真实** `~/.dsh/setting-pro.json`
  → 一个工具都没注册 → 测试红。**「测试跑不跑得过」取决于用户界面上的勾选**，这是探针的缺陷
  （它一直号称不写真实状态文件，却会读）。修法：import 之后立刻把 `DSH_HOME` 指到仓库里的
  `.probe-env/`（先删里面那个文件，让「没有该键 → 按缺省注册」这条路径稳定），并加断言钉住
  `stateFilePath()` 落在临时目录 —— 写成约束 28。第一版我插在文件中段，位置太晚（组 7 已经跑完），
  `stateFilePath()` 是调用时读 env 而不是 import 时读，所以必须挪到 import 正后方。
  顺带确证：我自己调 `dsh_restart_status` 得到 `unknown tool` —— 那个开关**对模型侧确实即时生效**。
  探针 344 → **348 项全绿**（字号三条 + 环境隔离一条）；`client.js` 1991 → **1997 行**、
  `probe.mjs` 1768 → 1783 行；`.gitignore` 加 `.probe-env/`。本轮只动 `client.js`（字号）与探针，
  **Host 半边未改** → 字号**刷新页面**即生效，不需要重启 dsh。真实状态文件全程未被探针写过（10:28 那份原样）。

- `2026-10-19T00:50:00+0800` · **修复：四个在跑的会话悬停显示同一个标题（用户实测截图为证）**。
  现象里藏着两条线索：四个会话的**工作区各不相同**（`dsh_setting_pro` / `dsh_sidebar_terminal` / `.dsh`），
  标题却全是同一个 `/init-architect`，并且后面还跟着字面量 `（undefined）`。
  **先查证不猜**：读官方 `dsh-agent` 的 `enter()`，看到 `const id = agent.id; if (id !== agent.session.id) throw …`
  —— `ctx.agents.list()` 的条目上 id 挂在 **`agent.id`**，**没有 `agent.sessionId`**。
  而我写的是 `String(agent.sessionId)` → 每个会话都得到字符串 `"undefined"`：
  ① 标题缓存 key 全撞成同一个 → 第一个会话折出的标题被复用到全部（工作区不缓存，所以看着是对的）；
  ② `describeRunningSession` 见 id 非空就拼括号 → 那个 `（undefined）`。
  修法：新增顶层导出 `agentIdOf(agent)`（取 `agent.id`，退 `agent.session.id`，都没有返回**空串**），
  且空串时**不读也不写缓存**（宁可多折一次标题，也不能让不同会话共用一个槽）。
  **探针为什么没抓到**：假 agents 同时给了 `sessionId` 和 `session.id`，比真实更宽松 ——
  与 2026-10-17 那个 localStorage 洞同源（假实现宽容 → 断言恒真）。现在假数据只给真实字段，
  并补三类断言（三会话各拿自己的标题 / sessionId 不是 `"undefined"` / 无 id 条目不进缓存）。
  变异测试：改回 `agent.sessionId` → 9 项失败；去掉 `session.id` 兜底 → 1 项；空 id 也进缓存 → 1 项；
  用 `String()` 造 `"undefined"` → 6 项。
  ⚠️ 修复在 `index.js`，**要重启 dsh 才生效**；重启前悬停仍是同一个标题。

- `2026-10-19T01:10:00+0800` · **功能：排程重启时在状态指示后面加感叹号**（用户 2026-10-18 要求）。
  chip 文字后挂一个独立 span（只有它能单独吃 warn 色，不污染忙时绿底 / 闲时灰字），
  悬停与 `aria-label` 都补一行「已排程：等所有会话空闲后重启 DSH」（读屏拿不到悬停文本，所以 aria 里也写）。
  **空闲但已排程也标** —— 那正是「马上要重启」，不标等于告诉用户没事发生。
  踩到一个隐蔽坑：`busyStore.set()` 的短路比较原本只比 `busy/count/sessions`，
  「点了排程但会话状态没变」那一帧会被判成没变化而丢弃，感叹号要等别的字段变了才出现 ——
  现在 `armed` 一起比，探针专门用「空闲态只翻 armed 再轮询」这一帧钉住它。
  色值只用确认存在的 token（`--dsw-alias-state-warn-primary`，本机实测 11 处引用）。
  变异测试：去掉 armed 短路比较 → 6 项；get 不带 armed → 6 项；不渲染 → 4 项；取消不移除 → 1 项；
  轮询不读 armed → 6 项；悬停不说明 → 1 项。

- `2026-10-19T02:55:00+0800` · **功能：「运行中」从左上角品牌行迁到左下角 `sidebar.footer.action`**
  （用户 2026-10-19：「改为 左下角悬浮显示」）。先侦察：官方 `dsh-client-ui-sidebar` 把这个槽位声明成
  `kind:"list"` / `scope:"root"`，渲染在 `footArea > footerActions`，把 `{ wide }` 透给注册者，
  官方自己只占 `id:"cordis-panel"` 一格 —— 所以走**槽位注册**（不抢 DOM）：自己的 id `run-status`、
  `order: 10` 排在官方面板之后。品牌行里整套 chip DOM 注入（`runNode`/`removeRun`）删掉，
  那一行只剩「机器名兜底 + 更新箭头」，188px 的横向预算终于松了。
  **顺手补上一个真实测试缺口**：`busyStore` 是模块级单例，探针没法把它重置成「从没读到过」，
  于是「未知不画」这条**测不到**（第一版变异测试就漏了它，显示 MISSED）。把判据抽成纯函数
  `describeChip(state, t)` 后可以喂 `null` / `known:false`，补测后才被咬住。
  变异测试：挂回品牌槽位 → 31 项；order 写 0 → 1 项；两态塌成一个 → 2 项；不画感叹号 → 3 项；
  抢官方 id → 1 项；未知也画 → 1 项；计数写死 → 2 项；无障碍名丢内容 → 2 项。

- `2026-10-19T03:15:00+0800` · **功能：设置页分 UI / Host / Agent 三栏**（用户要求「增加 tab」）。
  按**读者是谁**分，不按存储位置分：`UI` 改的是你看到的样子（尺寸、机器名字、那一行开关；
  机器名的值虽然存 Host，但改的是左上角显示）、`Host` 是你对着这台机器做的运维动作（三个按钮 + 版本块）、
  `Agent` 管的是**模型能看到什么**（「开放给 agent」从 Host 运维块里拆出去，因为读者完全不同）。
  分区状态用 store 而不是 `useState`，两个理由：① 假 React 的 `useState` setter 是空操作，
  探针切不了 tab 就**测不到分区隔离**（而这正是唯一可能出错的地方）；② 两块都要读 `/status`，
  各自轮询就是两份 2s 请求 → 抽成 `hostStatusStore` + 引用计数的 `useHostStatusPolling`（一份定时器），
  提示语也共享，顺带修好「点了排程再切栏，提示就没了」。块归属只有一处真相 `tabOfBlock(name)`。
  偏好落 `dsh.setting-pro.tab`。**探针抓到我自己一个真 bug**：`init()` 原来写成「只有合法才赋值」，
  于是残留旧值会冒充「恢复成功」——用户把 localStorage 改成乱码时，界面停在一个他并没选过的分区上；
  改成无条件赋值（坏值 / 没存过一律落 `ui`）。
  变异测试：6 个方向全被咬（归错栏 → 5 项、不按分区过滤 → 5 项、init 条件赋值 → 2 项等）。

- `2026-10-19T03:30:00+0800` · **功能：版本检查区分 latest / next / alpha，用户可选通道；有新版本时 logo 处显示向上箭头**。
  `summariseVersions(current, tags, channel)` 加第三参：默认 `auto`＝所有 dist-tag 取最高（0.4.0 起的既有行为，
  加通道不偷偷改结论）；指定通道只跟那条线比。**通道不存在时不偷偷退回 auto**（那会把「这条线没发布」
  说成「已是最新」），额外给 `channelMissing` 且 `newer`/`upToDate` 都不置真。
  关键设计：**缓存只存 registry 返回的原始 dist-tags，结论按通道现算** → 切通道是纯本地重算，
  不打 registry、不用等 6h 过期、也不会因为缓存里存的是上一个通道的结论而互相污染。路由 `?channel=`。
  箭头判据 `updateAvailable()` 有一条硬规则：**`current` 为空时绝不标「有更新」** ——
  拿不到基准就没资格下结论（这正是 2026-10-18 版本误报 bug 的反面）。
  版本轮询从 `VersionBlock` 提到 `apply()` 里（5 分钟，`versionStore`）：那个组件只在打开设置页时挂载，
  而箭头要**常驻**在 logo 上；设置页与箭头读同一份 store，两处不会给两个结论。
  通道偏好落 `dsh.setting-pro.channel`。
  探针：415 → **427 项全绿**；字典 113 → **119 键**（zh/en 仍严格相等）；行数 `index.js` 1514 /
  `client.js` 2515 / `probe.mjs` 2125。
  变异测试：9 个方向全被咬（挂回品牌槽位 31 项、order 0 → 1 项、两态塌成 1 个 → 2 项、
  不画感叹号 → 3 项、抢 id → 1 项、未知也画 → 1 项、计数写死 → 2 项、aria 丢内容 → 2 项）。
  生效边界：箭头与通道选择在 `client.js`（刷新页面即可）；`?channel=` 与标题取 id 在 `index.js`（**要重启 dsh**）。
