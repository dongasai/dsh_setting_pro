/**
 * @module @dongasai/dsh-setting-pro/client
 *
 * **浏览器半边：设置弹窗尺寸 + 「设置 → 高级设置」页。**
 *
 * ## 一、尺寸覆盖
 *
 * 官方设置面板（`@deepseek-ai/dsh-client-ui-settings-general` 里的 `SettingsPanel`）
 * 的几何是写死的：
 *
 *     .<hash>_panel { width:800px; height:min(800px, calc(100vh - 2*max(24px,
 *                     var(--dsh-frame-overlay-top,24px)))); max-width:calc(100vw - 48px) }
 *
 * 既没有槽位、也没有 CSS 变量、也没有 Config 能改它。它唯一的稳定锚点是面板元素自己
 * 带的 `data-shortcut-modal="settings"`（快捷键命中用的属性，连同 `role="dialog"`）。
 * 于是本插件用一条指向同一元素的、优先级更高的规则覆盖宽高：
 *
 *   - **两个属性选择器（0,2,0）压过官方的单类名（0,1,0）**，不依赖 `<style>` 的插入顺序，
 *     也不依赖官方那份哈希类名（`VOzbGW_panel` 这类名字每次构建都会变）；
 *   - 宽高走 `--dspro-width` / `--dspro-height` 两个变量，变量缺省值就是本插件开箱值；
 *   - 官方原有的 `max-width:calc(100vw - 48px)` 与高度上限一起保留，窄屏不会溢出。
 *
 * ## 二、这些设置放在哪
 *
 * 尺寸是**成组**的设置项（宽 + 高 + 恢复默认），不塞进「通用」里挤一行，而是自己注册一个
 * **设置页**：`settings.section`（list 槽，一个条目 = 左侧导航一页），`id: advanced`、
 * `label` 用 thunk 跟着语言走。页面内容由本插件自绘，版式对齐官方页面：
 * `section(max-width:760px) > h2 + p.intro + rows`。
 *
 * 注：左侧导航的图标由官方 `navIcon(id)` 按 id 硬编码，未知 id 落到默认齿轮图标 ——
 * 那一段没有槽位可换，所以「高级设置」用的是齿轮。
 *
 * 尺寸偏好存在 `localStorage`（纯浏览器侧观感偏好，不写盘、不进 settings.yaml）。
 */
window.__ModuleLoader__.load({
	id: '@dongasai/dsh-setting-pro',
	factory: (require) => {
		const React = require('react');
		const h = React.createElement;

		/** 本插件的 locale 命名空间，同时是 slot 注册的 `locale` 绑定。 */
		const NS = 'dsh-setting-pro';
		/** 浏览器侧偏好键。 */
		const STORAGE_KEY = 'dsh.setting-pro.size';
		/** 重启排程记号：发起重启时记下当前 bootId，重连后 bootId 变了就说明重启完成。 */
		const PENDING_KEY = 'dsh.setting-pro.pending-restart';
		/** Host 半边（`index.js`）注册的四条路由；与那边逐字一致。 */
		const STATUS_URL = '/setting-pro/status';
		const RESTART_URL = '/setting-pro/restart';
		const SCHEDULE_URL = '/setting-pro/schedule';
		const CANCEL_URL = '/setting-pro/cancel';
		/** 版本与更新检查；`?refresh=1` 强制重查。 */
		const VERSION_URL = '/setting-pro/version';
		/** 用户选的更新通道（浏览器偏好：看的是「这台机器上我关心哪条线」）。 */
		const CHANNEL_KEY = 'dsh.setting-pro.channel';
		/** 默认通道：auto = 所有 dist-tag 取最高（0.4.0 起的既有行为，加通道选择不偷偷改变它）。 */
		const CHANNEL_DEFAULT = 'auto';
		/**
		 * 版本轮询间隔。Host 侧对 registry 缓存 6h，客户端查再勤也快不过它；
		 * 5 分钟足够让「刚发了新版本」在一杯茶的功夫内出现在 logo 上，
		 * 又不至于每 2 秒打一次本地路由。
		 */
		const VERSION_POLL_MS = 300000;
		/** 机器名字：GET 读、POST 写。 */
		const MACHINE_URL = '/setting-pro/machine';
		/** 重启工具是否开放给 agent：GET 读、POST `{enabled}` 写（即时注册/注销，不用重启）。 */
		const AGENT_TOOLS_URL = '/setting-pro/agent-tools';
		/** 改完名字后在**同一个页面**里立刻通知左上角标签（跨标签页靠 30s 轮询兜底）。 */
		const MACHINE_EVENT = 'dsh-setting-pro:machine-name';
		/** 左上角标签重新对齐 DOM 的轮询间隔（侧边栏折叠/展开、重渲染时兜底）。 */
		const MACHINE_DOM_POLL_MS = 30_000;
		/** 机器名字在侧边栏里的类名（DOM 兜底那一行，也是它的锚点标记）。 */
		const MACHINE_CLASS = 'dspro_machine';
		/**
		 * 品牌区占位用的 priority。
		 *
		 * 官方 `dsh-client-ui-brand-official` 用默认 priority（0）占了
		 * `sidebar.brand.mark` / `sidebar.brand.name` 两个 **single** 槽；single 槽只在
		 * **同一 priority** 上重复注册才抛错，渲染时按 priority 升序取第一个（lowest renders）。
		 * 所以 `-1` 就是官方认可的「顶掉它」的写法，而不是去抢 DOM。
		 */
		const BRAND_PRIORITY = -1;
		/**
		 * 机器名字的唯一来源（设置页、品牌区占位、DOM 兜底都读它）。
		 * 极简外部 store：`subscribe` 返回退订函数，组件用 `useState` + `useEffect` 跟着刷新。
		 */
		const machineNameStore = {
			value: '',
			listeners: new Set(),
			get() {
				return machineNameStore.value;
			},
			set(next) {
				const name = typeof next === 'string' ? next : '';
				if (name === machineNameStore.value) return;
				machineNameStore.value = name;
				for (const listener of [...machineNameStore.listeners]) listener(name);
			},
			subscribe(listener) {
				machineNameStore.listeners.add(listener);
				return () => machineNameStore.listeners.delete(listener);
			}
		};
		/**
		 * 左上角品牌区/标签的当前状态，供设置页解释「为什么是这样显示」。
		 * `mode`：`off`＝没设名字（官方 logo 照旧）｜`slot`＝已顶掉品牌区（大号显示）｜
		 * `dom`＝槽位占位失败、退回 logo 下面的小字｜`init`＝还没决定。
		 */
		const machineBrandState = { mode: 'init', reason: '' };
		/** 「运行中」指示的类名（挂在品牌身份后面，与 orca 皮肤同一个位置）。 */
		const RUN_CLASS = 'dspro_run';
		const RUN_LABEL_CLASS = 'dspro_runLabel';
		/** 排程标记那个感叹号（单独一个 span，才能只给它 warn 色）。 */
		const RUN_BANG_CLASS = 'dspro_runBang';
		/** logo 上的「有更新」箭头（向上）。 */
		const UPDATE_CLASS = 'dspro_update';
		const RUN_DOT_CLASS = 'dspro_runDot';
		/** 为这个指示轮询 `/status` 的间隔（设置页自己还有 2s 的轮询，这里够用就好）。 */
		const RUN_POLL_MS = 5000;
		/**
		 * 「性能与用量」那一行（官方 list 槽 `conversation.composer.dock`）里我们自己的格子。
		 *
		 * 官方文档对 list 槽的说明：「a fresh id is added beside the shipped entries,
		 * while reusing a shipped id puts you IN THAT cell and replaces it」—— 所以我们用
		 * **自己的 id**，官方那两条 pill（id `stats`，order 0）原样保留，我们排在它后面。
		 */
		const DOCK_SLOT = 'conversation.composer.dock';
		const DOCK_ID = 'model-usage';
		/** 官方 stats 是 order 0、ContextMeter 排在槽外；order 1 让我们紧贴 stats 右侧。 */
		const DOCK_ORDER = 1;
		/** 那一行是否显示模型信息（浏览器侧观感偏好，和尺寸同类，不落 Host 盘）。 */
		const MODEL_PILL_KEY = 'dsh.setting-pro.modelPill';
		/**
		 * 找 `modelDirectories` 服务时的退避重试（毫秒）。
		 *
		 * 为什么需要：那个服务由官方 `dsh-client-ui-model-selection` 在自己的 apply 里挂载，
		 * **可能比我们晚**。一次性解析会永远退化成内部 id。
		 * 为什么要有上限：这是在轮询官方面向内部的服务，不能做成永久循环；试完就停在投影退路上。
		 */
		const MODEL_RETRY_STEPS = [200, 500, 1000, 2000, 4000];
		const MODEL_CLASS = 'dspro_modelPill';
		const MODEL_LABEL_CLASS = 'dspro_modelPillLabel';
		const MODEL_SEG_CLASS = 'dspro_modelPillSeg';
		const MODEL_MODEL_CLASS = 'dspro_modelPillModel';
		const MODEL_SEP_CLASS = 'dspro_modelPillSep';
		/** 槽位挂载失败时的真实原因（设置页要说出来，不静默吞掉）。 */
		const modelPillState = { mounted: false, reason: '' };
		/**
		 * 「运行中」指示挂在左侧导航**左下角**的 `sidebar.footer.action`。
		 *
		 * 侦察记录（2026-10-19）：官方 `dsh-client-ui-sidebar` 把这个槽位声明成
		 * `kind: "list"`、`scope: "root"`，渲染在 `footArea > footerActions` 里，
		 * 并把 `{ wide }` 透给注册者；官方自己只占 `id: "cordis-panel"` 一格。
		 * 所以这里用**我们自己的 id** 并列（与约束 23 同一套判断：list 槽按 id 分格，
		 * 不同 id 都会渲染，位置只由 order 决定）—— 不抢别人的格子。
		 */
		const FOOTER_SLOT = 'sidebar.footer.action';
		const RUN_ID = 'run-status';
		/** 排在官方 cordis 面板之后（它没写 order，默认 0）。 */
		const RUN_ORDER = 10;
		/** 槽位挂载失败时的真实原因（设置页要说出来，不静默吞掉）。 */
		const runStatusState = { mounted: false, reason: '' };
		/**
		 * 「显示模型信息」开关：默认开。和 `busyStore` 一样是极简外部 store，
		 * 设置页的勾选框与那一行的 pill 都读它，改完立刻在两处生效（不用刷新）。
		 */
		const modelPillStore = {
			value: (() => {
				try {
					return window.localStorage.getItem(MODEL_PILL_KEY) !== '0';
				} catch (error) {
					return true;
				}
			})(),
			listeners: new Set(),
			get() {
				return modelPillStore.value;
			},
			set(enabled) {
				const next = enabled === true;
				if (next === modelPillStore.value) return;
				modelPillStore.value = next;
				try {
					window.localStorage.setItem(MODEL_PILL_KEY, next ? '1' : '0');
				} catch (error) {
					/* 存不下也要当场生效：只是下次进页面会回到默认（开） */
				}
				for (const listener of [...modelPillStore.listeners]) listener(next);
			},
			subscribe(listener) {
				modelPillStore.listeners.add(listener);
				return () => modelPillStore.listeners.delete(listener);
			}
		};

		/**
		 * 「高级设置」这一页的分区（UI / Host / Agent）。
		 *
		 * 做成 store 而不是 `useState`：假 React 的 `useState` setter 是空操作（切不了态），
		 * 而 `useSyncExternalStore` 会真的调 `get` —— 这样探针能把每个分区都渲染出来逐个断言。
		 * 选中的分区是**浏览器偏好**（跟面板尺寸同类：看的是「这台机器上我想停在哪一页」），
		 * 所以存 localStorage，不存 Host。
		 */
		const TAB_KEY = 'dsh.setting-pro.tab';
		const TABS = ['ui', 'host', 'agent'];
		const settingsTabStore = {
			value: 'ui',
			listeners: new Set(),
			get() {
				return settingsTabStore.value;
			},
			set(next) {
				const tab = TABS.includes(next) ? next : 'ui';
				if (tab === settingsTabStore.value) return;
				settingsTabStore.value = tab;
				try {
					window.localStorage.setItem(TAB_KEY, tab);
				} catch (error) {
					/* 存不下也要当场切换：只是下次进页面回到默认（UI） */
				}
				for (const listener of [...settingsTabStore.listeners]) listener(tab);
			},
			subscribe(listener) {
				settingsTabStore.listeners.add(listener);
				return () => settingsTabStore.listeners.delete(listener);
			},
			/**
			 * 从 localStorage 读初值。
			 *
			 * ⚠️ 必须**无条件**赋值：合法值用它，坏值 / 读不到 / 没存过一律落 'ui'。
			 * 早期写成「只有合法才赋值」，于是残留的旧值会冒充「恢复成功」——
			 * 用户把 localStorage 改成乱码时，界面停在一个他并没有选过的分区上。
			 */
			init() {
				let saved = null;
				try {
					saved = window.localStorage.getItem(TAB_KEY);
				} catch (error) {
					saved = null;
				}
				settingsTabStore.value = TABS.includes(saved) ? saved : 'ui';
				return settingsTabStore.value;
			}
		};
		settingsTabStore.init();

		/**
		 * 每个块属于哪个分区。纯函数，探针直接测 —— 归类是这轮唯一的新逻辑，
		 * 值得钉住：以后加块时必须显式选一个分区，落到 `host` 之外会被断言发现。
		 * @param block - 块名。
		 * @returns 'ui' | 'host' | 'agent'。
		 */
		function tabOfBlock(block) {
			switch (block) {
				case 'size':
				case 'machineName':
				// 名字存 Host，但它改的是**界面**（左上角品牌区），所以归 UI。
				case 'modelPill':
				// 那一格显不显示只影响本机屏幕 → 浏览器偏好，归 UI。
					return 'ui';
				case 'agentTools':
				// 开关存 Host、影响的是模型能看到什么 → 归 Agent，不放 Host（否则和「人点的按钮」混在一起）。
					return 'agent';
				case 'ops':
				case 'version':
				default:
					return 'host';
			}
		}
		/**
		 * 从会话投影里取当前选择（`modelDirectories` 服务不可用时的退路）。
		 * 官方 ModelSelect 用的就是 `next ?? lastUsed`（`next` 是已落到会话上的选择）。
		 */
		const selectionOfProjection = (projected) => {
			if (projected === null || typeof projected !== 'object') return null;
			const candidate = projected.next ?? projected.lastUsed;
			if (candidate === null || typeof candidate !== 'object') return null;
			return {
				provider: typeof candidate.provider === 'string' ? candidate.provider : '',
				model: typeof candidate.model === 'string' ? candidate.model : '',
				...typeof candidate.reasoningEffort === 'string' ? { reasoningEffort: candidate.reasoningEffort } : {}
			};
		};
		/**
		 * 把模型目录里的一段快照拼成「能不能显示、显示什么」。纯函数，探针直接测。
		 *
		 * @param state - `directory.store.getSnapshot()`（官方那份），或 null。
		 * @param fallback - 目录不可用时的选择（来自会话投影 `modelSelection`），或 null。
		 * @param names - 取名字的回调：`{ provider(id), model(id), effort(id) }`。
		 * @returns `{ segments: [{text, tone}], hover, usingIds }` 或 null（没得显示就不画）。
		 */
		const describeModelState = (state, fallback, names) => {
			const current = state !== null && typeof state === 'object' && state.current !== null && typeof state.current === 'object'
				? state.current
				: fallback;
			if (current === null || typeof current !== 'object') return null;
			const providerId = typeof current.provider === 'string' ? current.provider : '';
			const modelId = typeof current.model === 'string' ? current.model : '';
			if (providerId === '' && modelId === '') return null;
			// 目录里查得到就用人类可读名；查不到（目录还在加载 / 供应商换了）就用内部 id。
			const raw = state === null || typeof state !== 'object';
			const group = raw ? undefined : (Array.isArray(state.groups) ? state.groups : [])
				.find((entry) => entry !== null && typeof entry === 'object' && entry.id === providerId);
			const model = group === undefined ? undefined : (Array.isArray(group.models) ? group.models : [])
				.find((entry) => entry !== null && typeof entry === 'object' && entry.id === modelId);
			const providerName = group !== undefined && typeof group.name === 'string' && group.name !== '' ? group.name : providerId;
			const modelName = model !== undefined && typeof model.name === 'string' && model.name !== '' ? model.name : modelId;
			const reasoning = model !== undefined && model.reasoning !== null && typeof model.reasoning === 'object' ? model.reasoning : undefined;
			const effortId = typeof current.reasoningEffort === 'string' ? current.reasoningEffort : undefined;
			const defaultEffort = reasoning !== undefined && typeof reasoning.defaultEffort === 'string' ? reasoning.defaultEffort : undefined;
			const effectiveEffort = effortId !== undefined ? effortId : defaultEffort;
			// 与官方 trigger 同一套判据：模型没有 reasoning 元信息时，用目录里 retainedEffort；
			// 有 reasoning 但没有档位 → 「供应商默认」。
			let effortName;
			if (reasoning === undefined) {
				const retained = raw ? undefined : (typeof state.retainedEffort === 'string' ? state.retainedEffort : undefined);
				effortName = retained;
			} else if (effectiveEffort === undefined) {
				effortName = names.effortDefault();
			} else {
				const level = (Array.isArray(reasoning.efforts) ? reasoning.efforts : [])
					.find((entry) => entry !== null && typeof entry === 'object' && entry.id === effectiveEffort);
				effortName = level !== undefined && typeof level.name === 'string' && level.name !== '' ? level.name : effectiveEffort;
			}
			const providerLabel = names.provider(providerId, providerName);
			// 目录还没加载出来时（groups 里查不到），照官方 trigger 的退路显示内部 id 对
			// 「provider/model」——那是唯一能读到的身份信息，不是猜出来的中文名。
			let modelLabel = modelName;
			if (model === undefined && providerId !== '' && modelId !== '') modelLabel = providerId + '/' + modelId;
			const segments = [];
			if (providerLabel !== '') segments.push({ text: providerLabel, tone: 'dim' });
			if (modelLabel !== '') segments.push({ text: modelLabel, tone: 'strong' });
			if (typeof effortName === 'string' && effortName !== '') segments.push({ text: effortName, tone: 'dim' });
			if (segments.length === 0) return null;
			const sep = names.valueSep();
			const withId = (label, id) => (label === '' ? '—' : label) + (id !== '' && id !== label ? '（' + id + '）' : '');
			// 目录里查不到这个模型 → 我们显示的是内部 id（不是人类可读名），如实说明。
			const usingIds = model === undefined;
			const lines = [
				names.providerLine() + sep + withId(providerLabel, providerId),
				// 用内部 id 那格时不再补 id（`provider/model` 里已经有了，再加一遍是噪音）。
				names.modelLine() + sep + withId(modelLabel, usingIds ? '' : modelId),
				// 档位同理：只有拿得到目录里的显示名时才补内部 id。
				names.effortLine() + sep + withId(typeof effortName === 'string' && effortName !== '' ? effortName : '—',
					usingIds || reasoning === undefined ? '' : effectiveEffort ?? '')
			];
			if (usingIds) lines.push(names.sourceRaw());
			else if (reasoning === undefined) lines.push(names.noEffort());
			return {
				segments,
				hover: lines.join('\n'),
				usingIds
			};
		};
		/** 把会话列表拼成签名（用于「内容是否真的变了」的比较）。 */
		const signatureOf = (sessions) => (Array.isArray(sessions) ? sessions : [])
			.map((item) => String(item?.workspace ?? '') + '\u0000' + String(item?.title ?? '') + '\u0000' + String(item?.sessionId ?? ''))
			.join('\u0001');
		/**
		 * chip 的悬停文本：每个在跑的会话一行「工作区 · 会话标题」，缺失的部分自动省掉。
		 * 没有任何可读明细（旧 Host / 元信息缺失）就返回空串，界面退化成只显示计数。
		 * @param sessions - `[{ sessionId, workspace, title }]`。
		 * @returns 多行文本（可能为空）。
		 */
		const runningHoverText = (sessions) => (Array.isArray(sessions) ? sessions : [])
			.map((item) => [String(item?.workspace ?? '').trim(), String(item?.title ?? '').trim()].filter((part) => part !== '').join(' · '))
			.filter((line) => line !== '')
			.join('\n');
		/**
		 * 「现在有没有会话在跑」——唯一来源是 Host 的 `/status`（`busy` / `runningCount` / `runningSessions`）。
		 *
		 * 刻意**不**照 orca 皮肤那样读官方 DOM 的 `[data-state='running']`：那只是**当前挂载会话**的 UI 状态，
		 * 会漏掉子代理、AgentTeams 成员、其它会话里的回合；而「空闲后重启」用的正是 Host 口径 ——
		 * 同一页面上两个地方说「忙不忙」，口径必须一致，否则用户会看到「显示空闲却迟迟不重启」。
		 * `sessions` 是 `[{ sessionId, workspace, title }]`，只用来给 chip 拼悬停文本。
		 */
		const busyStore = {
			busy: false,
			runningCount: 0,
			sessions: [],
			/** 是否已排程「空闲后重启」。未知（还没读到）按 false：不猜一个感叹号给用户。 */
			armed: false,
			/** 第一次成功读到 `/status` 之前是 false：状态未知就不画，别猜一个「空闲」给用户。 */
			known: false,
			listeners: new Set(),
			/**
			 * ⚠️ `get()` 必须返回**同一个对象引用**，直到真的变了（`_snapshot` 在 `set()` 里重建）。
			 *
			 * React 18 的 `useSyncExternalStore` 明确要求 getSnapshot 结果被缓存：每次新建对象
			 * 会让它每渲染一次就判定「快照又变了」，于是无限重渲染 —— 开发模式下抛
			 * “The result of getSnapshot should be cached to avoid an infinite loop”，
			 * 生产模式下表现为组件**根本挂不上来**（2026-10-19 用户实测「运行中没有出现在左下角」）。
			 * 假 React 只是直接调一次 `get()`，所以探针 427 项全绿也看不见这个坑。
			 */
			_snapshot: null,
			get() {
				if (busyStore._snapshot === null) {
					busyStore._snapshot = {
						busy: busyStore.busy,
						runningCount: busyStore.runningCount,
						sessions: busyStore.sessions,
						armed: busyStore.armed,
						known: busyStore.known
					};
				}
				return busyStore._snapshot;
			},
			/** 把 sessions 拼成签名：busy/count 没变但标题变了，chip 的悬停文本也要跟上。 */
			_signature() {
				return signatureOf(busyStore.sessions);
			},
			set(next) {
				const busy = next !== null && next.busy === true;
				const count = next !== null && typeof next.runningCount === 'number' ? next.runningCount : 0;
				const sessions = next !== null && Array.isArray(next.sessions) ? next.sessions : [];
				const armed = next !== null && next.armed === true;
				// ⚠️ `armed` 必须一起比：只比 busy/count/sessions 的话，「点了空闲后重启、但此刻
				// 会话状态没变」那一帧会被短路掉，感叹号要等下一次别的字段变化才出现。
				if (busyStore.known === true && busy === busyStore.busy && count === busyStore.runningCount
					&& armed === busyStore.armed && signatureOf(sessions) === busyStore._signature()) return;
				busyStore.busy = busy;
				busyStore.runningCount = count;
				busyStore.sessions = sessions;
				busyStore.armed = armed;
				// 换一个新快照对象（引用变化才是 useSyncExternalStore 认的「变了」）。
				busyStore._snapshot = null;
				busyStore.known = true;
				for (const listener of [...busyStore.listeners]) listener(busyStore.get());
			},
			subscribe(listener) {
				busyStore.listeners.add(listener);
				return () => busyStore.listeners.delete(listener);
			}
		};
		/** 界面读 Host 状态的轮询间隔。 */
		const OPS_POLL_MS = 2000;
		/** 开箱尺寸：比官方 800×800 明显大一档。 */
		const DEFAULTS = { width: 1180, height: 920 };
		/** 步进器可达范围（px）。 */
		const LIMITS = {
			width: { min: 640, max: 2400 },
			height: { min: 480, max: 1600 }
		};
		/** 步进档位（px）。 */
		const STEP = 20;
		/** 面板元素锚点：官方 `SettingsPanel` 的两个属性。 */
		const PANEL_SELECTOR = '[data-shortcut-modal="settings"][role="dialog"]';
		const VAR_WIDTH = '--dspro-width';
		const VAR_HEIGHT = '--dspro-height';
		const CSS_ID = '@dongasai/dsh-setting-pro/panel-size.css';

		const PANEL_CSS = PANEL_SELECTOR + '{'
			+ 'width:var(' + VAR_WIDTH + ',' + DEFAULTS.width + 'px);'
			+ 'height:min(var(' + VAR_HEIGHT + ',' + DEFAULTS.height + 'px),'
			+ 'calc(100vh - 2 * max(24px,var(--dsh-frame-overlay-top,24px))));'
			+ 'max-width:calc(100vw - 48px)'
			+ '}';

		/**
		 * 「高级设置」页样式：页面骨架抄官方 settings 页（section/heading/intro），
		 * 行骨架抄官方 FontSizeRow（row/rowText/title/desc/control/stepper/arrows），
		 * 颜色与圆角一律走主题 token。
		 */
		const PAGE_CSS = [
			'.dspro_section{max-width:760px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}',
			'.dspro_heading{margin:0;font-size:18px;font-weight:600}',
			'.dspro_intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px}',
			'.dspro_rows{flex-direction:column;display:flex}',
			'.dspro_row{border-bottom:.5px solid var(--dsw-alias-border-l2);align-items:center;gap:8px;padding:16px 0;display:flex}',
			'.dspro_row:last-child{border-bottom:none}',
			'.dspro_rowText{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px;display:flex}',
			'.dspro_title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}',
			'.dspro_desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}',
			'.dspro_control{align-items:center;gap:8px;display:inline-flex;flex:none}',
			'.dspro_stepper{border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);justify-content:center;align-items:center;min-width:88px;height:36px;display:inline-flex;position:relative}',
			'.dspro_value{text-align:center;font-variant-numeric:tabular-nums;min-width:38px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}',
			'.dspro_unit{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}',
			'.dspro_arrows{opacity:0;flex-direction:column;gap:2px;display:flex;position:absolute;right:8px}',
			'.dspro_stepper:hover .dspro_arrows,.dspro_stepper:focus-within .dspro_arrows{opacity:1}',
			'.dspro_arrow{border-radius:var(--dsw-radius-xs);background:color-mix(in srgb, var(--dsw-alias-bg-layer-1) 75%, transparent);width:17px;height:12px;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;justify-content:center;align-items:center;padding:0;display:inline-flex}',
			'.dspro_arrow:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1)}',
			'.dspro_arrow:disabled{color:var(--dsw-alias-label-caption);cursor:default}',
			'.dspro_action{border-radius:var(--dsw-radius-sm);height:32px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-module-platform);cursor:pointer;border:none;padding:0 12px;font-family:inherit;font-size:13px;line-height:20px}',
			'.dspro_action:hover{background:var(--dsw-alias-interactive-bg-hover)}',
			'.dspro_action:disabled{color:var(--dsw-alias-label-caption);cursor:default;background:var(--dsw-alias-bg-module-platform)}',
			'.dspro_group{border-top:.5px solid var(--dsw-alias-border-l2);margin-top:8px;padding-top:16px;flex-direction:column;gap:12px;display:flex}',
			// 分区切换条：三个 tab。只用确认存在的 token（本机实测 label-*、border-l2、
			// interactive-bg-hover、--dsw-radius-sm 都在本文件其它地方用过），不写死色值。
			'.dspro_tabs{border-bottom:.5px solid var(--dsw-alias-border-l2);flex-direction:row;gap:4px;display:flex}',
			'.dspro_tab{border-bottom:2px solid transparent;color:var(--dsw-alias-label-secondary);background:transparent;border-top:none;border-left:none;border-right:none;border-radius:var(--dsw-radius-sm);cursor:pointer;padding:6px 12px;font-family:inherit;font-size:13px;line-height:20px;display:inline-flex}',
			'.dspro_tab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
			'.dspro_tab[aria-selected="true"]{border-bottom-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary);font-weight:600}',
			// 每个分区第一块自带上边框，会和 tab 条的下边框叠成双线 —— 首块去掉。
			'.dspro_tabs+.dspro_group{border-top:none;margin-top:0}',
			'.dspro_subheading{margin:0;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}',
			'.dspro_note{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px;line-height:18px}',
			'.dspro_error{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px;line-height:18px}',
			'.dspro_notice{color:var(--dsw-alias-state-warn-primary);margin:0;font-size:12px;font-weight:600;line-height:18px}',
			'.dspro_readout{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;font-variant-numeric:tabular-nums;white-space:nowrap}',
			'.dspro_input{border-radius:var(--dsw-radius-sm);height:32px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-module-platform);border:.5px solid var(--dsw-alias-border-l2);padding:0 10px;font-family:inherit;font-size:13px;line-height:20px;min-width:200px}',
			'.dspro_input:focus{outline:none;border-color:var(--dsw-alias-label-primary-bluish)}',
			'.dspro_select{border-radius:var(--dsw-radius-sm);height:32px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-module-platform);border:.5px solid var(--dsw-alias-border-l2);padding:0 8px;font-family:inherit;font-size:13px;line-height:20px;max-width:280px}',
			'.dspro_select:focus{outline:none;border-color:var(--dsw-alias-label-primary-bluish)}',
			// 左上角 logo 下面那一行机器名：**兜底**用（槽位占位失败时才显示）。
			'.' + MACHINE_CLASS + '{box-sizing:border-box;color:var(--dsw-alias-label-tertiary);padding:0 14px 6px 14px;font-size:12px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;user-select:none;-webkit-user-select:none}',
			// 顶掉官方品牌区后，那一行字就是「logo」本身：用户要 20px（2026-10-18）。
			// 行高**只给 24px**（不是 28px）：官方 `_brandName`/`_brandIdentity` 都写死 `height:24px`
			// 且 `align-items:center`，超过就会把这一行的行盒撑高。实测官方自己的字号是 18px/24px，
			// 我们 20px 塞在 24px 行盒里不会裁（容器不是 overflow:hidden），只是上下没有余量。
			// logoRow 是 `height:60px; padding:8px 0`（净 44px），竖向装得下。
			// **横向装不下，所以 `min-width:0` 是必需的、不是装饰**：官方侧栏 188px、logoRow 净宽 ≈184
			// （`justify-content:flex-end` + `overflow:hidden`），而同一行里还要放状态 chip 与收起按钮
			// （chip 16px 下「空闲」≈66px、「运行中 ×4」≈115px，加 gap/按钮后留给名字的只有几十 px，
			// 20px 的 `PVE-Work` 要 ≈90px）。flex 项默认 `min-width:auto` 会拒绝收缩到内容以下 ——
			// 那时 `text-overflow:ellipsis` 根本不生效，浏览器改从 logoRow 的 overflow 端**裁掉名字开头**。
			// 给了 `min-width:0`（并把 shrink 显式写回 1，别被别处的 `flex:none` 带歪）才会优雅省略号。
			// chip 自己是 `flex:none`：宁可名字省略号，也不能把状态指示挤没 —— 它是「忙不忙」的唯一入口。
			'.dspro_brandName{color:var(--dsw-alias-label-primary);font-size:20px;font-weight:600;line-height:24px;letter-spacing:.01em;min-width:0;flex:0 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}',
			// 「运行中」药丸：挂在品牌身份后面（logo 后面）。用户要 16px（2026-10-18）；
			// 字号一起放大的是行高/内距/圆点；行高只给 20px（药丸自己 2px 内距 = 24px 总高），
// 因为官方 `_brandIdentity` 那个容器写死 `height:24px`，再高就会把整行撑变形。
			'.' + RUN_CLASS + '{box-sizing:border-box;display:inline-flex;align-items:center;gap:5px;flex:none;margin-left:6px;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-state-success-primary);font-size:16px;font-weight:600;line-height:20px;white-space:nowrap;user-select:none;-webkit-user-select:none}',
			// logo 上的更新箭头：warn 色、不占额外行高（品牌行只有 24px 行盒）。
			'.' + UPDATE_CLASS + '{box-sizing:border-box;display:inline-flex;align-items:center;flex:none;margin-left:6px;color:var(--dsw-alias-state-warn-primary);cursor:help}',
			'.' + UPDATE_CLASS + ' svg{display:block}',
			'.' + RUN_DOT_CLASS + '{width:7px;height:7px;border-radius:50%;background:currentColor;animation:dsproRunPulse 1.4s ease-in-out infinite}',
			// 空闲态：灰一点、不呼吸（只用确认存在的 token：state-idle 只有 primary 一档，背景留透明）。
			'.' + RUN_CLASS + '[data-state="idle"]{background:transparent;color:var(--dsw-alias-state-idle-primary)}',
			'.' + RUN_CLASS + '[data-state="idle"] .' + RUN_DOT_CLASS + '{animation:none;opacity:.55}',
			'.' + RUN_LABEL_CLASS + '{font-variant-numeric:tabular-nums}',
			// 排程感叹号：只用确认存在的 token（`--dsw-alias-state-warn-primary` 本机实测 11 处引用）。
			'.' + RUN_BANG_CLASS + '{color:var(--dsw-alias-state-warn-primary);font-weight:700;line-height:1}',
			'@keyframes dsproRunPulse{0%,100%{opacity:1}50%{opacity:.25}}',
			'@media (prefers-reduced-motion:reduce){.' + RUN_DOT_CLASS + '{animation:none}}',
			// 「性能与用量」那一行里我们自己的格子：外观对齐官方 pill（同一档字号、同样的 hover 面）。
			// 字号取官方 StatsPills 用的 `content-font-size-secondary - 1px`，跟着界面字号走。
			'.' + MODEL_CLASS + '{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;max-width:100%;min-width:0;border:none;border-radius:999px;padding:1px 8px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden}',
			'.' + MODEL_CLASS + ':hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
			'.' + MODEL_CLASS + ' svg{flex:none;width:14px;height:14px}',
			'.' + MODEL_LABEL_CLASS + '{text-overflow:ellipsis;min-width:0;overflow:hidden;display:inline-flex;align-items:center;gap:6px}',
			'.' + MODEL_SEG_CLASS + '{text-overflow:ellipsis;min-width:0;overflow:hidden}',
			'.' + MODEL_MODEL_CLASS + '{color:var(--dsw-alias-label-secondary);font-weight:500}',
			'.' + MODEL_SEP_CLASS + '{color:var(--dsw-alias-separator-primary);flex:none}',
			// 设置页的复选框：沿用官方设置页的开关外观太复杂，这里用原生控件 + 主题色，够用且不写死色值。
			'.dspro_checkbox{appearance:none;-webkit-appearance:none;box-sizing:border-box;width:16px;height:16px;flex:none;margin:0;border:1.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-module-platform);cursor:pointer;display:inline-grid;place-content:center}',
			'.dspro_checkbox:hover{border-color:var(--dsw-alias-label-tertiary)}',
			'.dspro_checkbox:checked{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}',
			'.dspro_checkbox:checked::after{content:"";width:8px;height:4px;border:2px solid var(--dsw-alias-label-primary-inverted);border-top:none;border-right:none;transform:rotate(-45deg) translateY(-1px)}',
			'.dspro_checkbox:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}'
		].join('');

		const DICT = {
			zh: {
				nav: '高级设置',
				heading: '高级设置',
				intro: '插件带来的进阶项：设置弹窗（本面板）的尺寸，以及 Host 进程的重启入口。尺寸改完立即生效，只记在这台浏览器里。',
				widthTitle: '面板宽度',
				widthDesc: '设置弹窗的横向尺寸，单位像素。',
				heightTitle: '面板高度',
				heightDesc: '设置弹窗的纵向尺寸；窄屏下仍会被窗口高度上限截住。',
				resetTitle: '恢复默认尺寸',
				resetDesc: '宽高都回到 1180 × 920。',
				unit: 'px',
				increase: '加大',
				decrease: '减小',
				reset: '恢复默认',
				opsHeading: 'Host 运维',
				opsIntro: '改动 Host 半边的插件后，必须重启进程才会加载新模块。重启交给 systemd 的游离临时单元执行，页面会短暂断连后自动重连。',
				restartTitle: '重启 DSH',
				restartDesc: '立即重启宿主进程（延迟 3 秒发出，让这次应答先回到页面）。正在运行的会话会被打断。',
				restartAction: '重启',
				busyConfirmPrefix: '当前有 ',
				busyConfirmSuffix: ' 个会话在运行，重启会打断它们。仍要立即重启？',
				scheduleTitle: '空闲后重启',
				scheduleDesc: '所有会话（含子代理、AgentTeams 成员）空闲 10 秒后自动重启；排程期间可随时取消。',
				scheduleAction: '排程',
				scheduleArmed: '已排程',
				cancelTitle: '取消排程',
				cancelDesc: '撤销已排程的空闲重启；已经发出的重启无法撤销。',
				cancelAction: '取消',
				agentToolsTitle: '开放给 agent',
				agentToolsDesc: '打开后模型才能看到这三个重启工具（排程 / 查状态 / 取消）；关掉就全部注销，**立即生效，不用重启 dsh**。开关存在 Host 的状态文件里，换浏览器不会丢。',
				agentToolsOpened: '已开放：模型现在能看到这三个工具。',
				agentToolsClosed: '已收回：模型看不到这些工具（页面上的按钮照常用）。',
				agentToolsOn: '当前：已开放给 agent（注册中）',
				agentToolsOff: '当前：未开放（工具已注销）',
				agentToolsUnknown: '当前：不知道（还没读到 Host 状态）',
				agentToolsSkew: '⚠ 开关与实际不一致（没生效）',
				opsLoading: '正在读取 Host 状态…',
				opsWorking: '处理中…',
				opsMissing: 'Host 半边还没加载：这次升级需要先在宿主机上重启一次 dsh；此后本页就能自己重启。',
				opsUnsupported: '本进程不在 systemd 下，插件不做猜测性的自我重启；请在宿主机上手动重启 dsh。',
				opsBusyPrefix: '当前有 ',
				opsBusySuffix: ' 个会话在运行',
				opsIdle: '当前空闲',
				opsArmedPrefix: '已排程：已静默 ',
				opsArmedSuffix: ' 秒 / 10 秒',
				opsArmedBusyPrefix: '已排程：仍有 ',
				opsArmedBusySuffix: ' 个会话在运行，等它空闲 10 秒后重启',
				opsStartedPrefix: '最后启动 ',
				opsUptimePrefix: '（已运行 ',
				opsUptimeSuffix: '）',
				opsReasonPrefix: '原因：',
				opsFiredPrefix: '已发起重启（临时单元 ',
				opsFiredSuffix: '），约 3 秒后断开',
				opsUnitPrefix: '目标单元 ',
				opsFired: '重启已发起，页面随时可能断连；重连后本页仍在。',
				opsScheduled: '已排程：等所有会话空闲 10 秒后重启。',
				opsScheduledAlready: '已在排程中（重复点击不会重置静默计时）。',
				opsCanceled: '已取消排程。',
				opsDone: 'DSH 已重启完成。',
				opsErrorPrefix: '操作失败：',
				opsTransport: '无法连接 Host（页面可能正在重连），稍后重试。',
				versionHeading: 'DSH 版本',
				versionIntro: '打开本页时向 npm registry 查一次 dsh 的 dist-tags（Host 侧缓存 6 小时），有新版本会提示。',
				currentTitle: '当前版本',
				currentDescPrefix: '运行中的 dsh 本体；版本来源：',
				latestTitle: '最新版本',
				latestDescPrefix: 'npm dist-tags 取最高；检查于 ',
				checkAction: '检查更新',
				versionUnknown: '未知',
				versionNewerLabel: '有新版本',
				versionCurrentLabel: '当前',
				versionUpToDate: '已是最新：各 dist-tag 都不高于当前版本。',
				versionIncomparable: '无法比较：没读到可识别的 dsh 版本（找不到它的 package.json，或版本号不是 semver）。',
				versionCheckFailedPrefix: '更新检查失败：',
				versionRestartHint: '重启 dsh 时由 npx 重新解析 @deepseek-ai/dsh，能否取到取决于 npx 缓存与你所在的通道。',
				machineHeading: '机器名字',
				machineTitle: '这台机器叫什么',
				machineDesc: '存在 Host 的 $DSH_HOME/setting-pro.json（换浏览器、清站点数据都不会丢），显示在左上角 logo 下面。最多 64 字。',
				machinePlaceholder: '例如：工作机 / 客厅小主机',
				machineSave: '保存',
				machineClear: '清除',
				machineSaved: '已保存，左上角已更新。',
				machineCleared: '已清除，左上角不再显示。',
				machineFailedPrefix: '保存失败：',
				machineBrandSlot: '左上角品牌区已换成这个名字（大号显示）；清空后官方 logo 会回来。',
				machineBrandDom: '槽位占位失败，已退回 logo 下面的小字（备用方式）',
				machineBrandOff: '还没设名字，左上角仍是官方 logo。',
				machineBrandPending: '正在等侧边栏挂上，随后决定怎么显示。',
				runLabel: '运行中',
				runIdleLabel: '空闲',
				runIdleHover: '当前没有会话在运行',
				runArmedHover: '已排程：等所有会话空闲后重启 DSH',
				tabUi: 'UI',
				tabHost: 'Host',
				tabAgent: 'Agent',
				tabsAria: '高级设置分区',
				agentHeading: '模型能看到什么',
				agentIntro: '这一组管的是模型侧：改完即时生效，不用重启 dsh。页面上人点的按钮不受影响。',
				channelTitle: '更新通道',
				channelDesc: '跟哪条线比。auto = 所有通道里最高那个；选具体通道就只跟那条线比（切换只重算，不重新打 registry）。',
				channelAuto: 'auto（所有通道取最高）',
				channelMissingPrefix: '⚠ 这个通道在 registry 里没有发布过：',
				updateHoverPrefix: 'dsh 有更新：',
				updateHoverChannel: '通道 ',
				modelGroupTitle: '输入框下方那一行',
				modelGroupIntro: '官方在那里显示「N 轮 N 步 · tok/s」和 token 用量。本插件在同一行**右边并列**加一格：供应商 · 模型 · 思考档位；官方那两条原样保留。',
				modelPillShow: '显示模型信息',
				modelPillShowDesc: '关掉后那一行只剩官方内容。这个偏好只记在这台浏览器里。',
				modelPillMounted: '已挂到那一行（官方两条 pill 保留）。',
				modelPillPending: '还没挂上那一行：等对话页把槽位声明出来。',
				modelPillFailedPrefix: '挂不上那一行：',
				pillProvider: '供应商',
				pillModel: '模型',
				pillEffort: '思考档位',
				pillValueSep: '：',
				pillEffortDefault: '供应商默认',
				pillProviderAccount: 'DeepSeek 账号',
				pillNoEffort: '这个模型没有可选的思考档位',
				pillSourceRaw: '模型目录还没加载完，这里显示的是内部 id',
				pillAriaPrefix: '当前模型 '
			},
			en: {
				nav: 'Advanced',
				heading: 'Advanced',
				intro: 'Advanced items contributed by plugins: the size of this settings dialog, and the Host process restart controls. Size changes apply immediately and are remembered in this browser.',
				widthTitle: 'Panel width',
				widthDesc: 'Horizontal size of the settings dialog, in pixels.',
				heightTitle: 'Panel height',
				heightDesc: 'Vertical size of the settings dialog; the window-height cap still applies on short screens.',
				resetTitle: 'Reset to defaults',
				resetDesc: 'Restore both width and height to 1180 x 920.',
				unit: 'px',
				increase: 'Increase',
				decrease: 'Decrease',
				reset: 'Reset',
				opsHeading: 'Host operations',
				opsIntro: 'A Host-half plugin change only loads after the process restarts. The restart is handed to a detached systemd transient unit; the page disconnects briefly and reconnects by itself.',
				restartTitle: 'Restart DSH',
				restartDesc: 'Restart the Host process now (fired 3 seconds later so this response reaches the page first). Running sessions are interrupted.',
				restartAction: 'Restart',
				busyConfirmPrefix: '',
				busyConfirmSuffix: ' session(s) are running; restarting interrupts them. Restart anyway?',
				scheduleTitle: 'Restart when idle',
				scheduleDesc: 'Restart once every session (subagents and team members included) has been idle for 10 seconds. Cancellable at any time.',
				scheduleAction: 'Schedule',
				scheduleArmed: 'Scheduled',
				cancelTitle: 'Cancel schedule',
				cancelDesc: 'Drop the scheduled idle restart; a restart that already fired cannot be cancelled.',
				cancelAction: 'Cancel',
				agentToolsTitle: 'Expose to agents',
				agentToolsDesc: 'While on, models can see these three restart tools (schedule / status / cancel). Turning it off unregisters them immediately — no dsh restart needed. The flag lives in the Host state file, so it survives other browsers.',
				agentToolsOpened: 'Exposed — models can now see those three tools.',
				agentToolsClosed: 'Withdrawn — models cannot see them (the buttons on this page still work).',
				agentToolsOn: 'Now: exposed to agents (registered)',
				agentToolsOff: 'Now: withdrawn (unregistered)',
				agentToolsUnknown: 'Now: unknown (Host status not read yet)',
				agentToolsSkew: '⚠ The flag and the real state disagree (change not applied)',
				opsLoading: 'Reading Host status…',
				opsWorking: 'Working…',
				opsMissing: 'The Host half is not loaded yet: this upgrade needs one dsh restart on the host; after that this page can restart it by itself.',
				opsUnsupported: 'This process is not under systemd, so the plugin will not attempt a speculative self-restart. Restart dsh on the host instead.',
				opsBusyPrefix: 'busy: ',
				opsBusySuffix: ' session(s) running',
				opsIdle: 'idle',
				opsArmedPrefix: 'scheduled: idle ',
				opsArmedSuffix: 's of 10s',
				opsArmedBusyPrefix: 'scheduled: ',
				opsArmedBusySuffix: ' session(s) still running — restarts after 10s idle',
				opsStartedPrefix: 'started ',
				opsUptimePrefix: ' (up ',
				opsUptimeSuffix: ')',
				opsReasonPrefix: 'reason: ',
				opsFiredPrefix: 'restart fired (transient unit ',
				opsFiredSuffix: '), disconnecting in ~3s',
				opsUnitPrefix: 'unit ',
				opsFired: 'Restart fired — the page may disconnect at any moment and stays available after reconnect.',
				opsScheduled: 'Scheduled: restarts once every session has been idle for 10 seconds.',
				opsScheduledAlready: 'Already scheduled (clicking again does not reset the idle countdown).',
				opsCanceled: 'Schedule cancelled.',
				opsDone: 'DSH restarted successfully.',
				opsErrorPrefix: 'Failed: ',
				opsTransport: 'Cannot reach the Host (the page may be reconnecting); try again shortly.',
				versionHeading: 'DSH version',
				versionIntro: 'Opening this page checks the npm dist-tags once (cached on the Host for 6 hours) and flags a newer build.',
				currentTitle: 'Current version',
				currentDescPrefix: 'The running dsh package; version source: ',
				latestTitle: 'Latest version',
				latestDescPrefix: 'Highest of the npm dist-tags; checked ',
				checkAction: 'Check for updates',
				versionUnknown: 'unknown',
				versionNewerLabel: 'Update available',
				versionCurrentLabel: 'current',
				versionUpToDate: 'Up to date: no dist-tag is ahead of the running version.',
				versionIncomparable: 'Cannot compare: no recognisable dsh version was read (its package.json was not found, or the version is not semver).',
				versionCheckFailedPrefix: 'Update check failed: ',
				versionRestartHint: 'Restarting dsh re-resolves @deepseek-ai/dsh through npx; whether that picks up the new build depends on the npx cache and your channel.',
				machineHeading: 'Machine name',
				machineTitle: 'What is this machine called',
				machineDesc: 'Stored on the Host in $DSH_HOME/setting-pro.json (survives other browsers and cleared site data) and shown under the logo at the top-left. Up to 64 characters.',
				machinePlaceholder: 'e.g. workstation / living-room box',
				machineSave: 'Save',
				machineClear: 'Clear',
				machineSaved: 'Saved — the label at the top-left is updated.',
				machineCleared: 'Cleared — the label at the top-left is hidden.',
				machineFailedPrefix: 'Save failed: ',
				machineBrandSlot: 'The top-left brand area is replaced by this name (large type); clearing it brings the official logo back.',
				machineBrandDom: 'Slot takeover failed, so the name falls back to the small line under the logo',
				machineBrandOff: 'No name set yet — the top-left still shows the official logo.',
				machineBrandPending: 'Waiting for the sidebar to mount before deciding how to show it.',
				runLabel: 'RUNNING',
				runIdleLabel: 'IDLE',
				runArmedHover: 'Scheduled: dsh restarts once every session is idle',
				tabUi: 'UI',
				tabHost: 'Host',
				tabAgent: 'Agent',
				tabsAria: 'Advanced settings sections',
				agentHeading: 'What models can see',
				agentIntro: 'This group is about the model side: changes apply immediately, no dsh restart. The buttons you click on this page are unaffected.',
				channelTitle: 'Update channel',
				channelDesc: 'Which line to compare against. auto = the highest of all channels; a specific channel compares only against that one (switching recomputes locally, no new registry call).',
				channelAuto: 'auto (highest of all channels)',
				channelMissingPrefix: '⚠ That channel has no published version in the registry:',
				updateHoverPrefix: 'dsh update available: ',
				updateHoverChannel: 'channel ',
				runIdleHover: 'No sessions are running',
				modelGroupTitle: 'Composer stats row',
				modelGroupIntro: 'The official UI shows “N turns N steps · tok/s” and token usage there. This plugin adds one cell on the SAME row, beside them: provider · model · thinking level — the two official pills stay untouched.',
				modelPillShow: 'Show model info',
				modelPillShowDesc: 'Turning this off leaves that row entirely official. The preference lives in this browser only.',
				modelPillMounted: 'Mounted on that row (official pills kept).',
				modelPillPending: 'Not on that row yet: waiting for the conversation view to declare the slot.',
				modelPillFailedPrefix: 'Cannot mount on that row: ',
				pillProvider: 'Provider',
				pillModel: 'Model',
				pillEffort: 'Thinking level',
				pillValueSep: ': ',
				pillEffortDefault: 'provider default',
				pillProviderAccount: 'DeepSeek Account',
				pillNoEffort: 'This model offers no thinking levels',
				pillSourceRaw: 'The model catalog has not loaded; these are internal ids',
				pillAriaPrefix: 'Current model '
			}
		};

		/** 收进范围并吸附到步进档位。 */
		function clamp(axis, value) {
			const limit = LIMITS[axis];
			const number = Number(value);
			if (!Number.isFinite(number)) return DEFAULTS[axis];
			const snapped = Math.round(number / STEP) * STEP;
			return Math.min(limit.max, Math.max(limit.min, snapped));
		}

		/** 读 localStorage 里的尺寸；坏数据一律退回默认值。 */
		function readSize() {
			try {
				const raw = window.localStorage.getItem(STORAGE_KEY);
				if (raw === null) return { width: DEFAULTS.width, height: DEFAULTS.height };
				const parsed = JSON.parse(raw);
				const usable = parsed !== null && typeof parsed === 'object';
				return {
					width: clamp('width', usable ? parsed.width : NaN),
					height: clamp('height', usable ? parsed.height : NaN)
				};
			} catch (error) {
				return { width: DEFAULTS.width, height: DEFAULTS.height };
			}
		}

		function writeSize(size) {
			try {
				window.localStorage.setItem(STORAGE_KEY, JSON.stringify(size));
			} catch (error) {
				/* 隐私模式等写不进去：本次会话仍然生效，只是不记忆。 */
			}
		}

		/** 把尺寸写进根元素变量；面板的 CSS 立刻跟着变。 */
		function applySize(size) {
			const root = document.documentElement;
			root.style.setProperty(VAR_WIDTH, size.width + 'px');
			root.style.setProperty(VAR_HEIGHT, size.height + 'px');
		}

		function clearSize() {
			const root = document.documentElement;
			root.style.removeProperty(VAR_WIDTH);
			root.style.removeProperty(VAR_HEIGHT);
		}

		/** 幂等插入样式表，返回移除函数。 */
		function installStyles() {
			const selector = 'style[data-plugin-css=' + JSON.stringify(CSS_ID) + ']';
			if (document.querySelector(selector) !== null) return () => {};
			const tag = document.createElement('style');
			tag.dataset.plugin = '@dongasai/dsh-setting-pro';
			tag.dataset.pluginCss = CSS_ID;
			tag.textContent = PANEL_CSS + PAGE_CSS;
			document.head.appendChild(tag);
			return () => {
				tag.remove();
			};
		}

		/** 自绘的小箭头：不引官方 primitives 包，保持插件自足。 */
		function Chevron({ up }) {
			return h('svg', {
				width: 9,
				height: 9,
				viewBox: '0 0 16 16',
				'aria-hidden': true,
				focusable: false
			}, h('path', {
				d: up ? 'M3.5 10.5 8 6l4.5 4.5' : 'M3.5 5.5 8 10l4.5-4.5',
				fill: 'none',
				stroke: 'currentColor',
				strokeWidth: 2,
				strokeLinecap: 'round',
				strokeLinejoin: 'round'
			}));
		}

		/** 一个数字步进器：`[ 1180 ▲▼ ] px`；`label` 只用于两个箭头的无障碍名。 */
		function Stepper({ t, axis, label, value, onChange }) {
			const limit = LIMITS[axis];
			const arrow = (up, disabled) => h('button', {
				key: up ? 'up' : 'down',
				type: 'button',
				className: 'dspro_arrow',
				disabled,
				'aria-label': (up ? t('increase') : t('decrease')) + ' ' + label,
				onClick: () => {
					onChange(clamp(axis, value + (up ? STEP : -STEP)));
				}
			}, h(Chevron, { up }));
			return h('span', { className: 'dspro_control' }, [
				h('span', { key: 'stepper', className: 'dspro_stepper' }, [
					h('span', { key: 'value', className: 'dspro_value' }, String(value)),
					h('span', { key: 'arrows', className: 'dspro_arrows' }, [
						arrow(true, value >= limit.max),
						arrow(false, value <= limit.min)
					])
				]),
				h('span', { key: 'unit', className: 'dspro_unit' }, t('unit'))
			]);
		}

		/** 页面里的一行：标题 + 说明 + 右侧控件。尺寸三行与 Host 运维三行共用同一骨架。 */
		function panelRow(key, title, desc, control) {
			return h('div', { key, className: 'dspro_row' }, [
				h('div', { key: 'text', className: 'dspro_rowText' }, [
					h('div', { key: 'title', className: 'dspro_title' }, title),
					h('div', { key: 'desc', className: 'dspro_desc' }, desc)
				]),
				h('div', { key: 'control', className: 'dspro_control' }, control)
			]);
		}

		/** POST 一小段 JSON；拿不到 JSON 一律当失败（`status: 0`），调用方据此区分原因。 */
		async function opsPost(url, body) {
			try {
				const response = await fetch(url, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body === undefined ? {} : body)
				});
				const type = String(response.headers.get('content-type') ?? '');
				// 路由不存在时 SPA 兜底会回一份 `200 text/html`：那不是成功，否则会给出假回执。
				if (!type.includes('application/json')) return { status: 0, payload: null, missing: true };
				let payload = null;
				try {
					payload = await response.json();
				} catch (error) {
					payload = null;
				}
				return { status: response.status, payload };
			} catch (error) {
				return { status: 0, payload: null };
			}
		}

		/** 失败结果的单行说明：优先 Host 给的说明，其次失败码。 */
		function describeFailure(status, payload) {
			if (payload !== null && typeof payload.message === 'string' && payload.message !== '') return payload.message;
			if (payload !== null && typeof payload.code === 'string' && payload.code !== '') return payload.code;
			return 'HTTP ' + String(status);
		}

		/** 把毫秒时长渲染成「3 天 4 小时 / 2 小时 5 分 / 12 分 3 秒 / 8 秒」。 */
		function formatUptime(ms) {
			const total = Math.max(0, Math.floor(Number(ms) / 1000));
			const days = Math.floor(total / 86400);
			const hours = Math.floor((total % 86400) / 3600);
			const minutes = Math.floor((total % 3600) / 60);
			const seconds = total % 60;
			if (days > 0) return String(days) + ' 天 ' + String(hours) + ' 小时';
			if (hours > 0) return String(hours) + ' 小时 ' + String(minutes) + ' 分';
			if (minutes > 0) return String(minutes) + ' 分 ' + String(seconds) + ' 秒';
			return String(seconds) + ' 秒';
		}

		/** 本机时区的启动时刻；坏数据不抛错。 */
		function formatStartedAt(ms) {
			try {
				return new Date(ms).toLocaleString();
			} catch (error) {
				return String(ms);
			}
		}

		/** Host 状态的一行摘要（含最后启动时间与已运行时长）。 */
		function opsSummary(status, t) {
			if (status === null) return t('opsLoading');
			if (status.missing === true) return t('opsMissing');
			const parts = [];
			if (status.supported !== true) {
				parts.push(t('opsUnsupported'));
			} else {
				parts.push(status.busy ? t('opsBusyPrefix') + String(status.runningCount) + t('opsBusySuffix') : t('opsIdle'));
			}
			if (status.armed) {
				parts.push(status.busy
					? t('opsArmedBusyPrefix') + String(status.runningCount) + t('opsArmedBusySuffix')
					: t('opsArmedPrefix') + String(Math.round((status.quietMs ?? 0) / 1000)) + t('opsArmedSuffix'));
			}
			if (status.firedAt !== null && status.firedAt !== undefined) {
				parts.push(t('opsFiredPrefix') + String(status.transientUnit) + t('opsFiredSuffix'));
			}
			if (typeof status.startedAt === 'number') {
				parts.push(t('opsStartedPrefix') + formatStartedAt(status.startedAt)
					+ t('opsUptimePrefix') + formatUptime(status.uptimeMs) + t('opsUptimeSuffix'));
			}
			if (status.supported === true && status.unit !== undefined && status.unit !== null) {
				parts.push(t('opsUnitPrefix') + String(status.unit));
			}
			if (status.supported !== true && typeof status.reason === 'string' && status.reason !== '') {
				parts.push(t('opsReasonPrefix') + status.reason);
			}
			return parts.join(' · ');
		}

		/**
		 * 「开放给 agent」这一行的实际状态文案。
		 * 关键是**分开说**：开关（文件里的值）与已注册（模型现在看不看得到）可能不一致
		 * —— 不一致就是「没生效」，必须显式讲出来，不许抹平成一句「已开放」。
		 * @param status - `/status` 快照（可为 null / missing）。
		 * @param t - 翻译函数。
		 * @returns 一行文本。
		 */
		function agentToolsSummary(status, t) {
			if (status === null || status.missing === true) return t('agentToolsUnknown');
			const enabled = status.agentTools === true;
			const exposed = status.agentToolsExposed;
			const names = Array.isArray(status.agentToolsNames) ? status.agentToolsNames : [];
			if (exposed !== true && exposed !== false) return t('agentToolsUnknown');
			if (exposed === enabled) {
				return enabled
					? t('agentToolsOn') + '（' + String(names.length) + '）'
					: t('agentToolsOff');
			}
			return t('agentToolsSkew') + (typeof status.agentToolsError === 'string' && status.agentToolsError !== ''
				? '：' + status.agentToolsError
				: '');
		}

		/** 不一致时用错误色，正常/未知用普通说明色（未知不该吓唬人）。 */
		function agentToolsClass(status) {
			const exposed = status === null || status === undefined || status.missing === true ? null : status.agentToolsExposed;
			if (typeof exposed !== 'boolean') return 'dspro_note';
			return exposed === (status.agentTools === true) ? 'dspro_note' : 'dspro_error';
		}

		/**
		 * 「运行中」指示：挂在侧边栏**左下角** `sidebar.footer.action` 槽位（list 槽，scope root）。
		 *
		 * 2026-10-19 用户要求从左上角品牌行挪到这里。走槽位而不是 DOM 注入：
		 * 官方那个槽位就是给「脚部动作」用的（cordis 面板也占它的 `id: cordis-panel`），
		 * 由官方负责布局与 rail 折叠，我们不用自己算位置、也不会把品牌行挤变形。
		 *
		 * 两态常显（0.8.0 的语义不变）：忙 → 绿色「运行中 ×N」；闲 → 灰色「空闲」。
		 * 数据仍读 `busyStore`（Host `/status` 口径，约束 21），**没读到过就不画**。
		 * 已排程空闲重启时，文字后加一个橙色感叹号（2026-10-18 的要求）。
		 */
		/**
		 * 「运行中」那一格该长什么样。纯函数：**判据（含「未知不画」）在这里**，
		 * 组件只负责把结果变成节点 —— 这样探针能喂任意状态（包括「从没读到过」），
		 * 不必跟模块级 `busyStore` 的当前值较劲。
		 * @param state - `busyStore.get()` 或 `null`。
		 * @param t - 字典函数。
		 * @returns `null`（不画）或 `{ text, title, aria, state, armed }`。
		 */
		function describeChip(state, t) {
			if (state === null || typeof state !== 'object' || state.known !== true) return null;
			const busy = state.busy === true;
			const count = typeof state.runningCount === 'number' ? state.runningCount : 0;
			const armed = state.armed === true;
			const text = busy
				? t('runLabel') + (count > 1 ? ' ×' + String(count) : '')
				: t('runIdleLabel');
			const armedHint = armed ? '\n' + t('runArmedHover') : '';
			let title;
			if (busy) {
				const hover = runningHoverText(state.sessions);
				title = (hover === '' ? text : text + '\n' + hover) + armedHint;
			} else {
				title = t('runIdleHover') + armedHint;
			}
			return {
				text,
				title,
				// 读屏拿不到悬停文本，把换行换成「；」拼进无障碍名。
				aria: title.replace(/\n/gu, '；'),
				state: busy ? 'running' : 'idle',
				armed
			};
		}

		function RunStatusChip({ t }) {
			const state = React.useSyncExternalStore(
				(listener) => busyStore.subscribe(listener),
				() => busyStore.get()
			);
			const described = describeChip(state, t);
			if (described === null) return null;
			const { text, title, aria, armed } = described;
			return h('span', {
				className: RUN_CLASS,
				'data-plugin': '@dongasai/dsh-setting-pro',
				'data-state': described.state,
				'data-armed': armed ? '1' : '0',
				role: 'img',
				// 非交互（点它不做事），所以不给 tabIndex；但读屏要能拿到含义与明细。
				'aria-label': aria,
				title
			}, [
				h('span', { key: 'dot', className: RUN_DOT_CLASS }),
				h('span', { key: 'label', className: RUN_LABEL_CLASS }, text),
				armed ? h('span', { key: 'bang', className: RUN_BANG_CLASS, 'aria-hidden': 'true' }, '!') : null
			]);
		}

		/**
		 * 把「运行中」挂到左下角 footer 槽位。
		 * 失败只记原因、不抛（约束 24：槽位回调在声明那一刻跑，异常会连累别的插件）。
		 */
		function mountRunStatus(ctx, t) {
			runStatusState.mounted = false;
			runStatusState.reason = '';
			ctx.slots.inject(FOOTER_SLOT, () => {
				try {
					ctx.slots.register({
						name: FOOTER_SLOT,
						id: RUN_ID,
						order: RUN_ORDER,
						label: () => t('runLabel'),
						locale: NS
					}, () => h(RunStatusChip, { t }));
					runStatusState.mounted = true;
					runStatusState.reason = '';
				} catch (error) {
					runStatusState.mounted = false;
					runStatusState.reason = error instanceof Error ? error.message : String(error);
				}
			});
		}

		/**
		 * 「Host 运维」块：重启 DSH / 空闲后重启 / 取消排程 + 当前状态。
		 *
		 * 三个动作都打 Host 半边的路由；忙时「立即重启」拿回 409，界面用一次
		 * `window.confirm` 做二次确认，再把 `force: true` 发过去。
		 * 发起重启时把当前 `bootId` 记进 localStorage，重连后 bootId 变了就提示「重启完成」。
		 *
		 * 状态与提示都读**共享的** `hostStatusStore`（见 `useHostStatus`）：本块与
		 * 「开放给 agent」块分属两个 tab，各自轮询会变成两份 2s 请求。
		 */
		function HostOps({ t }) {
			const { status, note, refresh } = useHostStatus();
			const [busyAction, setBusyAction] = React.useState('');
			const [failure, setFailure] = React.useState('');
			useHostStatusPolling(t);

			/** 记下这一代的 bootId：下次读到不同的 bootId 即「重启完成」。 */
			const markPending = (snapshot) => {
				try {
					if (snapshot !== null && typeof snapshot.bootId === 'string') {
						window.localStorage.setItem(PENDING_KEY, snapshot.bootId);
					}
				} catch (error) {
					/* 隐私模式：只是不提示「重启完成」 */
				}
			};

			/** 立即重启；忙时先拿 409，再二次确认带 force 重发。 */
			const restart = async (force) => {
				setBusyAction('restart');
				setFailure('');
				hostStatusStore.setNote('');
				const result = await opsPost(RESTART_URL, force ? { force: true } : {});
				setBusyAction('');
				if (result.status === 0) {
					setFailure(result.missing === true ? t('opsMissing') : t('opsTransport'));
					return;
				}
				if (result.status === 409) {
					const payload = result.payload;
					const count = payload !== null && typeof payload.runningCount === 'number'
						? payload.runningCount
						: (payload !== null && Array.isArray(payload.running) ? payload.running.length : 0);
					if (window.confirm(t('busyConfirmPrefix') + String(count) + t('busyConfirmSuffix'))) await restart(true);
					return;
				}
				if (result.status >= 400) {
					setFailure(t('opsErrorPrefix') + describeFailure(result.status, result.payload));
					return;
				}
				markPending(status);
				hostStatusStore.setNote(t('opsFired'));
				void refresh();
			};

			/**
			 * 空闲后重启 / 取消排程共用的简单动作。
			 * 排程重复点击是幂等的（Host 侧不会因为再点一次把 10 秒静默窗清零）。
			 */
			const simple = async (action, url, okKey) => {
				setBusyAction(action);
				setFailure('');
				hostStatusStore.setNote('');
				const result = await opsPost(url, {});
				setBusyAction('');
				if (result.status === 0) {
					setFailure(result.missing === true ? t('opsMissing') : t('opsTransport'));
					return;
				}
				if (result.status >= 400) {
					setFailure(t('opsErrorPrefix') + describeFailure(result.status, result.payload));
					return;
				}
				const already = action === 'schedule' && result.payload !== null && result.payload.already === true;
				hostStatusStore.setNote(already ? t('opsScheduledAlready') : t(okKey));
				void refresh();
			};

			const armed = status !== null && status.armed === true;
			const working = busyAction !== '';
			return h('div', { className: 'dspro_group' }, [
				h('h3', { key: 'heading', className: 'dspro_subheading' }, t('opsHeading')),
				h('p', { key: 'intro', className: 'dspro_intro' }, t('opsIntro')),
				h('div', { key: 'rows', className: 'dspro_rows' }, [
					panelRow('restart', t('restartTitle'), t('restartDesc'), h('button', {
						key: 'action',
						type: 'button',
						className: 'dspro_action',
						disabled: working,
						onClick: () => {
							void restart(false);
						}
					}, busyAction === 'restart' ? t('opsWorking') : t('restartAction'))),
					panelRow('schedule', t('scheduleTitle'), t('scheduleDesc'), h('button', {
						key: 'action',
						type: 'button',
						className: 'dspro_action',
						disabled: working,
						onClick: () => {
							void simple('schedule', SCHEDULE_URL, 'opsScheduled');
						}
					}, armed ? t('scheduleArmed') : (busyAction === 'schedule' ? t('opsWorking') : t('scheduleAction')))),
					panelRow('cancel', t('cancelTitle'), t('cancelDesc'), h('button', {
						key: 'action',
						type: 'button',
						className: 'dspro_action',
						disabled: !armed || working,
						onClick: () => {
							void simple('cancel', CANCEL_URL, 'opsCanceled');
						}
					}, busyAction === 'cancel' ? t('opsWorking') : t('cancelAction')))
				]),
				h('p', { key: 'status', className: 'dspro_note' }, opsSummary(status, t)),
				failure === '' ? null : h('p', { key: 'failure', className: 'dspro_error' }, failure),
				note === '' ? null : h('p', { key: 'note', className: 'dspro_note' }, note)
			]);
		}

		/**
		 * 「开放给 agent」块：模型能不能看到那三个重启工具。
		 *
		 * 单独一个 tab，不塞进「Host 运维」：那一组是**人点的按钮**，这一组管的是
		 * **模型能看到什么**，读者不一样。数据读共享的 `/status`（`agentTools` 是开关值、
		 * `agentToolsExposed` 是实际注册状态），不额外发请求。
		 */
		function AgentToolsBlock({ t }) {
			const { status, note, refresh } = useHostStatus();
			const [busy, setBusy] = React.useState(false);
			const [failure, setFailure] = React.useState('');
			useHostStatusPolling(t);

			/**
			 * 切换开关。POST 完**立刻重读 /status**：界面显示的是 Host 报回来的实际注册
			 * 状态，而不是我们刚发过去的那个布尔。
			 */
			const setAgentTools = async (enabled) => {
				setBusy(true);
				setFailure('');
				hostStatusStore.setNote('');
				const result = await opsPost(AGENT_TOOLS_URL, { enabled });
				setBusy(false);
				if (result.status === 0) {
					setFailure(result.missing === true ? t('opsMissing') : t('opsTransport'));
					return;
				}
				if (result.status >= 400) {
					setFailure(t('opsErrorPrefix') + describeFailure(result.status, result.payload));
					void refresh();
					return;
				}
				hostStatusStore.setNote(enabled === true ? t('agentToolsOpened') : t('agentToolsClosed'));
				void refresh();
			};

			return h('div', { className: 'dspro_group' }, [
				h('h3', { key: 'heading', className: 'dspro_subheading' }, t('agentHeading')),
				h('p', { key: 'intro', className: 'dspro_intro' }, t('agentIntro')),
				h('div', { key: 'rows', className: 'dspro_rows' }, [
					panelRow('agentTools', t('agentToolsTitle'), t('agentToolsDesc'), h('input', {
						type: 'checkbox',
						className: 'dspro_checkbox',
						checked: status !== null && status.agentTools === true,
						disabled: busy,
						'aria-label': t('agentToolsTitle'),
						onChange: (event) => {
							void setAgentTools(event.target.checked === true);
						}
					}))
				]),
				h('p', { key: 'agentToolsState', className: agentToolsClass(status) }, agentToolsSummary(status, t)),
				failure === '' ? null : h('p', { key: 'failure', className: 'dspro_error' }, failure),
				note === '' ? null : h('p', { key: 'note', className: 'dspro_note' }, note)
			]);
		}

		/** GET `/status`；非 JSON（Host 半边没加载）与传输失败分开表示。 */
		async function fetchStatus() {
			try {
				const response = await fetch(STATUS_URL, { headers: { accept: 'application/json' } });
				const type = String(response.headers.get('content-type') ?? '');
				if (!type.includes('application/json') || response.status === 404) return { missing: true };
				if (!response.ok) return { error: 'HTTP ' + String(response.status) };
				return { payload: await response.json() };
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error) };
			}
		}

		/**
		 * Host `/status` 的共享快照。
		 *
		 * 「Host 运维」块与「开放给 agent」块都要读它（后者要显示实际注册状态）。
		 * 各自轮询会变成两份 2s 请求，所以轮询只起一次、两块共读一份。
		 * 与 `busyStore` 同理：做成 store 而不是组件内 `useState`，探针才能直接喂状态。
		 */
		const hostStatusStore = {
			value: null,
			note: '',
			listeners: new Set(),
			get() {
				return hostStatusStore.value;
			},
			getNote() {
				return hostStatusStore.note;
			},
			setNote(text) {
				hostStatusStore.note = typeof text === 'string' ? text : '';
				for (const listener of [...hostStatusStore.listeners]) listener();
			},
			set(next) {
				hostStatusStore.value = next;
				for (const listener of [...hostStatusStore.listeners]) listener();
			},
			subscribe(listener) {
				hostStatusStore.listeners.add(listener);
				return () => hostStatusStore.listeners.delete(listener);
			}
		};

		/** 轮询的共享状态（模块级，配合下面的引用计数）。 */
		const hostStatusPolling = { count: 0, timer: null, refresh: null };

		/**
		 * 起一次 `/status` 轮询（引用计数：两块都挂载也只有一份定时器）。
		 * @param t - 字典函数（用于「重启完成」那句提示）。
		 * @returns 停止轮询的函数（计数归零时才真的停）。
		 */
		function useHostStatusPolling(t) {
			const tRef = React.useRef(t);
			tRef.current = t;
			React.useEffect(() => {
				const refresh = async () => {
					const result = await fetchStatus();
					if (result.missing === true) {
						hostStatusStore.set({ missing: true, supported: false, armed: false });
						return null;
					}
					if (result.payload === undefined) return null;
					hostStatusStore.set(result.payload);
					return result.payload;
				};
				hostStatusPolling.refresh = refresh;
				hostStatusPolling.count += 1;
				if (hostStatusPolling.timer === null) {
					const tick = async () => {
						const snapshot = await refresh();
						if (snapshot === null) return;
						try {
							const pending = window.localStorage.getItem(PENDING_KEY);
							if (pending !== null && pending !== '' && pending !== snapshot.bootId) {
								window.localStorage.removeItem(PENDING_KEY);
								hostStatusStore.setNote(tRef.current('opsDone'));
							}
						} catch (error) {
							/* 隐私模式：只是不提示「重启完成」 */
						}
					};
					void tick();
					hostStatusPolling.timer = window.setInterval(tick, OPS_POLL_MS);
				}
				return () => {
					hostStatusPolling.count -= 1;
					if (hostStatusPolling.count > 0) return;
					if (hostStatusPolling.timer !== null) {
						window.clearInterval(hostStatusPolling.timer);
						hostStatusPolling.timer = null;
					}
					hostStatusPolling.refresh = null;
				};
			}, []);
		}

		/** 读共享快照；POST 完调用返回值里的 refresh 立刻重读（显示 Host 报回来的真实状态）。 */
		function useHostStatus() {
			const snapshot = React.useSyncExternalStore(
				(listener) => hostStatusStore.subscribe(listener),
				() => hostStatusStore.get()
			);
			return {
				status: snapshot === undefined ? null : snapshot,
				note: hostStatusStore.getNote(),
				refresh: async () => (hostStatusPolling.refresh === null ? null : hostStatusPolling.refresh())
			};
		}

		/** GET 版本状态；非 JSON（Host 半边没加载）与传输失败分开表示。 */
		async function fetchVersion(refresh, channel) {
			try {
				const params = new URLSearchParams();
				if (refresh === true) params.set('refresh', '1');
				if (typeof channel === 'string' && channel !== '' && channel !== CHANNEL_DEFAULT) {
					params.set('channel', channel);
				}
				const query = params.toString();
				const response = await fetch(VERSION_URL + (query === '' ? '' : '?' + query), {
					headers: { accept: 'application/json' }
				});
				const type = String(response.headers.get('content-type') ?? '');
				if (!type.includes('application/json')) return { missing: true };
				if (!response.ok) return { error: 'HTTP ' + String(response.status) };
				return { payload: await response.json() };
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error) };
			}
		}

		/**
		 * 版本状态的共享 store：设置页的「DSH 版本」块与 logo 上的更新箭头**读同一份**。
		 *
		 * 为什么不能只放在 VersionBlock 里：那个组件只在「设置 → 高级设置」打开时挂载，
		 * 而用户要的是**logo 处常驻**的箭头 —— 不开设置页也得知道有没有新版本。
		 * 所以轮询在 apply() 里起一次，两块都只是订阅者。
		 */
		const versionStore = {
			payload: null,
			problem: '',
			channel: CHANNEL_DEFAULT,
			listeners: new Set(),
			get() {
				return versionStore.payload;
			},
			getProblem() {
				return versionStore.problem;
			},
			getChannel() {
				return versionStore.channel;
			},
			/** 换通道：立刻按新通道重读（Host 侧结论现算，不打 registry）。 */
			setChannel(next) {
				const channel = typeof next === 'string' && next.trim() !== '' ? next.trim() : CHANNEL_DEFAULT;
				if (channel === versionStore.channel) return;
				versionStore.channel = channel;
				try {
					window.localStorage.setItem(CHANNEL_KEY, channel);
				} catch (error) {
					/* 存不下也要当场切换：只是下次进页面回到默认通道 */
				}
				void versionStore.refresh(false);
			},
			initChannel() {
				let saved = null;
				try {
					saved = window.localStorage.getItem(CHANNEL_KEY);
				} catch (error) {
					saved = null;
				}
				// 坏值 / 没存过 → 默认通道，不猜。
				versionStore.channel = typeof saved === 'string' && saved.trim() !== '' ? saved.trim() : CHANNEL_DEFAULT;
				return versionStore.channel;
			},
			/** 拉一次；`refresh` 为真时让 Host 强制重查 registry。 */
			async refresh(refresh) {
				const result = await fetchVersion(refresh === true, versionStore.channel);
				if (result.missing === true) {
					versionStore.payload = { missing: true };
					versionStore.problem = '';
				} else if (typeof result.error === 'string') {
					// 传输失败：保留上一次的结果，只记错误（一次抖动不该把「有新版本」抹成「不知道」）。
					versionStore.problem = result.error;
				} else {
					versionStore.payload = result.payload;
					versionStore.problem = '';
				}
				for (const listener of [...versionStore.listeners]) listener();
			},
			subscribe(listener) {
				versionStore.listeners.add(listener);
				return () => versionStore.listeners.delete(listener);
			}
		};
		versionStore.initChannel();

		/**
		 * 是否该在 logo 上标「有更新」：Host 报了新版本，且**当前版本读到了**。
		 *
		 * `current` 为 null 时（没找到 dsh 的 package.json）绝不标 —— 拿不到基准就没资格说
		 * 「有更新」；那正是 2026-10-18 那个 bug 的形态（把 nvs 的 1.7.1 当 dsh 版本，
		 * 于是永远「已是最新」，反过来也成立：基准不可信时任何结论都不可信）。
		 * @param payload - versionStore 的载荷。
		 * @returns 有可更新版本时返回 `{ version, tag }`，否则 null。
		 */
		function updateAvailable(payload) {
			if (payload === null || typeof payload !== 'object' || payload.missing === true) return null;
			if (payload.current === null || payload.current === undefined || payload.current === '') return null;
			const newer = payload.newer;
			if (newer === null || typeof newer !== 'object') return null;
			if (typeof newer.version !== 'string' || newer.version === '') return null;
			return { version: newer.version, tag: typeof newer.tag === 'string' ? newer.tag : '' };
		}

		/** 起一次版本轮询（apply 里调用；设置页不再自己查）。 */
		function startVersionSource() {
			let timer = null;
			let disposed = false;
			const tick = async () => {
				if (disposed) return;
				await versionStore.refresh(false);
			};
			timer = window.setInterval(() => {
				void tick();
			}, VERSION_POLL_MS);
			void tick();
			return {
				dispose() {
					disposed = true;
					if (timer !== null) window.clearInterval(timer);
				}
			};
		}

		/** 各通道一行：`latest 0.2.0-rc.2 · alpha 0.2.1-alpha.5`。 */
		function formatTags(tags) {
			if (!Array.isArray(tags) || tags.length === 0) return '';
			return tags.map((entry) => String(entry.tag) + ' ' + String(entry.version)).join(' · ');
		}

		/**
		 * 「DSH 版本」块：打开页面时查一次 npm dist-tags 并显示当前/最新版本，
		 * 有更新给一行提醒（warn 色）。检查结果在 Host 侧缓存 6 小时，按钮可强制重查。
		 */
		function VersionBlock({ t }) {
			// 读共享的 versionStore（logo 上的箭头是同一份）：本块不再自己轮询，
			// 也不再在挂载时查一次 —— 否则「打开设置页」和「看 logo」会给出两个结论。
			const info = React.useSyncExternalStore(
				(listener) => versionStore.subscribe(listener),
				() => versionStore.get()
			);
			const problem = versionStore.getProblem();
			const [checking, setChecking] = React.useState(false);

			const load = React.useCallback(async (refresh) => {
				setChecking(true);
				await versionStore.refresh(refresh);
				setChecking(false);
			}, []);

			const checkButton = h('button', {
				key: 'action',
				type: 'button',
				className: 'dspro_action',
				disabled: checking,
				onClick: () => {
					void load(true);
				}
			}, checking ? t('opsWorking') : t('checkAction'));

			if (info === null || info === undefined) {
				return h('div', { className: 'dspro_group' }, [
					h('h3', { key: 'heading', className: 'dspro_subheading' }, t('versionHeading')),
					problem === ''
						? h('p', { key: 'status', className: 'dspro_note' }, t('opsLoading'))
						: h('p', { key: 'status', className: 'dspro_error' }, t('versionCheckFailedPrefix') + problem)
				]);
			}
			if (info.missing === true) {
				return h('div', { className: 'dspro_group' }, [
					h('h3', { key: 'heading', className: 'dspro_subheading' }, t('versionHeading')),
					h('p', { key: 'status', className: 'dspro_note' }, t('opsMissing'))
				]);
			}

			const current = info.current === null || info.current === undefined ? t('versionUnknown') : String(info.current);
			const newest = info.newest === null || info.newest === undefined ? t('versionUnknown') : String(info.newest);
			const tagsLine = formatTags(info.tags);
			const rows = [
				panelRow('current', t('currentTitle'), t('currentDescPrefix') + String(info.currentSource ?? '?'), h('span', {
					key: 'readout',
					className: 'dspro_readout'
				}, current)),
				// 通道选择：auto（所有通道取最高）+ registry 里实际存在的每个 dist-tag。
				// 选项来自 `info.channels`（Host 现算），不写死 latest/next/alpha —— 将来多一条
				// beta 线也不用改这里。切换是本地操作：Host 缓存的是原始 dist-tags，结论现算。
				panelRow('channel', t('channelTitle'), t('channelDesc'), h('select', {
					key: 'control',
					className: 'dspro_select',
					'aria-label': t('channelTitle'),
					value: versionStore.getChannel(),
					onChange: (event) => {
						versionStore.setChannel(event.target.value);
					}
				}, [
					h('option', { key: 'auto', value: CHANNEL_DEFAULT }, t('channelAuto')),
					...(Array.isArray(info.channels) ? info.channels : []).map((tag) => h('option', {
						key: tag,
						value: tag
					}, tag))
				])),
				panelRow('latest', t('latestTitle'), t('latestDescPrefix') + formatStartedAt(info.checkedAt ?? Date.now()) + (tagsLine === '' ? '' : ' · ' + tagsLine), h('span', {
					key: 'control',
					className: 'dspro_control'
				}, [
					h('span', { key: 'readout', className: 'dspro_readout' }, newest === info.newest && info.newestTag !== null ? newest + ' (' + String(info.newestTag) + ')' : newest),
					checkButton
				]))
			];

			const lines = [];
			if (info.channelMissing === true) {
				// 你选的这条线根本没发布过：既不说「有新版本」也不说「已是最新」。
				lines.push(h('p', { key: 'missingchannel', className: 'dspro_notice' },
					t('channelMissingPrefix') + String(info.channelRequested ?? '?')));
			} else if (info.newer !== null && info.newer !== undefined) {
				lines.push(h('p', { key: 'newer', className: 'dspro_notice' },
					'⚠ ' + t('versionNewerLabel') + ' · ' + String(info.newer.version) + ' (' + String(info.newer.tag) + ') · '
					+ t('versionCurrentLabel') + ' ' + current + ' — ' + t('versionRestartHint')));
			} else if (info.upToDate === true) {
				lines.push(h('p', { key: 'uptodate', className: 'dspro_note' }, t('versionUpToDate')));
			} else if (info.comparable === false) {
				lines.push(h('p', { key: 'unknown', className: 'dspro_note' }, t('versionIncomparable')));
			}
			if (info.error !== null && info.error !== undefined && info.error !== '') {
				lines.push(h('p', { key: 'checkerror', className: 'dspro_error' }, t('versionCheckFailedPrefix') + String(info.error)));
			}
			if (problem !== '') {
				lines.push(h('p', { key: 'transport', className: 'dspro_error' }, t('versionCheckFailedPrefix') + problem));
			}
			lines.push(h('p', { key: 'intro', className: 'dspro_note' }, t('versionIntro')));

			return h('div', { className: 'dspro_group' }, [
				h('h3', { key: 'heading', className: 'dspro_subheading' }, t('versionHeading')),
				h('div', { key: 'rows', className: 'dspro_rows' }, rows),
				...lines
			]);
		}

		/**
		 * 「设置 → 高级设置」页：页面骨架 + 尺寸三行 + Host 运维块 + DSH 版本块。
		 * 只有 shell 传进来的 `close` 与本插件自己的 `t` 用得上，其余标准 props 忽略。
		 */
		function AdvancedSection({ t }) {
			const [size, setSize] = React.useState(readSize);
			const commit = (next) => {
				writeSize(next);
				applySize(next);
				setSize(next);
			};
			// 当前分区走 store（不是 useState）：假 React 的 useState setter 是空操作，
			// 探针就切不了 tab；useSyncExternalStore 会真的调 get，于是三个分区都能渲染出来逐个断言。
			const tab = React.useSyncExternalStore(
				(listener) => settingsTabStore.subscribe(listener),
				() => settingsTabStore.get()
			);
			// 每个块归哪个分区只有一处真相：`tabOfBlock`。渲染按它过滤，
			// 以后加块时必须显式归类（探针钉住了每个块落在哪个分区）。
			const blocks = [
				{ name: 'size', node: h('div', { key: 'rows', className: 'dspro_rows' }, [
					panelRow('width', t('widthTitle'), t('widthDesc'), h(Stepper, {
						t,
						axis: 'width',
						label: t('widthTitle'),
						value: size.width,
						onChange: (value) => {
							commit({ width: value, height: size.height });
						}
					})),
					panelRow('height', t('heightTitle'), t('heightDesc'), h(Stepper, {
						t,
						axis: 'height',
						label: t('heightTitle'),
						value: size.height,
						onChange: (value) => {
							commit({ width: size.width, height: value });
						}
					})),
					panelRow('reset', t('resetTitle'), t('resetDesc'), h('button', {
						type: 'button',
						className: 'dspro_action',
						onClick: () => {
							commit({ width: DEFAULTS.width, height: DEFAULTS.height });
						}
					}, t('reset')))
				]) },
				{ name: 'machineName', node: h(MachineNameBlock, { key: 'machine', t }) },
				{ name: 'modelPill', node: h(ModelPillBlock, { key: 'modelPill', t }) },
				{ name: 'ops', node: h(HostOps, { key: 'ops', t }) },
				{ name: 'version', node: h(VersionBlock, { key: 'version', t }) },
				{ name: 'agentTools', node: h(AgentToolsBlock, { key: 'agentTools', t }) }
			];
			return h('div', { className: 'dspro_section' }, [
				h('h2', { key: 'heading', className: 'dspro_heading' }, t('heading')),
				h('p', { key: 'intro', className: 'dspro_intro' }, t('intro')),
				h('div', {
					key: 'tabs',
					className: 'dspro_tabs',
					role: 'tablist',
					'aria-label': t('tabsAria')
				}, TABS.map((key) => h('button', {
					key,
					type: 'button',
					role: 'tab',
					className: 'dspro_tab',
					'aria-selected': tab === key ? 'true' : 'false',
					onClick: () => {
						settingsTabStore.set(key);
					}
				}, t(key === 'ui' ? 'tabUi' : key === 'host' ? 'tabHost' : 'tabAgent')))),
				...blocks.filter((block) => tabOfBlock(block.name) === tab).map((block) => block.node),
			]);
		}

		/** GET/POST 机器名字；非 JSON（Host 半边没加载）单独表示。 */
		async function fetchMachine(body) {
			try {
				const response = body === undefined
					? await fetch(MACHINE_URL, { headers: { accept: 'application/json' } })
					: await fetch(MACHINE_URL, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(body)
					});
				const type = String(response.headers.get('content-type') ?? '');
				if (!type.includes('application/json')) return { missing: true };
				let payload = null;
				try {
					payload = await response.json();
				} catch (error) {
					payload = null;
				}
				return { status: response.status, payload };
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error) };
			}
		}

		/**
		 * 「机器名字」行：一个输入框 + 保存/清除。
		 * 存到 Host（`$DSH_HOME/setting-pro.json`），保存后广播事件让左上角标签立刻更新。
		 */
		function MachineNameBlock({ t }) {
			const [draft, setDraft] = React.useState('');
			const [saved, setSaved] = React.useState(null);
			const [state, setState] = React.useState('loading');
			const [problem, setProblem] = React.useState('');
			const [note, setNote] = React.useState('');
			// 左上角现在长什么样：品牌区占位状态（`off`/`slot`/`dom`/`init`）由控制器写。
			const [brandMode, setBrandMode] = React.useState(machineBrandState.mode);
			const tRef = React.useRef(t);
			tRef.current = t;

			// 占位状态是异步决定的（要等侧边栏声明槽位），这里跟着刷新那一行说明。
			React.useEffect(() => {
				const timer = window.setInterval(() => {
					setBrandMode(machineBrandState.mode);
				}, 500);
				return () => window.clearInterval(timer);
			}, []);

			React.useEffect(() => {
				let alive = true;
				void (async () => {
					const result = await fetchMachine();
					if (!alive) return;
					if (result.missing === true) {
						setState('missing');
						return;
					}
					if (typeof result.error === 'string') {
						setState('failed');
						setProblem(result.error);
						return;
					}
					const name = result.payload !== null && typeof result.payload.name === 'string' ? result.payload.name : '';
					setState('ready');
					setSaved(name);
					setDraft(name);
				})();
				return () => {
					alive = false;
				};
			}, []);

			/** 保存或清除；成功后广播事件（同一页面的标签立刻跟上）。 */
			const commit = async (value) => {
				setProblem('');
				setNote('');
				setState('saving');
				const result = await fetchMachine({ name: value });
				if (result.missing === true) {
					setState('missing');
					return;
				}
				if (typeof result.error === 'string') {
					setState('ready');
					setProblem(result.error);
					return;
				}
				if (result.status >= 400 || result.payload === null || result.payload.ok !== true) {
					setState('ready');
					setProblem(result.payload !== null && typeof result.payload.message === 'string'
						? result.payload.message
						: 'HTTP ' + String(result.status));
					return;
				}
				const name = typeof result.payload.name === 'string' ? result.payload.name : '';
				setState('ready');
				setSaved(name);
				setDraft(name);
				setNote(name === '' ? t('machineCleared') : t('machineSaved'));
				try {
					window.dispatchEvent(new CustomEvent(MACHINE_EVENT, { detail: { name } }));
				} catch (error) {
					/* 老浏览器不支持 CustomEvent 构造：靠 30s 轮询兜底 */
				}
			};

			if (state === 'missing') {
				return h('div', { className: 'dspro_group' }, [
					h('h3', { key: 'heading', className: 'dspro_subheading' }, t('machineHeading')),
					h('p', { key: 'status', className: 'dspro_note' }, t('opsMissing'))
				]);
			}
			const busy = state === 'loading' || state === 'saving';
			const rows = [
				panelRow('machine', t('machineTitle'), t('machineDesc'), h('span', { key: 'control', className: 'dspro_control' }, [
					h('input', {
						key: 'input',
						type: 'text',
						className: 'dspro_input',
						value: draft,
						maxLength: 64,
						placeholder: t('machinePlaceholder'),
						disabled: state !== 'ready',
						onChange: (event) => {
							setDraft(event.target.value);
						},
						onKeyDown: (event) => {
							if (event.key === 'Enter' && state === 'ready') void commit(draft);
						}
					}),
					h('button', {
						key: 'save',
						type: 'button',
						className: 'dspro_action',
						disabled: state !== 'ready' || draft === saved,
						onClick: () => {
							void commit(draft);
						}
					}, state === 'saving' ? t('opsWorking') : t('machineSave')),
					h('button', {
						key: 'clear',
						type: 'button',
						className: 'dspro_action',
						disabled: state !== 'ready' || saved === '',
						onClick: () => {
							void commit('');
						}
					}, t('machineClear'))
				]))
			];
			const lines = [];
			if (problem !== '') lines.push(h('p', { key: 'problem', className: 'dspro_error' }, t('machineFailedPrefix') + problem));
			else if (note !== '') lines.push(h('p', { key: 'note', className: 'dspro_note' }, note));
			else if (busy) lines.push(h('p', { key: 'busy', className: 'dspro_note' }, t('opsLoading')));
			// 左上角现在是什么样：说清楚「替换成功 / 退回小字 / 官方 logo」，省得再猜。
			const brandKey = brandMode === 'slot'
				? 'machineBrandSlot'
				: brandMode === 'dom'
					? 'machineBrandDom'
					: brandMode === 'off'
						? 'machineBrandOff'
						: 'machineBrandPending';
			lines.push(h('p', {
				key: 'brand',
				className: brandMode === 'dom' ? 'dspro_error' : 'dspro_note'
			}, t(brandKey) + (brandMode === 'dom' && machineBrandState.reason !== '' ? '（' + machineBrandState.reason + '）' : '')));

			return h('div', { className: 'dspro_group' }, [
				h('h3', { key: 'heading', className: 'dspro_subheading' }, t('machineHeading')),
				h('div', { key: 'rows', className: 'dspro_rows' }, rows),
				...lines
			]);
		}

		/**
		 * 订阅机器名字的 React 钩子（组件用 `useState` + `useEffect` 跟着 store 刷新）。
		 * @returns 当前名字。
		 */
		function useMachineName() {
			const [name, setName] = React.useState(machineNameStore.get());
			React.useEffect(() => machineNameStore.subscribe(setName), []);
			return name;
		}

		/**
		 * 顶掉官方品牌标记（logo 图标）后的占位：机器名显示时**不画图标**，
		 * 让那一行只剩机器名，视觉上就是「logo 换成了机器名」。
		 * 想保留小鱼图标的话，把这里改成 `return null` 之外的渲染即可（见 README）。
		 */
		function MachineBrandMark() {
			return null;
		}

		/** 品牌区正文：机器名（大号）。 */
		function MachineBrandName() {
			const name = useMachineName();
			if (name === '') return null;
			return h('span', { className: 'dspro_brandName', title: name }, name);
		}

		/** 「显示模型信息」开关（浏览器侧偏好，两处共用同一份）。 */
		function useModelPillEnabled() {
			const [enabled, setEnabled] = React.useState(modelPillStore.get());
			React.useEffect(() => modelPillStore.subscribe(setEnabled), []);
			return enabled;
		}

		/**
		 * 「输入框下方那一行」块：一个开关 + 一行**真实**挂载状态。
		 * 挂载是异步的（要等对话页声明槽位），所以和机器名那块一样用 500ms 定时器刷新结论。
		 */
		function ModelPillBlock({ t }) {
			const enabled = useModelPillEnabled();
			const [mounted, setMounted] = React.useState(modelPillState.mounted);
			React.useEffect(() => {
				const timer = window.setInterval(() => {
					setMounted(modelPillState.mounted);
				}, 500);
				return () => window.clearInterval(timer);
			}, []);
			const status = modelPillState.reason !== ''
				? t('modelPillFailedPrefix') + modelPillState.reason
				: mounted === true ? t('modelPillMounted') : t('modelPillPending');
			return h('div', { className: 'dspro_group' }, [
				h('h3', { key: 'heading', className: 'dspro_subheading' }, t('modelGroupTitle')),
				h('p', { key: 'intro', className: 'dspro_intro' }, t('modelGroupIntro')),
				h('div', { key: 'rows', className: 'dspro_rows' }, [
					panelRow('modelPill', t('modelPillShow'), t('modelPillShowDesc'), h('input', {
						type: 'checkbox',
						className: 'dspro_checkbox',
						checked: enabled,
						'aria-label': t('modelPillShow'),
						onChange: (event) => {
							modelPillStore.set(event.target.checked === true);
						}
					}))
				]),
				h('p', { key: 'status', className: modelPillState.reason !== '' ? 'dspro_error' : 'dspro_note' }, status)
			]);
		}

		/**
		 * 「性能与用量」那一行里我们自己的那格：`供应商 · 模型 · 思考档位`。
		 *
		 * 只读、不点：官方那个下拉（`conversation.input.model`，single 槽）是唯一的改模型入口，
		 * 顶掉它风险大、收益小（用户要的是「多显示」，不是「换一个选择器」）。
		 *
		 * 数据两条路，优先 ①：
		 *   ① `ctx.get('modelDirectories')` —— 官方模型目录服务（与 ModelSelect **同一个** per-session
		 *      directory，因此名字与档位和那个下拉里看到的完全一致）。可选读：服务不在就返回
		 *      undefined，不报错。**这个服务由另一个插件的 apply 挂上，可能晚于我们**，所以不在挂载时
		 *      一次性解析，而是每次渲染试一次、没中就按 `MODEL_RETRY_STEPS` 退避重试（试完就放弃，
		 *      不做一个永远轮询官方面向内部服务的循环）。
		 *   ② 会话投影 `useProjection('modelSelection')` —— 只有 provider/model/effort 的**内部 id**，
		 *      没有中文名；退到这条路时显示 `id`，悬停说明「这里显示的是内部 id」。
		 *
		 * 拿不到（没选过模型、目录空）就**不画**，绝不画个「未知」占位 —— 那一行是官方的，
		 * 多一格没信息的东西比少一格更糟。
		 */
		function ModelUsagePill({ t, useProjection, resolveModel }) {
			const enabled = useModelPillEnabled();
			const [attempt, setAttempt] = React.useState(0);
			// 幂等：命中缓存就直接返回；没命中就再试一次（服务可能比我们晚装配）。
			const modelStore = resolveModel();
			// 与官方 ModelSelect 同一对 subscribe/getSnapshot（那份 store 是 uSES-safe 的）。
			// 用 useSyncExternalStore 而不是「useEffect 订阅 + 渲染时读快照」：后者会漏掉
			// 「渲染之后、订阅之前」那一次通知，目录晚到一格就可能长时间显示旧值。
			// 订阅/快照函数用 useCallback 钉住身份：官方 ModelSelect 是每次渲染新建箭头（那边 store
			// 身份稳定，无害），但我们前几渲染 modelStore 是 null，每次新建会白做退订/重订。
			const subscribeStore = React.useCallback(
				(listener) => (modelStore !== null && typeof modelStore.subscribe === 'function'
					? modelStore.subscribe(listener)
					: () => {}),
				[modelStore]
			);
			const readStore = React.useCallback(
				() => (modelStore !== null && typeof modelStore.getSnapshot === 'function' ? modelStore.getSnapshot() : null),
				[modelStore]
			);
			const state = React.useSyncExternalStore(subscribeStore, readStore, () => null);
			React.useEffect(() => {
				if (modelStore !== null || attempt >= MODEL_RETRY_STEPS.length) return () => {};
				const timer = window.setTimeout(() => {
					setAttempt((value) => value + 1);
				}, MODEL_RETRY_STEPS[attempt]);
				return () => window.clearTimeout(timer);
			}, [modelStore === null, attempt]);
			const projected = typeof useProjection === 'function' ? useProjection('modelSelection') : undefined;
			if (enabled !== true) return null;
			const names = {
				// 官方对 deepseek-account 这一组也是这么处理的（`provider.account` 那份字典）；
				// 我们自己的命名空间，抄的是同一条判据。
				provider: (id, catalogName) => (id === 'deepseek-account' ? t('pillProviderAccount') : catalogName),
				effortDefault: () => t('pillEffortDefault'),
				providerLine: () => t('pillProvider'),
				modelLine: () => t('pillModel'),
				effortLine: () => t('pillEffort'),
				valueSep: () => t('pillValueSep'),
				sourceRaw: () => t('pillSourceRaw'),
				noEffort: () => t('pillNoEffort')
			};
			const described = describeModelState(
				state,
				selectionOfProjection(projected === undefined ? null : projected),
				names
			);
			if (described === null) return null;
			const children = [];
			for (const [index, segment] of described.segments.entries()) {
				if (index > 0) children.push(h('span', { key: 'sep' + String(index), className: MODEL_SEP_CLASS, 'aria-hidden': true }, '·'));
				children.push(h('span', {
					key: 'seg' + String(index),
					className: segment.tone === 'strong' ? MODEL_SEG_CLASS + ' ' + MODEL_MODEL_CLASS : MODEL_SEG_CLASS
				}, segment.text));
			}
			const visible = described.segments.map((segment) => segment.text).join(' · ');
			return h('div', {
				className: MODEL_CLASS,
				'data-dspro-model-pill': true,
				title: described.hover,
				// 悬停明细读屏拿不到，所以把「看得见的部分」写成确定的无障碍名。
				// role=img（不是 role=status）：后者是 aria-live，模型一切换就朗读一遍，太吵；
				// 这里只是常驻状态。不给 tabIndex：这不是可点的控件（改模型仍是官方那个下拉）。
				role: 'img',
				'aria-label': t('pillAriaPrefix') + visible
			}, [
				h(ModelGlyph, { key: 'glyph' }),
				h('span', { key: 'label', className: MODEL_LABEL_CLASS }, children)
			]);
		}

		/** 自绘小图标（数据库柱状，和官方用量那条同形）：不引官方 primitives 包。 */
		function ModelGlyph() {
			return h('svg', {
				width: 14,
				height: 14,
				viewBox: '0 0 16 16',
				fill: 'none',
				'aria-hidden': true,
				focusable: false
			}, [
				h('ellipse', { key: 'a', cx: 8, cy: 4, rx: 6, ry: 2.6, stroke: 'currentColor', strokeWidth: 1.2 }),
				h('path', { key: 'b', d: 'M2 4v8c0 1.4 2.7 2.6 6 2.6s6-1.2 6-2.6V4', stroke: 'currentColor', strokeWidth: 1.2, fill: 'none' }),
				h('path', { key: 'c', d: 'M2 8c0 1.4 2.7 2.6 6 2.6s6-1.2 6-2.6', stroke: 'currentColor', strokeWidth: 1.2, fill: 'none' })
			]);
		}

		/**
		 * 把那一格挂到官方那一行旁边（list 槽，用**我们自己的 id**，不碰官方那两条）。
		 *
		 * `directoryFor(sessionId)` 会**抛**（session 还没装配 / 未知 id），所以每次渲染都在
		 * try 里取；取不到就走投影那条退路。
		 * @param ctx - 客户端插件 ctx（需要 `get`）。
		 * @param t - 本插件命名空间的翻译函数。
		 */
		/**
		 * 解析这个会话的模型目录 store（幂等 + 缓存）。
		 *
		 * 单独抽出来是因为 `inject` 面**每个会话只算一次并被缓存**，而服务可能晚于我们装配：
		 * 所以这里返回一个函数，让组件自己按退避序列重复调用；命中一次就永久缓存。
		 * @param ctx - 插件 ctx。
		 * @param sessionId - 这个格子所属会话。
		 * @returns `() => store | null`。
		 */
		function createModelStoreResolver(ctx, sessionId) {
			let cached;
			let hit = false;
			return () => {
				if (hit) return cached;
				try {
					const resolver = typeof ctx.get === 'function' ? ctx.get('modelDirectories') : undefined;
					// 官方那份是 `directory.store`（不是 directory 本身）；directoryFor 会抛
					// （session 未装配 / 未知 id），所以整段在 try 里，取不到就走投影退路。
					const directory = resolver !== null && resolver !== undefined && typeof resolver.directoryFor === 'function'
						? resolver.directoryFor(sessionId)
						: undefined;
					if (directory !== null && directory !== undefined && directory.store !== null && typeof directory.store === 'object') {
						cached = directory.store;
						hit = true;
						if (typeof directory.load === 'function') {
							// 与官方 ModelSelect 同：确保目录已加载，不 await、失败自吞（加载失败时
							// store 的快照会带 error，我们那条退路照样能显示内部 id）。
							directory.load().catch(() => {});
						}
						return cached;
					}
				} catch (error) {
					/* 服务还没挂上 / 这个会话还没装配：留给退避重试 */
				}
				return null;
			};
		}

		function mountModelPill(ctx, t) {
			modelPillState.mounted = false;
			modelPillState.reason = '';
			ctx.slots.inject(DOCK_SLOT, () => {
				// ⚠️ try 必须在这一层（回调内部），不能只放在 apply 外面：这个回调跑在槽位
				// **被声明的那一刻**，而官方 `notifyDeclaration`/`flush` 是裸循环、不隔离异常 ——
				// 从这里抛出去会连累同一次声明里其它插件的注册（页面可能整块挂不上）。
				try {
					ctx.slots.register({
						name: DOCK_SLOT,
						id: DOCK_ID,
						order: DOCK_ORDER,
						label: () => t('pillModel'),
						locale: NS,
						// list 槽 scope=session：注入函数收到 sessionId（与官方 ModelSelect 的 inject 同款）。
						inject: (sessionId) => ({ resolveModel: createModelStoreResolver(ctx, sessionId) })
					}, (props) => h(ModelUsagePill, {
						t: t,
						useProjection: props.useProjection,
						resolveModel: props.resolveModel
					}));
					modelPillState.mounted = true;
					modelPillState.reason = '';
				} catch (error) {
					modelPillState.mounted = false;
					modelPillState.reason = error instanceof Error ? error.message : String(error);
				}
			});
		}

		/**
		 * 用官方槽位把品牌区换成机器名（`priority: -1` 顶掉官方占用者）。
		 *
		 * 只在**有名字**时占位：没名字就把占位撤掉，官方 logo 自动回来 —— 所以我们不做「静态占位 +
		 * 空名字渲染 null」那种写法（那会把 logo 弄没）。
		 * 槽位还没被声明时 `register` 会抛（`slot … is not declared`），所以用
		 * `ctx.slots.inject` 等它声明；万一连占位都失败，就退回 DOM 小字（`mode: 'dom'`）。
		 * @param ctx - 客户端上下文。
		 * @returns `{ dispose }`。
		 */
		function startBrandReplacement(ctx) {
			let disposers = [];
			let injected = null;
			let unsubscribe = null;

			const release = () => {
				for (const dispose of disposers) {
					try {
						dispose();
					} catch (error) {
						/* 卸载期的清理失败不影响别的 */
					}
				}
				disposers = [];
			};

			const sync = (name) => {
				if (name === '') {
					release();
					machineBrandState.mode = 'off';
					machineBrandState.reason = '';
					return;
				}
				if (disposers.length > 0) {
					machineBrandState.mode = 'slot';
					return;
				}
				if (injected === null) return; // 槽位还没声明：等 inject 回调
				try {
					disposers.push(ctx.slots.register({ name: 'sidebar.brand.mark', priority: BRAND_PRIORITY }, MachineBrandMark));
					disposers.push(ctx.slots.register({ name: 'sidebar.brand.name', priority: BRAND_PRIORITY }, MachineBrandName));
					machineBrandState.mode = 'slot';
					machineBrandState.reason = '';
				} catch (error) {
					release();
					machineBrandState.mode = 'dom';
					machineBrandState.reason = error instanceof Error ? error.message : String(error);
				}
			};

			// 等两个槽位都被声明（官方侧边栏挂上之后）再决定占位。
			injected = ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.inject('sidebar.brand.name', () => {
				// 槽位可能被重新声明（侧边栏重挂）：旧占位此时已失效，先清掉再重新占，
				// 否则 disposers 非空会让 sync 误以为「还占着」，名字就不再出现。
				release();
				unsubscribe = machineNameStore.subscribe(sync);
				sync(machineNameStore.get());
				return () => {
					if (unsubscribe !== null) unsubscribe();
					unsubscribe = null;
					release();
				};
			}));

			return {
				dispose() {
					if (unsubscribe !== null) unsubscribe();
					release();
					if (typeof injected === 'function') injected();
					injected = null;
				}
			};
		}

		/**
		 * 「有没有会话在跑」的来源：每 `RUN_POLL_MS` 读一次 `/status` 写进 `busyStore`。
		 * 读不到（Host 半边没加载 / 网络抖动）时**保持上一次结论**，不让指示闪来闪去。
		 * @returns `{ dispose }`。
		 */
		function startBusySource() {
			let timer = null;
			let disposed = false;

			const read = async () => {
				const result = await fetchStatus();
				if (disposed || result.payload === undefined) return;
				busyStore.set({
					busy: result.payload.busy === true,
					runningCount: typeof result.payload.runningCount === 'number' ? result.payload.runningCount : 0,
					sessions: Array.isArray(result.payload.runningSessions) ? result.payload.runningSessions : [],
					armed: result.payload.armed === true
				});
			};

			timer = window.setInterval(() => {
				void read();
			}, RUN_POLL_MS);
			void read();

			return {
				dispose() {
					disposed = true;
					if (timer !== null) window.clearInterval(timer);
				}
			};
		}

		/**
		 * 机器名字的来源：进页面读一次、30s 轮询、同页面保存走自定义事件，全部写进 store。
		 * @returns `{ dispose }`。
		 */
		function startMachineNameSource() {
			let pollTimer = null;
			let disposed = false;

			const read = async () => {
				const result = await fetchMachine();
				if (disposed) return;
				if (result.missing === true) return;
				if (result.payload !== null && typeof result.payload.name === 'string') machineNameStore.set(result.payload.name);
			};
			const onEvent = (event) => {
				const detail = event !== null && typeof event === 'object' ? event.detail : null;
				if (detail !== null && typeof detail === 'object' && typeof detail.name === 'string') machineNameStore.set(detail.name);
			};

			window.addEventListener(MACHINE_EVENT, onEvent);
			pollTimer = window.setInterval(() => {
				void read();
			}, MACHINE_DOM_POLL_MS);
			void read();

			return {
				dispose() {
					disposed = true;
					window.removeEventListener(MACHINE_EVENT, onEvent);
					if (pollTimer !== null) window.clearInterval(pollTimer);
				}
			};
		}

		/**
		 * 品牌行上的两件 DOM 小事（都属于「槽位做不到 / 做不到时」的补充）：
		 *
		 *   ① **机器名兜底行**：`startBrandReplacement()` 占位失败（`mode === 'dom'`）时，
		 *      在 logo 行**下面**插一行小字。
		 *   ② **「运行中」指示**：有会话在跑时，在品牌身份**后面**插一个小药丸（`● 运行中 ×2`），
		 *      位置与 orca 皮肤的信号 chip 相同（logo 后面）。
		 *
		 * 锚点用**类名后缀**：官方 CSS Modules 是 `<hash>_logoRow` / `<hash>_brandIdentity`
		 * （本机实测 `Xa_logoRow`），哈希每次构建会变、本地名稳定。再退到
		 * 「`[data-window-drag]` 里含 `[class*="_brandIdentity"]`」。
		 *
		 * ⚠️ 踩过的坑（2026-10-17 用户报「配了名字但没出现」）：早先判据里写了「不含 button」，
		 * 而 **logo 行里就有收起/展开按钮** —— 等于把目标元素自己排除，永远找不到锚点。
		 * **别再按有没有 button 筛。**
		 *
		 * 侧边栏折叠成 rail 时品牌身份不渲染，两样都不显示（与官方一致）；展开后自动回来。
		 * React 重渲染会清掉我们的节点，所以用 MutationObserver + 30s 轮询重新对齐；
		 * 文本一律 `textContent`（用户输入不进 HTML）。
		 * @param t - 本插件的字典函数（运行指示的文案）。
		 * @returns `{ dispose }`。
		 */
		function startBrandExtras(t) {
			let nameNode = null;
			let updateNode = null;
			let observer = null;
			let domTimer = null;
			let syncTimer = null;
			const unsubscribes = [];

			/** 找 logo 行；顺带判断当前是不是宽屏（品牌身份在不在）。 */
			const findBrandRow = () => {
				const byClass = document.querySelector('[class*="_logoRow"]');
				if (byClass !== null) return byClass;
				for (const row of document.querySelectorAll('[data-window-drag]')) {
					if (row.querySelector('[class*="_brandIdentity"]') !== null) return row;
					if (row.querySelector('[class*="_brandName"]') !== null) return row;
				}
				return null;
			};

			const removeName = () => {
				if (nameNode !== null) {
					nameNode.remove();
					nameNode = null;
				}
			};
			const removeUpdate = () => {
				if (updateNode !== null) {
					updateNode.remove();
					updateNode = null;
				}
			};

			/** 对齐 DOM：该有的有、该更新的更新、条件不成立的一律撤掉。 */
			const sync = () => {
				const row = findBrandRow();
				const identity = row === null ? null : row.querySelector('[class*="_brandIdentity"]');

				// ① 机器名兜底行（只在槽位占位失败、且有名字时）
				const name = machineNameStore.get();
				if (machineBrandState.mode !== 'dom' || name === '' || row === null || identity === null) {
					removeName();
					if (machineBrandState.mode === 'dom' && name !== '' && row === null) {
						machineBrandState.reason = machineBrandState.reason === '' ? 'no-anchor' : machineBrandState.reason;
					}
				} else {
					if (nameNode === null || nameNode.isConnected !== true) {
						nameNode = document.createElement('div');
						nameNode.className = MACHINE_CLASS;
						nameNode.setAttribute('data-plugin', '@dongasai/dsh-setting-pro');
					}
					if (nameNode.textContent !== name) nameNode.textContent = name;
					if (row.nextElementSibling !== nameNode) row.insertAdjacentElement('afterend', nameNode);
				}

				// ② 「有更新」箭头（向上）：挂在品牌身份之后。
				// 「运行中」指示已迁到左下角 footer 槽位（见 RunStatusChip），这里只管更新提示。
				// 判据来自共享的 versionStore —— 与设置页那块读同一份，两处不会给两个结论。
				const pending = updateAvailable(versionStore.get());
				if (pending === null || identity === null) {
					removeUpdate();
				} else {
					if (updateNode === null || updateNode.isConnected !== true) {
						updateNode = document.createElement('span');
						updateNode.className = UPDATE_CLASS;
						updateNode.setAttribute('data-plugin', '@dongasai/dsh-setting-pro');
						// 读屏不靠这个箭头（含义在 title 里），所以 aria-hidden。
						updateNode.setAttribute('aria-hidden', 'true');
						// 先建 svg 再 append（别用 firstChild 取回：假 DOM 没有这个属性，
						// 而真实 DOM 里靠 firstChild 取回也只是绕路）。
						const svg = document.createElement('svg');
						svg.setAttribute('viewBox', '0 0 16 16');
						svg.setAttribute('width', '14');
						svg.setAttribute('height', '14');
						svg.setAttribute('fill', 'none');
						const path = document.createElement('path');
						path.setAttribute('d', 'M8 13V3.5M8 3.5 3.8 7.7M8 3.5l4.2 4.2');
						path.setAttribute('stroke', 'currentColor');
						path.setAttribute('stroke-width', '1.6');
						path.setAttribute('stroke-linecap', 'round');
						path.setAttribute('stroke-linejoin', 'round');
						svg.append(path);
						updateNode.append(svg);
					}
					const channel = String(versionStore.getChannel() ?? '');
					const hover = t('updateHoverPrefix') + pending.version
						+ (pending.tag === '' ? '' : ' (' + pending.tag + ')')
						+ ' · ' + t('updateHoverChannel') + (channel === '' ? CHANNEL_DEFAULT : channel);
					updateNode.setAttribute('title', hover);
					if (identity.nextElementSibling !== updateNode) identity.insertAdjacentElement('afterend', updateNode);
				}
			};

			const scheduleSync = () => {
				if (syncTimer !== null) return;
				syncTimer = window.setTimeout(() => {
					syncTimer = null;
					sync();
				}, 120);
			};

			unsubscribes.push(machineNameStore.subscribe(scheduleSync));
			// 「运行中」已迁到左下角 footer 槽位（RunStatusChip 自己订阅 busyStore），这里不再订阅。
			// 版本结论一变（轮询回来 / 用户换通道）就重画箭头。
			unsubscribes.push(versionStore.subscribe(scheduleSync));
			// MutationObserver 在所有现代浏览器都有；真没有就只靠定时器对齐（不致命）。
			if (typeof MutationObserver === 'function') {
				observer = new MutationObserver(scheduleSync);
				observer.observe(document.body, { childList: true, subtree: true });
			}
			domTimer = window.setInterval(sync, MACHINE_DOM_POLL_MS);
			sync();

			return {
				dispose() {
					for (const off of unsubscribes) off();
					if (observer !== null) observer.disconnect();
					if (domTimer !== null) window.clearInterval(domTimer);
					if (syncTimer !== null) window.clearTimeout(syncTimer);
					removeName();
					removeUpdate();
				}
			};
		}

		const inject = ['slots', 'locale'];

		function apply(ctx) {
			ctx.effect(() => {
				const removeStyles = installStyles();
				applySize(readSize());
				return () => {
					removeStyles();
					clearSize();
				};
			}, 'setting-pro: panel geometry override');

			ctx.effect(() => ctx.locale.register(NS, DICT), 'setting-pro: dictionaries');

			// 导航行文本用 thunk：resolveSlotLabel 每次投影重读，语言切换即时跟上。
			// 这里先建 t：下面的 DOM 补充（运行指示文案）也要用。
			const t = ctx.locale.bind(NS);

			// 机器名字：来源（读一次 + 30s 轮询 + 同页面事件）→ store。
			ctx.effect(() => {
				const source = startMachineNameSource();
				return () => source.dispose();
			}, 'setting-pro: machine name source');

			// 「有没有会话在跑」：5s 轮询 /status → busyStore（品牌行上的运行指示用）。
			ctx.effect(() => {
				const source = startBusySource();
				return () => source.dispose();
			}, 'setting-pro: busy source');

			// 版本与更新通道：轮询 /version → versionStore（设置页那块与 logo 上的箭头读同一份）。
			// 必须在 apply 里起，不能只挂在 VersionBlock 上 —— 那个组件只在打开设置页时挂载，
			// 而用户要的是 logo 处**常驻**的更新箭头。
			ctx.effect(() => {
				const source = startVersionSource();
				return () => source.dispose();
			}, 'setting-pro: dsh version source');

			// 品牌区占位（priority: -1 顶掉官方 logo）；失败则退回 DOM 小字。
			ctx.effect(() => {
				const brand = startBrandReplacement(ctx);
				return () => brand.dispose();
			}, 'setting-pro: brand replaced by the machine name');

			// 品牌行上的 DOM 补充：机器名兜底行 + 「运行中」指示。
			ctx.effect(() => {
				const extras = startBrandExtras(t);
				return () => extras.dispose();
			}, 'setting-pro: brand row extras (name fallback + update arrow)');

			// 「运行中」指示：左下角 footer 槽位（2026-10-19 从品牌行迁来）。
			// 挂不上（老版本没这个槽 / 注册抛错）就什么都不画 —— 失败原因记在 runStatusState。
			try {
				mountRunStatus(ctx, t);
			} catch (error) {
				runStatusState.mounted = false;
				runStatusState.reason = error instanceof Error ? error.message : String(error);
			}

			// 「性能与用量」那一行旁边加一格：供应商 · 模型 · 思考档位（list 槽，官方两条保留）。
			// 挂不上（老版本 dsh 没这个槽 / 注册抛错）就什么都不画，设置页会说原因。
			try {
				mountModelPill(ctx, t);
			} catch (error) {
				modelPillState.mounted = false;
				modelPillState.reason = error instanceof Error ? error.message : String(error);
			}

			ctx.slots.inject('settings.section', () => ctx.slots.register({
				name: 'settings.section',
				id: 'advanced',
				order: 50,
				label: () => t('nav'),
				locale: NS
			}, AdvancedSection));
		}

		// 额外的键只是给探针用的纯函数（官方 bundle 也这么导出内部件，如 ModelDirectory）。
		// loader 只认 inject / apply，多几个键不影响装配。
		return {
			inject,
			apply,
			probe: {
				agentToolsSummary,
				agentToolsClass,
				describeChip,
				busyStore,
				settingsTabStore,
				tabOfBlock,
				versionStore,
				updateAvailable,
				UPDATE_CLASS,
				CHANNEL_KEY,
				CHANNEL_DEFAULT,
				TABS,
				describeModelState,
				selectionOfProjection,
				modelPillStore,
				modelPillState,
				MODEL_RETRY_STEPS
			}
		};
	}
});
