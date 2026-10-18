/**
 * @module @dongasai/dsh-setting-pro
 *
 * **Host 半边：重启 / 空闲后重启 dsh。**
 *
 * 全部行为都在宿主进程里，浏览器半边（`client.js`）只负责把这些入口画进
 * 「设置 → 高级设置」页。
 *
 * ## 一、为什么不能像 dshmarket 那样「自己重启自己」
 *
 * `dshmarket` 的重启是**自我重新拉起**：spawn 一个 detached helper，等端口释放后
 * 用 `dsh <同样的 argv>` 重新起一个进程，然后自己退出（`src/restart.ts`）。它在
 * systemd 下**默认关掉**这个功能，理由写在它自己的源码与文案里：
 *
 *   > Under systemd's default `KillMode=control-group`, everything in the unit's
 *   > cgroup dies with the main process — including the detached helper that was
 *   > supposed to bring the replacement up.
 *   > （`restartHintSupervised`：重启会连带杀掉 cgroup 里的接管进程，服务将起不来）
 *
 * 本机 `dsh.service` 正是 `KillMode=control-group` + `Restart=always`：detached
 * helper 仍在同一个 cgroup 里，`setsid`/`detached` 都逃不出 cgroup 回收。**所以本插件
 * 走的是另一条路**：不自己接管进程，而是把一个**游离的临时单元**（自己的 cgroup）交给
 * systemd，由它执行 `systemctl --user restart <unit>` —— 这条路在本机被验证过
 * （历史做法：临时单元 `dsh-restart-<ts>.service` 延迟执行 `systemctl --user restart dsh`）。
 *
 * 从 dshmarket 借来的是**安全骨架**，不是它的重启机制：
 *
 *   - 先确认宿主是不是由 systemd 托管，**判据是 `/proc/self/cgroup` 的叶子单元**，
 *     不是「父进程 comm 是不是 systemd」。本机 `ExecStart=npx -y @deepseek-ai/dsh web`，
 *     真正跑 dsh 的 node 进程父进程是 `npx`，照 dshmarket 那条判据会把一个正常的
 *     systemd 服务误判成「没人管」（实测 `_SYSTEMD_CGROUP=…/app.slice/dsh.service`，
 *     而 `_PID` 那个 node 的父进程是 npx）；
 *   - 判不出来 → 明确报 `unsupported-host`（并给出原因），不做猜测（宁可不做，也不制造
 *     一个「杀死了服务但起不来」的故障）；
 *   - 单元名同样从 cgroup 取，不硬编码（单元归运维所有），`DSH_SETTING_PRO_UNIT` 可覆盖。
 *
 * ## 二、为什么重启要延迟、还要等空闲
 *
 *   - **延迟 `FIRE_DELAY_SEC`**：`systemctl restart` 一到就把宿主进程停掉，HTTP 应答
 *     根本回不到浏览器；先应答、再让临时单元等几秒动手，页面才来得及画「N 秒后重启」。
 *   - **空闲后重启**：正在跑的会话（含子代理、AgentTeams 成员）会被重启打断。排程模式
 *     要求 `ctx.agents.list()` 里**没有任何 `status === 'running'` 的 agent**，并连续静默
 *     `QUIET_MS` 才开火；任何一个 agent 转 running 就把静默计时清零。排程期间可取消。
 *
 * ## 三、可用面
 *
 * | 面 | 入口 |
 * | --- | --- |
 * | GUI | 「设置 → 高级设置 → Host 运维」三行：重启 DSH / 空闲后重启 / 取消排程，外加状态行（含最后启动时间与已运行时长） |
 * | 模型 | `dsh_restart_when_idle` / `dsh_restart_status` / `dsh_restart_cancel` |
 *
 * **刻意不给模型「立即重启」工具**：那会杀掉模型自己正在跑的这一回合，没有一个回合
 * 能在自杀后回报结果。立即重启只由用户在 GUI 上点（忙时还要二次确认）。
 *
 * ## 四、硬性约束（改代码前先读）
 *
 * 1. **只 import `node:` 内建模块**。本包以 `link:` 装进 profile，裸包名
 *    `@deepseek-ai/*` 从这里解析不到；`Config` 也不要导出（需要 schemastery）。
 * 2. **必须走临时单元**（`systemd-run --user --collect`）。任何「在本进程内 spawn 一个
 *    子进程再去 restart」的写法都会被 `KillMode=control-group` 一起回收，见第一节。
 * 3. **`--on-active` 的延迟不能省**，否则应答回不去，用户只看到页面直接断。
 * 4. **不做猜测性降级**：探测不到 systemd 就报 `unsupported-host`，不要退化成自我重启。
 * 5. **排程必须实时复查**：开火前那一刻重新看一遍 `agents.list()`，繁忙就把静默窗清零。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 覆盖目标单元名的环境变量（默认从 cgroup 解析）。 */
export const UNIT_ENV = 'DSH_SETTING_PRO_UNIT';

/** `/proc/self/cgroup` 解析不出来时的兜底单元名。 */
const FALLBACK_UNIT = 'dsh';

/** 四条路由共用的前缀。 */
const PREFIX = '/setting-pro';

/** 查询状态：GET，也用于客户端等待重启回来时轮询 `bootId`。 */
export const ROUTE_STATUS = PREFIX + '/status';
/** 立即重启：POST，忙时需 `force: true`。 */
export const ROUTE_RESTART = PREFIX + '/restart';
/** 排程「空闲后重启」：POST。 */
export const ROUTE_SCHEDULE = PREFIX + '/schedule';
/** 取消排程：POST。 */
export const ROUTE_CANCEL = PREFIX + '/cancel';
/** 版本与更新检查：GET（`?refresh=1` 强制重查）。 */
export const ROUTE_VERSION = PREFIX + '/version';
/** 机器名字：GET 读、POST 写（body `{ name }`，空串＝清除）。 */
export const ROUTE_MACHINE = PREFIX + '/machine';
/** 是否把重启工具开放给 agent：GET 读、POST `{ enabled }` 写（即时生效，不用重启）。 */
export const ROUTE_AGENT_TOOLS = PREFIX + '/agent-tools';

/** 发出重启前留给 HTTP 应答与页面提示的秒数（同时是临时单元的 `--on-active`）。 */
export const FIRE_DELAY_SEC = 3;
/** 空闲判定：所有 agent 连续静默这么久才算「dsh 空闲」。 */
export const QUIET_MS = 10_000;
/** 排程模式下的复查间隔。 */
const POLL_MS = 2_000;
/** 会话标题的缓存时长：`sessionTitle.get` 每次折全量事件，悬停提示新鲜 30 秒就够。 */
export const TITLE_TTL_MS = 30_000;
/** 请求体上限（这些路由的 body 只有几个布尔，给足余量即可）。 */
const MAX_BODY_BYTES = 64 * 1024;
/** spawn 之后等一小会儿，让 `ENOENT`（没有 systemd-run）以错误形式露头，而不是静默成功。 */
const SPAWN_SETTLE_MS = 150;

/** 进程启动时刻（粗略），与 pid 一起构成 `bootId`：重启后必然变化，供客户端判断「回来了」。 */
const BOOT_EPOCH = Date.now() - Math.round(process.uptime() * 1000);

// #region 纯函数：探测与命令构造（probe.mjs 直接测这些）

/**
 * 从 `/proc/self/cgroup` 文本里解析出本进程所属的 `.service` 单元名。
 * 例：`0::/user.slice/user-1000.slice/user@1000.service/app.slice/dsh.service` → `dsh.service`。
 * 取**最后一个**叶子才是本进程自己的单元；解析不出返回 null。
 * @param text - cgroup 文件内容。
 * @returns 单元名（含 `.service`），或 null。
 */
export function parseServiceUnit(text) {
	for (const line of String(text).split('\n')) {
		const leaf = line.slice(line.lastIndexOf('/') + 1).trim();
		if (leaf.endsWith('.service')) return leaf;
	}
	return null;
}

/**
 * 读 `/proc/<pid>/comm`；读不到（非 Linux、hidepid、进程已退）返回 null。
 * @param pid - 目标进程号。
 * @returns 进程名，或 null。
 */
export function readParentComm(pid) {
	try {
		return readFileSync('/proc/' + String(pid) + '/comm', 'utf8').trim();
	} catch {
		return null;
	}
}

/**
 * 本进程是否由某个 supervisor 托管（当前只认 systemd，理由同 dshmarket：pm2/launchd
 * 没有能区分「主进程」与「后代」的第二信号，猜错会制造「起不来」的故障）。
 *
 * 两条信号缺一不可：`INVOCATION_ID` / `JOURNAL_STREAM` 会被后代继承（普通桌面终端、
 * CI runner 都有），父进程 comm 才是 `systemd` 的才算「我就是那个单元的主进程」。
 *
 * 注意：**这个函数只用于展示**（「我的父进程是不是 manager」），不是能不能重启的判据 ——
 * `ExecStart=npx -y @deepseek-ai/dsh web` 这种装法下，真正跑 dsh 的 node 进程父进程是
 * `npx`，只看父进程会把一个正常的 systemd 服务误判成「没人管」。判据见 `describeHost()`。
 * @param env - 环境变量表。
 * @param ppid - 父进程号。
 * @param comm - 读父进程 comm 的函数（测试注入用）。
 * @returns `'systemd'` 或 null。
 */
export function detectSupervisor(env = process.env, ppid = process.ppid, comm = readParentComm) {
	const marked = (env.INVOCATION_ID ?? '') !== '' || (env.JOURNAL_STREAM ?? '') !== '';
	if (!marked) return null;
	return ppid === 1 || comm(ppid) === 'systemd' ? 'systemd' : null;
}

/** 绝不重启用户管理器本身 —— 那会杀掉整个用户会话。 */
const MANAGER_UNIT_RE = /^user@\d+\.service$/u;

/**
 * 决定要重启哪个单元：环境变量覆盖 → `/proc/self/cgroup` → 兜底 `dsh`。
 * @param options - `env` 与 `cgroup` 读取函数（测试注入用）。
 * @returns `{ unit, source }`，source 为 `'env'` / `'cgroup'` / `'fallback'`。
 */
export function resolveUnit(options = {}) {
	const env = options.env ?? process.env;
	const readCgroup = options.cgroup ?? (() => readFileSync('/proc/self/cgroup', 'utf8'));
	const override = (env[UNIT_ENV] ?? '').trim();
	if (override !== '') return { unit: override, source: 'env' };
	try {
		const parsed = parseServiceUnit(readCgroup());
		if (parsed !== null) return { unit: parsed, source: 'cgroup' };
	} catch {
		/* /proc 读不到（非 Linux）：落兜底 */
	}
	return { unit: FALLBACK_UNIT, source: 'fallback' };
}

/**
 * 描述宿主：**能不能重启、重启哪个单元、依据是什么**。四条路由与三个工具共用它。
 *
 * 判据是 **cgroup 叶子**（本进程自己的事实），不是父进程 comm。实测这台机器：
 * `_SYSTEMD_CGROUP=/user.slice/user-1000.slice/user@1000.service/app.slice/dsh.service`，
 * 而真正跑 dsh 的 node 进程父进程是 `npx`（`ExecStart=npx -y @deepseek-ai/dsh web`），
 * 所以「父进程是 systemd」这条判据在这里必假、会把一个正常的 systemd 服务判成无人托管。
 *
 * 三级判据：
 *   1. `DSH_SETTING_PRO_UNIT` 显式指定 → 直接信它；
 *   2. cgroup 叶子是 `.service`、非用户管理器、且有 systemd 标记（`INVOCATION_ID`/`JOURNAL_STREAM`）→ 支持；
 *   3. 其余（叶子是 scope、读不到 /proc、管理器单元、无标记）→ 不支持，并给出原因。
 *
 * @param options - `env` 与 `cgroup` 读取函数（测试注入用）。
 * @returns `{ supported, supervisor, unit, unitSource, reason }`。
 */
export function describeHost(options = {}) {
	const env = options.env ?? process.env;
	const readCgroup = options.cgroup ?? (() => readFileSync('/proc/self/cgroup', 'utf8'));
	const override = (env[UNIT_ENV] ?? '').trim();
	const marked = (env.INVOCATION_ID ?? '') !== '' || (env.JOURNAL_STREAM ?? '') !== '';
	if (override !== '') {
		return { supported: true, supervisor: 'systemd', unit: override, unitSource: 'env', reason: UNIT_ENV + ' 指定了单元，跳过探测' };
	}
	let leaf = null;
	let readable = true;
	try {
		leaf = parseServiceUnit(readCgroup());
	} catch (error) {
		readable = false;
	}
	if (!readable) {
		return { supported: false, supervisor: marked ? 'systemd' : null, unit: FALLBACK_UNIT, unitSource: 'fallback', reason: '/proc/self/cgroup 读不到，无法确认宿主由谁托管' };
	}
	if (leaf === null) {
		return { supported: false, supervisor: marked ? 'systemd' : null, unit: FALLBACK_UNIT, unitSource: 'fallback', reason: 'cgroup 叶子不是 .service：本进程不在某个 systemd 服务里' };
	}
	if (MANAGER_UNIT_RE.test(leaf)) {
		return { supported: false, supervisor: 'systemd', unit: leaf, unitSource: 'cgroup', reason: 'cgroup 叶子是用户管理器本身，拒绝重启它' };
	}
	if (!marked) {
		return { supported: false, supervisor: 'systemd', unit: leaf, unitSource: 'cgroup', reason: '在服务 cgroup 里但缺少 systemd 标记，拒绝重启' };
	}
	return { supported: true, supervisor: 'systemd', unit: leaf, unitSource: 'cgroup', reason: '宿主是 systemd 用户服务 ' + leaf };
}

/**
 * 构造「延迟若干秒后重启目标单元」的游离临时单元命令。
 *
 * `systemd-run --user` 会让新单元落在**自己的 cgroup** 里，因此 `dsh.service` 被
 * `KillMode=control-group` 回收时它不受影响 —— 这是整条路成立的前提。
 * `--collect` 让临时单元跑完即回收，不留下 failed 的垃圾单元。
 *
 * 只构造、不执行：`status` 路由会把结果返回给界面/模型做「计划核对」，probe.mjs 也测它。
 * @param options - `unit` 目标单元、`delaySec` 延迟秒数、`now` 当前时间戳、`tag` 单元名标签。
 * @returns `{ unit, fireAt, command, args }`；`unit` 是临时单元名。
 */
export function restartUnitArgv(options = {}) {
	const unit = options.unit ?? FALLBACK_UNIT;
	const delaySec = options.delaySec ?? FIRE_DELAY_SEC;
	const now = options.now ?? Date.now();
	const tag = options.tag ?? 'setting-pro';
	const name = 'dsh-restart-' + tag + '-' + String(now);
	return {
		unit: name,
		fireAt: now + delaySec * 1000,
		command: 'systemd-run',
		args: [
			'--user',
			'--collect',
			'--unit=' + name,
			'--description=dsh restart requested by setting-pro',
			'--on-active=' + String(delaySec) + 's',
			'systemctl',
			'--user',
			'restart',
			unit
		]
	};
}

/**
 * 「空闲窗口」状态机：纯逻辑、时间可注入，`probe.mjs` 直接驱动它验证。
 * @param options - `now` 取时函数、`quietMs` 静默窗长度。
 * @returns 空闲窗口控制器。
 */
export function createIdleWatch(options = {}) {
	const now = options.now ?? (() => Date.now());
	const quietMs = options.quietMs ?? QUIET_MS;
	let armed = false;
	let quietSince = null;
	return {
		get armed() {
			return armed;
		},
		get quietSince() {
			return quietSince;
		},
		/** 排程：开始计静默。 */
		arm() {
			armed = true;
			quietSince = null;
		},
		/** 取消排程。 */
		disarm() {
			armed = false;
			quietSince = null;
		},
		/** 有活动发生：静默计时清零。 */
		reset() {
			if (armed) quietSince = null;
		},
		/** 已静默多久（毫秒）。 */
		quietMs() {
			return quietSince === null ? 0 : Math.max(0, now() - quietSince);
		},
		/**
		 * 复查一次。繁忙清零；空闲满窗返回 true（并把排程收起，由调用方开火）。
		 * @param busy - 当前是否还有 running 的 agent。
		 * @returns 是否该开火。
		 */
		poll(busy) {
			if (!armed) return false;
			if (busy) {
				quietSince = null;
				return false;
			}
			if (quietSince === null) {
				quietSince = now();
				return false;
			}
			if (now() - quietSince >= quietMs) {
				armed = false;
				return true;
			}
			return false;
		}
	};
}

// #endregion

// #region 版本与更新检查

/** 被检查的包：dsh 本体。 */
export const DSH_PACKAGE = '@deepseek-ai/dsh';
/** 覆盖「当前版本」的探针/测试开关。 */
export const DSH_VERSION_ENV = 'DSH_SETTING_PRO_DSH_VERSION';
/** 覆盖 npm registry 基址（镜像 / 测试）。 */
export const REGISTRY_ENV = 'DSH_SETTING_PRO_REGISTRY';
/** 默认 registry。 */
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
/** 注册表结果缓存时长：6 小时。 */
export const VERSION_TTL_MS = 6 * 60 * 60 * 1000;
/** 单次查询超时。 */
const VERSION_TIMEOUT_MS = 8000;
/** 从 `argv[1]` 往上找 `package.json` 的层数上限。 */
const VERSION_WALK_UP = 6;

/**
 * 解析 semver（含预发布段）；解析不出返回 null。只吃 `x.y.z[-pre][+build]`，
 * 范围、`^`、`latest` 这类标签一律不认（调用方自己判断）。
 * @param value - 版本字符串。
 * @returns `{ core: [major, minor, patch], pre: string[] }` 或 null。
 */
export function parseVersion(value) {
	if (typeof value !== 'string') return null;
	const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value.trim());
	if (match === null) return null;
	return {
		core: [Number(match[1]), Number(match[2]), Number(match[3])],
		pre: match[4] === undefined ? [] : match[4].split('.')
	};
}

/**
 * semver 比较（预发布优先规则同 semver 规范）：`a > b` 返回正数，`a < b` 返回负数，相等 0。
 * 任一版本解析不出返回 null —— 调用方据此拒绝下结论，而不是当成「相等」。
 * @param a - 左版本。
 * @param b - 右版本。
 * @returns 比较结果或 null。
 */
export function compareVersions(a, b) {
	const left = parseVersion(a);
	const right = parseVersion(b);
	if (left === null || right === null) return null;
	for (let index = 0; index < 3; index += 1) {
		if (left.core[index] !== right.core[index]) return left.core[index] - right.core[index];
	}
	// 没有预发布段的版本更大（0.2.0 > 0.2.0-rc.2）。
	if (left.pre.length === 0 || right.pre.length === 0) return right.pre.length - left.pre.length;
	for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
		const x = left.pre[index];
		const y = right.pre[index];
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		if (x === y) continue;
		const numericX = /^\d+$/u.test(x);
		const numericY = /^\d+$/u.test(y);
		if (numericX && numericY) return Number(x) - Number(y);
		if (numericX !== numericY) return numericX ? -1 : 1;
		return x < y ? -1 : 1;
	}
	return 0;
}

/**
 * 当前跑着的 dsh 是哪个版本。
 *
 * 不 import `@deepseek-ai/*`（`link:` 装法下解析不到），所以从**进程启动路径**往上找
 * `package.json`：`process.argv[1]` 是 `<…>/node_modules/@deepseek-ai/dsh/lib/bin.js`，
 * 往上两层就是 dsh 包的 manifest。
 *
 * ⚠️ 全局安装的 dsh 是靠 **bin 符号链接**启动的：`<prefix>/bin/dsh -> ../lib/node_modules/
 * @deepseek-ai/dsh/lib/bin.js`。`<prefix>/bin/` 往上走碰不到那个包，会先撞上别人的
 * package.json。所以**必须先 realpath 再往上找** —— 2026-10-18 本机实测：不 realpath 时
 * 一路走到 `~/.nvs/package.json`，把**版本管理器自己**的 `1.7.1` 当成 dsh 版本报了
 * （真实是 `0.2.0-rc.2`），和 registry 一比永远「已是最新」，等于把更新检查整个废掉。
 *
 * 找不到 dsh 包时**不拿别人的版本号冒充**：`version` 返回 `null`，只把就近那个 manifest 的
 * `source: 'nearest'` / `name` / `path` 留着当线索（界面显示「未知」并说明来源）。
 * 一个都读不到同样返回 `null`。
 * @param options - `env` / `argv1` / `exists` / `readFile` / `realpath` 注入（测试用）。
 * @returns `{ version, source, path, name }`。
 */
export function resolveDshVersion(options = {}) {
	const env = options.env ?? process.env;
	const override = (env[DSH_VERSION_ENV] ?? '').trim();
	if (override !== '') return { version: override, source: 'env', path: null, name: DSH_PACKAGE };
	const argv1 = options.argv1 ?? process.argv[1] ?? '';
	if (argv1 === '') return { version: null, source: 'none', path: null, name: null };
	const exists = options.exists ?? existsSync;
	const readFile = options.readFile ?? ((file) => readFileSync(file, 'utf8'));
	// realpath 读不动（路径不存在、没权限…）就退回原始路径：宁可少认一层，也别整个判不出来。
	const resolveLink = options.realpath ?? realpathSync;
	let dir = dirname(argv1);
	try {
		dir = dirname(resolveLink(argv1));
	} catch (error) {
		dir = dirname(argv1);
	}
	let nearest = null;
	for (let depth = 0; depth < VERSION_WALK_UP; depth += 1) {
		const candidate = join(dir, 'package.json');
		if (exists(candidate)) {
			let manifest = null;
			try {
				manifest = JSON.parse(readFile(candidate));
			} catch (error) {
				manifest = null;
			}
			if (manifest !== null && typeof manifest.version === 'string') {
				if (manifest.name === DSH_PACKAGE) {
					return { version: manifest.version, source: 'package', path: candidate, name: manifest.name };
				}
				if (nearest === null) {
					// 那是**别的项目**的 manifest：只留来源线索，version 一律 null（不冒充 dsh 版本）。
					nearest = {
						version: null,
						source: 'nearest',
						path: candidate,
						name: typeof manifest.name === 'string' ? manifest.name : null
					};
				}
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return nearest ?? { version: null, source: 'none', path: null, name: null };
}

/**
 * 把「当前版本 + registry 的 dist-tags」整理成界面/工具要的结论。
 *
 * 关键取舍（dshmarket #867 踩过的同一个坑）：**不能只看 `latest`**。当前装的是
 * `0.2.0-rc.2` 而 `latest` 也停在 `0.2.0-rc.2`，但 `alpha` 通道已经有 `0.2.1-alpha.5` ——
 * 只看 latest 会报「已是最新」，把用户所在那条线的新版本吞掉。所以这里对**所有** dist-tag
 * 取最高版本，并额外给出「当前版本所在预发布线」（`rc` → `alpha`/`beta` 同名 tag）的对照。
 * @param current - 当前版本（可为 null）。
 * @param tags - registry 的 dist-tags 对象。
 * @param channel - 用户选的通道：`'auto'`（默认，所有 tag 取最高）或具体 tag 名
 *   （`latest` / `next` / `alpha` …）。**默认必须是 auto**：0.4.0 起就是这个行为，
 *   加通道选择不该偷偷改变既有结论（同 `AGENT_TOOLS_DEFAULT` 的纪律）。
 * @returns `{ tags[], channels[], channel, channelRequested, channelMissing, newest, newestTag, newer, line, comparable }`。
 */
export function summariseVersions(current, tags, channel) {
	const entries = Object.entries(tags ?? {})
		.filter(([, version]) => typeof version === 'string' && parseVersion(version) !== null)
		.map(([tag, version]) => ({ tag, version }))
		.sort((left, right) => (compareVersions(right.version, left.version) ?? 0));
	const wanted = typeof channel === 'string' && channel.trim() !== '' ? channel.trim() : 'auto';
	// 选了具体通道就只跟那条线比；auto 才是「所有 dist-tag 取最高」。
	const picked = wanted === 'auto'
		? (entries.length > 0 ? entries[0] : null)
		: (entries.find((entry) => entry.tag === wanted) ?? null);
	// 通道不存在时**不偷偷退回 auto**：那会把「你选的这条线没有发布」说成「已是最新」。
	const channelMissing = wanted !== 'auto' && picked === null;
	const newest = picked;
	const parsedCurrent = current === null ? null : parseVersion(current);
	const comparable = newest !== null && parsedCurrent !== null;
	const diff = comparable ? compareVersions(newest.version, current) : null;
	const label = parsedCurrent !== null && parsedCurrent.pre.length > 0 ? parsedCurrent.pre[0] : null;
	const lineVersion = label === null ? undefined : (tags ?? {})[label];
	return {
		tags: entries,
		channels: entries.map((entry) => entry.tag),
		channel: channelMissing ? 'auto' : (newest === null ? wanted : newest.tag),
		channelRequested: wanted,
		channelMissing,
		newest: newest === null ? null : newest.version,
		newestTag: newest === null ? null : newest.tag,
		newer: diff !== null && diff > 0 ? { version: newest.version, tag: newest.tag } : null,
		// 通道缺失时既不是「有新版本」也不是「已是最新」，两个都不能 true。
		upToDate: diff !== null && diff <= 0,
		line: typeof lineVersion === 'string' ? { tag: label, version: lineVersion } : null,
		comparable
	};
}

/**
 * 版本检查器：进程内缓存 + 可注入 fetch/时钟，路由与探针共用同一份实现。
 * @param options - `fetchImpl` / `now` / `ttlMs` / `env` / `resolveCurrent` 注入。
 * @returns `{ get(query) }`。
 */
export function createVersionChecker(options = {}) {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const now = options.now ?? (() => Date.now());
	const ttlMs = options.ttlMs ?? VERSION_TTL_MS;
	const env = options.env ?? process.env;
	const registry = (env[REGISTRY_ENV] ?? '').trim() !== '' ? env[REGISTRY_ENV].trim() : DEFAULT_REGISTRY;
	const resolveCurrent = options.resolveCurrent ?? (() => resolveDshVersion({ env }));
	let cache = null;

	/**
	 * 查一次 dist-tags；失败不抛，把原因放进 `error`。
	 * ⚠️ 这里**只存原始 tags，不存结论**：结论按用户选的通道在 `get()` 里现算，
	 * 于是切通道是纯本地操作（不打网络、不等 6h 缓存过期）。
	 */
	async function queryTags(at) {
		const url = registry + '/-/package/' + encodeURIComponent(DSH_PACKAGE) + '/dist-tags';
		try {
			const response = await fetchImpl(url, {
				headers: { accept: 'application/json' },
				signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(VERSION_TIMEOUT_MS) : undefined
			});
			if (response.ok !== true) throw new Error('registry responded ' + String(response.status));
			const raw = await response.json();
			if (raw === null || typeof raw !== 'object') throw new Error('registry returned a non-object dist-tags payload');
			return { checkedAt: at, raw, error: null };
		} catch (error) {
			return { checkedAt: at, raw: null, error: messageOf(error) };
		}
	}

	return {
		/**
		 * 读版本状态；过期或 `refresh` 时去 registry 查一次。
		 * 查询失败时**保留上一次成功的 dist-tags**（只记 `error`），避免一次网络抖动把已有结论抹掉。
		 * @param query - `{ refresh?: boolean, channel?: string }`。
		 * @returns 版本状态载荷（结论按 `channel` 现算，默认 auto）。
		 */
		async get(query = {}) {
			const current = resolveCurrent();
			const at = now();
			const stale = cache === null || at - cache.checkedAt >= ttlMs;
			if (query.refresh === true || stale) {
				const fresh = await queryTags(at);
				if (fresh.error !== null && cache !== null && cache.raw !== null) {
					cache = { ...cache, attemptAt: at, error: fresh.error };
				} else {
					cache = fresh;
				}
			}
			return {
				package: DSH_PACKAGE,
				registry,
				ttlMs,
				current: current.version,
				currentSource: current.source,
				currentPath: current.path,
				checkedAt: cache.checkedAt,
				attemptAt: cache.attemptAt ?? cache.checkedAt,
				error: cache.error ?? null,
				...summariseVersions(current.version, cache.raw ?? {}, query.channel)
			};
		}
	};
}

// #endregion

// #region 机器名字（Host 侧持久化）

/** 本插件在 `$DSH_HOME` 下的状态文件名。 */
export const STATE_FILE = 'setting-pro.json';
/** 机器名字的最大长度（字符）。 */
export const MACHINE_NAME_MAX = 64;
/**
 * 「把重启工具开放给 agent」的缺省值。
 * 缺省 **开**：0.3.0 起这三个工具一直是注册着的，加开关不该改变既有行为。
 */
export const AGENT_TOOLS_DEFAULT = true;

/**
 * 状态文件路径：`$DSH_HOME/setting-pro.json`（`DSH_HOME` 缺省时退到 `~/.dsh`）。
 * @param options - `env` / `home` 注入（测试用）。
 * @returns 绝对路径。
 */
export function stateFilePath(options = {}) {
	const env = options.env ?? process.env;
	const home = env.DSH_HOME !== undefined && env.DSH_HOME.trim() !== ''
		? env.DSH_HOME.trim()
		: join(options.home ?? homedir(), '.dsh');
	return join(home, STATE_FILE);
}

/**
 * 清洗机器名字：控制字符换成空格、连续空白折叠、去首尾、截断到 `MACHINE_NAME_MAX`。
 * 非字符串返回 null（调用方据此回 400，而不是把 undefined 存进去）。
 * 名字最终是以 `textContent` 渲染的，这里再兜一层：**不允许**换行/控制字符，避免它在
 * 侧边栏里撑出多行或塞进奇怪字符。
 * @param value - 原始输入。
 * @returns 清洗后的名字（可能是空串＝清除），或 null。
 */
export function sanitizeMachineName(value) {
	if (typeof value !== 'string') return null;
	const cleaned = value
		.replace(/[\u0000-\u001f\u007f]+/gu, ' ')
		.replace(/\s+/gu, ' ')
		.trim();
	return cleaned.length > MACHINE_NAME_MAX ? cleaned.slice(0, MACHINE_NAME_MAX) : cleaned;
}

/**
 * 本插件状态文件的读写：进程内单例，路由与状态快照共用。
 *
 * 落在 Host 的 `$DSH_HOME/setting-pro.json`（**不是** localStorage）——「机器名字」和
 * 「重启工具是否开放给 agent」都是这台机器的属性，换浏览器、清站点数据都不该丢；
 * 写入走「临时文件 + rename」以免半个文件被读到。
 *
 * ⚠️ 一个文件里的多个键必须走**同一个** read-modify-write：两个 `write` 各自读旧值再合并，
 * 否则「存名字」会把「开关」抹掉（反过来也一样）。所以这里有 `patch({…})` 这一层，
 * 对外只是它的两个具名包装。
 * @param options - `env` / `fs` / `file` 注入（测试用）。
 * @returns `{ path, read, write, writeAgentTools, name, agentTools, error }`。
 */
export function createMachineStore(options = {}) {
	const env = options.env ?? process.env;
	const file = options.file ?? stateFilePath({ env });
	const fs = options.fs ?? { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync };
	let lastName = null;
	let lastAgentTools = null;
	let lastError = null;

	/** 读状态文件；坏数据/读不到都退回空名字 + 缺省开关，并记 `lastError`。 */
	function read() {
		try {
			if (fs.existsSync(file) !== true) {
				lastName = '';
				lastAgentTools = AGENT_TOOLS_DEFAULT;
				lastError = null;
				return { name: lastName, agentTools: lastAgentTools, path: file, error: null };
			}
			const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
			const record = parsed !== null && typeof parsed === 'object' ? parsed : {};
			const name = sanitizeMachineName(record.machineName);
			lastName = name === null ? '' : name;
			// 开关只认布尔：文件里是别的类型时按缺省处理并说明，**不**猜（「1」「true」都不算开）。
			lastAgentTools = typeof record.agentTools === 'boolean' ? record.agentTools : AGENT_TOOLS_DEFAULT;
			if (name === null && record.machineName !== undefined) {
				lastError = '状态文件里的 machineName 不是字符串，已按空名字处理';
			} else if (record.agentTools !== undefined && typeof record.agentTools !== 'boolean') {
				lastError = '状态文件里的 agentTools 不是布尔值，已按缺省（开放）处理';
			} else if (parsed === null || typeof parsed !== 'object') {
				lastError = '状态文件不是一个对象，已按空配置处理';
			} else {
				lastError = null;
			}
			return { name: lastName, agentTools: lastAgentTools, path: file, error: lastError };
		} catch (error) {
			lastError = messageOf(error);
			lastName = '';
			lastAgentTools = AGENT_TOOLS_DEFAULT;
			return { name: lastName, agentTools: lastAgentTools, path: file, error: lastError };
		}
	}

	/** 合并写：先读旧内容（坏 JSON 当空对象，不覆盖文件），再写这一份要改的那几个键。 */
	function patch(updates) {
		let existing = {};
		try {
			if (fs.existsSync(file) === true) {
				const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
				if (parsed !== null && typeof parsed === 'object') existing = parsed;
			}
		} catch (error) {
			existing = {};
		}
		try {
			fs.mkdirSync(dirname(file), { recursive: true });
			const temporary = file + '.tmp';
			fs.writeFileSync(temporary, JSON.stringify({ ...existing, ...updates }, null, 2) + '\n', 'utf8');
			fs.renameSync(temporary, file);
			lastError = null;
			if (Object.prototype.hasOwnProperty.call(updates, 'machineName')) lastName = updates.machineName;
			if (Object.prototype.hasOwnProperty.call(updates, 'agentTools')) lastAgentTools = updates.agentTools;
			return { ok: true, name: lastName ?? '', agentTools: lastAgentTools ?? AGENT_TOOLS_DEFAULT, path: file };
		} catch (error) {
			lastError = messageOf(error);
			return { ok: false, code: 'write-failed', message: lastError, path: file };
		}
	}

	/** 写机器名字（其它键照旧保留）。 */
	function write(name) {
		const cleaned = sanitizeMachineName(name);
		if (cleaned === null) return { ok: false, code: 'bad-request', message: 'name 必须是字符串' };
		return patch({ machineName: cleaned });
	}

	/** 写「重启工具是否开放给 agent」（只认布尔，其它类型一律 400，不猜）。 */
	function writeAgentTools(enabled) {
		if (typeof enabled !== 'boolean') {
			return { ok: false, code: 'bad-request', message: 'enabled 必须是布尔值（true / false）' };
		}
		return patch({ agentTools: enabled });
	}

	return {
		path: file,
		read,
		write,
		writeAgentTools,
		/** 当前开关（带进程内缓存，未读过先读一次）。 */
		agentTools() {
			return lastAgentTools ?? read().agentTools;
		},
		/** 当前名字（带进程内缓存，未读过先读一次）。 */
		name() {
			return lastName ?? read().name;
		},
		error() {
			return lastError;
		}
	};
}

// #endregion

/** 工具输出：一段可读文本。 */
function textOutput() {
	return {
		schema: { type: 'string' },
		render: (_args, value) => [{ type: 'text', text: String(value) }]
	};
}

function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 一个 agent 条目的会话 id：优先 `agent.id`（官方权威字段），退到 `agent.session.id`。
 *
 * ⚠️ `ctx.agents.list()` 的条目上**没有 `agent.sessionId`** —— 官方 `enter()` 里断言
 * `agent.id === agent.session.id`。早先用 `String(agent.sessionId)` 会让每个会话都得到
 * 字符串 `"undefined"`，标题缓存 key 全撞成一个 → 第一个会话的标题被复用到所有会话
 * （2026-10-18 用户实测：四个会话悬停都显示 `/init-architect`）。
 * 两个字段都拿不到时返回**空串**，调用方据此跳过缓存 —— 宁可多折一次标题，
 * 也不能让不同会话共用一个缓存槽。
 * @param agent - `ctx.agents.list()` 的一项。
 * @returns 会话 id，或空串。
 */
export function agentIdOf(agent) {
	const direct = agent?.id ?? agent?.session?.id;
	return typeof direct === 'string' ? direct : '';
}

/**
 * 重启控制器：进程内单例，四条路由与三个工具共用它。
 *
 * 「先应答、后动手」是刻意的：`fire()` 只负责把临时单元交给 systemd，真正的
 * `systemctl restart` 由那个单元在 `FIRE_DELAY_SEC` 秒后执行。
 * @param ctx - Host 上下文。
 * @param options - `machine` 注入状态存储（探针用假 fs，绝不碰真实文件）。
 * @returns 控制器。
 */
export function createRestartControl(ctx, options = {}) {
	const host = describeHost();
	const dsh = resolveDshVersion();
	const machine = options.machine ?? createMachineStore();
	// 工具网关的实时视图。gate 要读 machine（开关在状态文件里），所以它建在 control 之后，
	// 再由 apply() 用 attachToolGate() 把**引用**接进来 —— 接引用而不是抄字段，
	// 否则 gate 之后改 view 时状态快照还停在初始值（自己踩过）。
	let toolGate = null;
	const idleToolView = { enabled: AGENT_TOOLS_DEFAULT, exposed: false, names: [], error: null };
	const idle = createIdleWatch();
	const state = {
		firedAt: null,
		scheduledUnit: null,
		lastError: null,
		lastAction: null,
		lastReason: null
	};
	let timer = null;
	/** 会话标题缓存：sessionId → { at, title }。成本原因见 `runningSessions` 的注释。 */
	const titleCache = new Map();


	/** 仍在跑（`status === 'running'`）的会话 id。 */
	const running = () => runningSessions().map((item) => item.sessionId);

	/**
	 * 仍在跑的会话，带展示用的元信息（给界面 title 提示用）：
	 * `{ sessionId, workspace, title }`。
	 * - `workspace`：官方 `defaultWorkspaceTitle` 的算法，就是 `basename(header.cwd)`
	 *   （dshmarket 等已装插件也读这个字段；拿不到 cwd 就空着）；
	 * - `title`：`sessionTitle.get(session)` 折出来的最新标题；服务不在了 / 还没生成过
	 *   就空着——查不到写空，**不猜**。
	 * ⚠️ `sessionTitle.get()` 是 `foldSessionTitle(session.snapshotEvents())`，每次要扫全量事件；
	 * 而 `/status` 会被两路轮询反复读（设置页 2s + chip 5s）。所以标题按 sessionId 缓存
	 * `TITLE_TTL_MS`（30s）：悬停提示新鲜 30 秒足够，成本也被封顶。工作区名来自 header，很便宜，不缓存。
	 * 两段各自包 try：取标题失败不该把已经拿到的工作区一起丢掉。
	 */
	const runningSessions = () => {
		try {
			const agents = typeof ctx.agents?.list === 'function' ? ctx.agents.list() : [];
			const titles = typeof ctx.get === 'function' ? ctx.get('sessionTitle') : undefined;
			const now = Date.now();
			const items = [];
			for (const agent of agents) {
				if (agent?.status !== 'running') continue;
				// ⚠️ 真实条目上的字段是 `agent.id`（官方 enter() 里断言 `agent.id === agent.session.id`），
				// **没有 `agent.sessionId`**。早先写成 String(agent.sessionId) 会让每个会话都得到字符串
				// "undefined"：标题缓存 key 全撞成同一个 → 第一个会话的标题被复用到所有会话
				// （2026-10-18 用户实测四个会话都显示 /init-architect）。
				const sessionId = agentIdOf(agent);
				let workspace = '';
				let title = '';
				try {
					const cwd = String(agent?.session?.header?.cwd ?? '');
					if (cwd !== '') {
						const trimmed = cwd.replace(/\/+$/u, '');
						workspace = trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed;
					}
				} catch {
					/* 没有 session/header：工作区留空 */
				}
				try {
					// 没有可靠 id 就**不读也不写缓存**：宁可这次多折一次标题，
					// 也不能让多个会话共用一个缓存槽。
					const cacheable = sessionId !== '';
					const cached = cacheable ? titleCache.get(sessionId) : undefined;
					if (cached !== undefined && now - cached.at < TITLE_TTL_MS) {
						title = cached.title;
					} else {
						const snapshot = titles?.get?.(agent.session);
						title = typeof snapshot?.title === 'string' ? snapshot.title : '';
						if (cacheable) titleCache.set(sessionId, { at: now, title });
					}
				} catch {
					/* sessionTitle 不在、或 session 不是它的对象：标题留空，不猜 */
				}
				items.push({ sessionId, workspace, title });
			}
			// 清掉已经不在了的会话，别让缓存无限长。
			if (titleCache.size > items.length) {
				const live = new Set(items.map((item) => item.sessionId).filter((id) => id !== ''));
				for (const key of [...titleCache.keys()]) if (!live.has(key)) titleCache.delete(key);
			}
			return items;
		} catch (error) {
			state.lastError = messageOf(error);
			return [];
		}
	};

	const plan = () => {
		const argv = restartUnitArgv({ unit: host.unit });
		return { command: argv.command, args: argv.args, transientUnit: argv.unit };
	};

	/**
	 * 把重启交给 systemd：spawn `systemd-run` 后等一小会儿，把异步的 ENOENT 变成可见错误。
	 * @param reason - 触发来源（`immediate` / `idle`），只用于状态展示。
	 * @returns 结果。
	 */
	async function fire(reason) {
		if (!host.supported) {
			return {
				ok: false,
				code: 'unsupported-host',
				message: '宿主不支持从进程内重启（' + host.reason + '）；请在宿主机上手动重启 dsh。'
			};
		}
		state.lastError = null;
		const argv = restartUnitArgv({ unit: host.unit });
		let child;
		try {
			child = spawn(argv.command, argv.args, { detached: true, stdio: 'ignore' });
		} catch (error) {
			state.lastError = messageOf(error);
			return { ok: false, code: 'spawn-failed', message: state.lastError };
		}
		child.on('error', (error) => {
			state.lastError = messageOf(error);
		});
		child.unref();
		await sleep(SPAWN_SETTLE_MS);
		if (state.lastError !== null) {
			return { ok: false, code: 'spawn-failed', message: state.lastError };
		}
		state.firedAt = Date.now();
		state.scheduledUnit = argv.unit;
		state.lastAction = reason;
		state.lastReason = reason;
		return { ok: true, transientUnit: argv.unit, unit: host.unit, fireAt: argv.fireAt, delaySec: FIRE_DELAY_SEC };
	}

	function ensureTimer() {
		if (timer !== null) return;
		timer = setInterval(() => {
			if (!idle.armed) return;
			const ids = running();
			// 开火前那一刻重新看一遍：繁忙就把静默窗清零，不靠上一次的结论。
			if (idle.poll(ids.length > 0)) void fire('idle');
		}, POLL_MS);
		if (typeof timer.unref === 'function') timer.unref();
	}

	return {
		/** 把工具网关接进状态快照（apply 里调用一次；接的是引用，值才跟得上）。 */
		attachToolGate(gate) {
			toolGate = gate;
			return gate;
		},
		/** 当前是否把重启工具开放给 agent（状态文件里的值）。 */
		agentTools() {
			return machine.agentTools();
		},
		/**
		 * 改开关：先落状态文件，再让网关对齐一次（即时注册/注销，不用重启 dsh）。
		 * @param enabled - 布尔。
		 * @returns `{ ok, enabled, exposed, code?, message? }`。
		 */
		setAgentTools(enabled) {
			const written = machine.writeAgentTools(enabled);
			if (written.ok !== true) return written;
			if (toolGate !== null) toolGate.sync();
			return {
				ok: true,
				enabled: machine.agentTools(),
				exposed: toolGate === null ? null : toolGate.view.exposed
			};
		},
		/** 当前状态快照（路由与工具共用，字段即对外契约）。 */
		status() {
			const view = toolGate === null ? idleToolView : toolGate.view;
			const items = runningSessions();
			const ids = items.map((item) => item.sessionId);
			const now = Date.now();
			return {
				bootId: String(process.pid) + '@' + String(BOOT_EPOCH),
				pid: process.pid,
				startedAt: BOOT_EPOCH,
				uptimeMs: Math.max(0, now - BOOT_EPOCH),
				dshVersion: dsh.version,
				dshVersionSource: dsh.source,
				machineName: machine.name(),
				machineNamePath: machine.path,
				// 开关的「文件里的值」与「工具实际在不在」分开报：两者不一致就是没生效，
				// 界面必须能说清（和约束 13「不给假回执」同一条）。未挂上 gate 时按缺省报。
				agentTools: view.enabled,
				agentToolsExposed: view.exposed,
				agentToolsNames: view.names,
				agentToolsError: view.error,
				supervisor: host.supervisor,
				parentManaged: detectSupervisor() === 'systemd',
				supported: host.supported,
				unit: host.unit,
				unitSource: host.unitSource,
				reason: host.reason,
				mechanism: host.supported ? 'systemd-transient-unit' : 'unsupported',
				plan: plan(),
				delaySec: FIRE_DELAY_SEC,
				quietWindowMs: QUIET_MS,
				pollMs: POLL_MS,
				busy: ids.length > 0,
				runningCount: ids.length,
				running: ids,
				runningSessions: items,
				idle: ids.length === 0,
				armed: idle.armed,
				quietMs: idle.quietMs(),
				firedAt: state.firedAt,
				transientUnit: state.scheduledUnit,
				lastAction: state.lastAction,
				lastError: state.lastError
			};
		},

		/**
		 * 立即重启。忙时有 running 的会话且未 `force` → 拒绝，让界面走「空闲后重启」。
		 * @param options - `force` 表示用户已二次确认。
		 * @returns 结果（`code` 区分 `busy` / `unsupported-host` / `spawn-failed`）。
		 */
		async restartNow(options = {}) {
			const ids = running();
			if (ids.length > 0 && options.force !== true) {
				return { ok: false, code: 'busy', running: ids, message: '有会话正在运行；请改为「空闲后重启」，或确认强制立即重启。' };
			}
			idle.disarm();
			return await fire('immediate');
		},

		/** 排程：等所有会话空闲 `QUIET_MS` 后重启。重复调用幂等（不清零已计的静默窗）。 */
		schedule() {
			if (!host.supported) {
				return { ok: false, code: 'unsupported-host', message: '宿主不支持从进程内重启（' + host.reason + '）。' };
			}
			const ids = running();
			if (idle.armed) {
				return { ok: true, armed: true, already: true, busy: ids.length > 0, running: ids, quietMs: idle.quietMs(), quietWindowMs: QUIET_MS };
			}
			idle.arm();
			ensureTimer();
			return { ok: true, armed: true, busy: ids.length > 0, running: ids, quietWindowMs: QUIET_MS };
		},

		/** 取消排程。 */
		cancel() {
			idle.disarm();
			return { ok: true, armed: false };
		},

		/** 插件卸载时收摊：清计时器、清排程。 */
		dispose() {
			idle.disarm();
			if (timer !== null) {
				clearInterval(timer);
				timer = null;
			}
		},

		/** 给状态机用的内部挂钩（probe 不涉及）。 */
		idleWatch: idle,

		/** 机器名字的读写（路由用；与状态快照共用同一份实例）。 */
		machine
	};
}

// #region HTTP 路由

/** 信任围栏：与 dsh_editor 同款，官方 Connection 服务负责可信 Host/Origin 与浏览器认证。 */
function rejected(ctx, req, res) {
	const rejection = ctx.connection.requestRejection(req);
	if (rejection === undefined) return false;
	res.statusCode = rejection;
	res.end();
	return true;
}

function sendJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.statusCode = status;
	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.setHeader('cache-control', 'no-store');
	res.end(body);
}

/** 读 JSON 请求体（有上限）；非 JSON 或超限抛出带 `code` 的 Error。 */
function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		const type = String(req.headers['content-type'] ?? '');
		if (!type.toLowerCase().startsWith('application/json')) {
			reject(Object.assign(new Error('content-type must be application/json'), { code: 'unsupported-media-type' }));
			return;
		}
		let size = 0;
		const chunks = [];
		req.on('data', (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(Object.assign(new Error('request body too large'), { code: 'body-too-large' }));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('error', reject);
		req.on('end', () => {
			const text = Buffer.concat(chunks).toString('utf8').trim();
			if (text === '') {
				resolve({});
				return;
			}
			try {
				const parsed = JSON.parse(text);
				resolve(parsed !== null && typeof parsed === 'object' ? parsed : {});
			} catch {
				reject(Object.assign(new Error('request body is not valid JSON'), { code: 'bad-request' }));
			}
		});
	});
}

/**
 * 把一次动作的结果映射成 HTTP 应答：`busy` → 409，`unsupported-host` → 501，
 * `spawn-failed` → 500，成功 → 200（重启排程成功本就是「已接受」）。
 */
function sendActionResult(res, result) {
	if (result.ok) {
		sendJson(res, 200, result);
		return;
	}
	const status = result.code === 'busy' ? 409 : result.code === 'unsupported-host' ? 501 : 500;
	sendJson(res, status, result);
}

/** 方法闸：只放行指定方法。 */
function methodIs(req, method) {
	return req.method === method;
}

/** 把控制器挂到 webServer 上；注册随插件卸载一起撤销。 */
/**
 * 挂七条路由。导出只为让探针能「control + gate + routes」拼起来测闭环；
 * 正常运行时只由 `apply()` 调一次。
 */
export function registerRoutes(ctx, control, versionChecker) {
	ctx.effect(() => ctx.webServer.register({
		kind: 'exact',
		path: ROUTE_STATUS,
		handler: async (req, res) => {
			if (rejected(ctx, req, res)) return;
			if (!methodIs(req, 'GET')) {
				sendJson(res, 405, { code: 'method-not-allowed', message: 'use GET' });
				return;
			}
			sendJson(res, 200, control.status());
		}
	}), 'setting-pro: route ' + ROUTE_STATUS);

	ctx.effect(() => ctx.webServer.register({
		kind: 'exact',
		path: ROUTE_RESTART,
		handler: async (req, res) => {
			if (rejected(ctx, req, res)) return;
			if (!methodIs(req, 'POST')) {
				sendJson(res, 405, { code: 'method-not-allowed', message: 'use POST' });
				return;
			}
			let body;
			try {
				body = await readJsonBody(req);
			} catch (error) {
				sendJson(res, error.code === 'body-too-large' ? 413 : 400, { code: error.code ?? 'bad-request', message: messageOf(error) });
				return;
			}
			sendActionResult(res, await control.restartNow({ force: body.force === true }));
		}
	}), 'setting-pro: route ' + ROUTE_RESTART);

	ctx.effect(() => ctx.webServer.register({
		kind: 'exact',
		path: ROUTE_SCHEDULE,
		handler: async (req, res) => {
			if (rejected(ctx, req, res)) return;
			if (!methodIs(req, 'POST')) {
				sendJson(res, 405, { code: 'method-not-allowed', message: 'use POST' });
				return;
			}
			try {
				await readJsonBody(req);
			} catch (error) {
				sendJson(res, error.code === 'body-too-large' ? 413 : 400, { code: error.code ?? 'bad-request', message: messageOf(error) });
				return;
			}
			sendActionResult(res, control.schedule());
		}
	}), 'setting-pro: route ' + ROUTE_SCHEDULE);

	ctx.effect(() => ctx.webServer.register({
		kind: 'exact',
		path: ROUTE_CANCEL,
		handler: async (req, res) => {
			if (rejected(ctx, req, res)) return;
			if (!methodIs(req, 'POST')) {
				sendJson(res, 405, { code: 'method-not-allowed', message: 'use POST' });
				return;
			}
			try {
				await readJsonBody(req);
			} catch (error) {
				sendJson(res, error.code === 'body-too-large' ? 413 : 400, { code: error.code ?? 'bad-request', message: messageOf(error) });
				return;
			}
			sendActionResult(res, control.cancel());
		}
	}), 'setting-pro: route ' + ROUTE_CANCEL);

	ctx.effect(() => ctx.webServer.register({
		kind: 'exact',
		path: ROUTE_VERSION,
		handler: async (req, res) => {
			if (rejected(ctx, req, res)) return;
			if (!methodIs(req, 'GET')) {
				sendJson(res, 405, { code: 'method-not-allowed', message: 'use GET' });
				return;
			}
			let refresh = false;
			let channel = '';
			try {
				const params = new URL(req.url ?? ROUTE_VERSION, 'http://localhost').searchParams;
				refresh = params.get('refresh') === '1';
				// 通道名不校验白名单：registry 有什么 tag 就算什么（用户要 latest/next/alpha，
				// 将来多一条 beta 线也不用改这里）。空 = auto。
				channel = String(params.get('channel') ?? '').trim();
			} catch (error) {
				refresh = false;
				channel = '';
			}
			try {
				sendJson(res, 200, await versionChecker.get({ refresh, channel }));
			} catch (error) {
				sendJson(res, 500, { code: 'version-check-failed', message: messageOf(error) });
			}
		}
	}), 'setting-pro: route ' + ROUTE_VERSION);

	ctx.effect(() => ctx.webServer.register({
		kind: 'exact',
		path: ROUTE_AGENT_TOOLS,
		handler: async (req, res) => {
			if (rejected(ctx, req, res)) return;
			if (methodIs(req, 'GET')) {
				// 只取一次快照：status() 会走 runningSessions()（折标题），别为了拼字段调两遍。
				const snapshot = control.status();
				sendJson(res, 200, {
					enabled: snapshot.agentTools,
					exposed: snapshot.agentToolsExposed,
					names: snapshot.agentToolsNames,
					path: control.machine.path,
					error: control.machine.error()
				});
				return;
			}
			if (!methodIs(req, 'POST')) {
				sendJson(res, 405, { code: 'method-not-allowed', message: 'use GET or POST' });
				return;
			}
			let body;
			try {
				body = await readJsonBody(req);
			} catch (error) {
				sendJson(res, error.code === 'body-too-large' ? 413 : 400, { code: error.code ?? 'bad-request', message: messageOf(error) });
				return;
			}
			// 只接受布尔：`"false"`、`0` 这类一律 400（和 machine 的 name 同一条纪律，不猜意图）。
			if (typeof body.enabled !== 'boolean') {
				sendJson(res, 400, { code: 'bad-request', message: 'enabled 必须是布尔值（true / false）' });
				return;
			}
			const result = control.setAgentTools(body.enabled);
			if (result.ok !== true) {
				sendJson(res, result.code === 'bad-request' ? 400 : 500, result);
				return;
			}
			sendJson(res, 200, { ...result, names: control.status().agentToolsNames });
		}
	}), 'setting-pro: route ' + ROUTE_AGENT_TOOLS);

	ctx.effect(() => ctx.webServer.register({
		kind: 'exact',
		path: ROUTE_MACHINE,
		handler: async (req, res) => {
			if (rejected(ctx, req, res)) return;
			if (methodIs(req, 'GET')) {
				const current = control.machine.read();
				sendJson(res, 200, { name: current.name, path: current.path, error: current.error, maxLength: MACHINE_NAME_MAX });
				return;
			}
			if (!methodIs(req, 'POST')) {
				sendJson(res, 405, { code: 'method-not-allowed', message: 'use GET or POST' });
				return;
			}
			let body;
			try {
				body = await readJsonBody(req);
			} catch (error) {
				sendJson(res, error.code === 'body-too-large' ? 413 : 400, { code: error.code ?? 'bad-request', message: messageOf(error) });
				return;
			}
			// 只接受字符串：非字符串是调用方的错（回 400），而不是被清洗成空名字静默清除。
			if (typeof body.name !== 'string') {
				sendJson(res, 400, { code: 'bad-request', message: 'name 必须是字符串（空串表示清除）' });
				return;
			}
			const result = control.machine.write(body.name);
			if (result.ok !== true) {
				sendJson(res, result.code === 'bad-request' ? 400 : 500, result);
				return;
			}
			sendJson(res, 200, { ...result, maxLength: MACHINE_NAME_MAX });
		}
	}), 'setting-pro: route ' + ROUTE_MACHINE);
}

// #endregion

// #region 模型工具

/**
 * 把一个「在跑的会话」条目描述成一行文本：`工作区 · 会话标题（id）`。
 * 拿不到的部分留空，用能拿到的拼；都没有就退化显示 id 或 `unknown`。纯函数，探针直接测。
 * @param item - `{ sessionId, workspace, title }`（后两者可缺）。
 * @returns 一行展示文本。
 */
export function describeRunningSession(item) {
	const session = item !== null && typeof item === 'object' ? item : {};
	const id = typeof session.sessionId === 'string' ? session.sessionId : '';
	const workspace = typeof session.workspace === 'string' ? session.workspace.trim() : '';
	const title = typeof session.title === 'string' ? session.title.trim() : '';
	const head = [workspace, title].filter((part) => part !== '').join(' · ');
	if (head === '') return id === '' ? 'unknown' : id;
	return id === '' ? head : head + '（' + id + '）';
}

/** 把毫秒时长渲染成「3 天 4 小时 5 分」这样的可读文本。 */
export function formatDuration(ms) {
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

/** 状态的一行摘要（工具与排程确认共用）。 */
/**
 * 状态里「工具开没开」这一行的拼法（纯函数，探针直接测）。
 *
 * 报的是**实际注册状态**，不是开关值：`exposed` 与 `enabled` 不一致时明确说「不一致」，
 * 因为那才是真相（比如注册抛错）。网关没挂上时是 null = 未知，不猜。
 * @param status - `control.status()`。
 * @returns 一行文本。
 */
export function describeAgentTools(status) {
	const enabled = status.agentTools === true;
	const exposed = status.agentToolsExposed;
	if (exposed === null || exposed === undefined) return '未知（工具网关没挂上）';
	const count = Array.isArray(status.agentToolsNames) ? status.agentToolsNames.length : 0;
	const state = exposed ? 'on（' + String(count) + ' 个已注册）' : 'off（模型看不到这些工具）';
	if (exposed === enabled) return state;
	return state + ' ⚠ 与开关（' + (enabled ? '开' : '关') + '）不一致：' + String(status.agentToolsError ?? '未给出原因');
}

function renderStatus(status) {
	const lines = [
		'bootId: ' + status.bootId + ' (pid ' + String(status.pid) + ')',
		'dsh: ' + String(status.dshVersion ?? 'unknown') + ' (' + String(status.dshVersionSource) + ')',
		'machine: ' + (status.machineName === '' || status.machineName === undefined ? '(未设置)' : status.machineName),
		'startedAt: ' + new Date(status.startedAt).toISOString() + ' (up ' + formatDuration(status.uptimeMs) + ')',
		'supervisor: ' + String(status.supervisor) + ' (parent managed: ' + (status.parentManaged ? 'yes' : 'no') + ') / unit: ' + status.unit + ' (' + status.unitSource + ')',
		'mechanism: ' + status.mechanism + (status.supported ? ' (delay ' + String(status.delaySec) + 's)' : ' — ' + status.reason),
		'busy: ' + (status.busy
			? 'yes — ' + String(status.runningCount) + ' running: '
				+ (Array.isArray(status.runningSessions) && status.runningSessions.length > 0
					? status.runningSessions.map(describeRunningSession).join('; ')
					: status.running.join(', '))
			: 'no'),
		'agent tools: ' + describeAgentTools(status),
		'scheduled: ' + (status.armed ? 'yes — idle ' + String(Math.round(status.quietMs / 1000)) + 's of ' + String(Math.round(status.quietWindowMs / 1000)) + 's' : 'no')
	];
	if (status.firedAt !== null) lines.push('restart fired at ' + new Date(status.firedAt).toISOString() + ' via ' + String(status.transientUnit));
	if (status.lastError !== null) lines.push('lastError: ' + status.lastError);
	lines.push('plan: ' + status.plan.command + ' ' + status.plan.args.join(' '));
	return lines.join('\n');
}

/**
 * 三个重启工具的**网关注册器**。
 *
 * 为什么要这么一层：`ctx.tools.register()` 返回「the exact disposer that unregisters the tool」，
 * 所以「开放 / 不开放给 agent」可以**即时生效**（改完下一步模型看到的工具表就不一样了），
 * 不必重启 dsh。注销后再注册同名工具是允许的（`NamedEntries` 是按名插入/删除）。
 *
 * 生命周期：始终用**我们插件自己的 ctx** 调 `register` —— cordis 的服务代理在调用时把
 * `this.ctx` 绑到**调用方**的 context，所以哪怕是从 HTTP 路由处理函数里调，effect 仍挂在
 * 本插件的 fiber 上（卸载时一起收掉），不会挂在某个短命的请求作用域上然后自己消失。
 *
 * @param ctx - Host 上下文（需要 `tools`）。
 * @param control - 重启控制器（读状态文件里的开关）。
 * @returns `{ sync(), view(), dispose() }`：`view()` 是给状态快照看的实时视图。
 */
export function createToolGate(ctx, control) {
	const TOOL_NAMES = ['dsh_restart_status', 'dsh_restart_when_idle', 'dsh_restart_cancel'];
	const view = { exposed: false, enabled: AGENT_TOOLS_DEFAULT, names: TOOL_NAMES, error: null };
	let disposers = [];

	/** 真正做注册的那一段（关掉时反过来调一遍 disposer）。 */
	function open() {
		if (disposers.length > 0) return;
		const register = (definition) => {
			disposers.push(ctx.tools.register(definition));
		};
		registerTools(ctx, control, register);
		view.exposed = true;
	}

	function close() {
		for (const dispose of disposers.splice(0).reverse()) {
			try {
				dispose();
			} catch (error) {
				view.error = messageOf(error);
			}
		}
		view.exposed = false;
	}

	/** 按状态文件里的开关对齐一次；返回对齐后的值。 */
	function sync() {
		const enabled = control.machine.agentTools();
		view.enabled = enabled;
		if (enabled === true) open();
		else close();
		return enabled;
	}

	return {
		sync,
		view,
		toolNames: TOOL_NAMES,
		dispose: close
	};
}

function registerTools(ctx, control, register = (definition) => { ctx.tools.register(definition); }) {
	register({
		name: 'dsh_restart_status',
		description:
			'Report whether dsh can be restarted from here, which systemd unit owns the process, whether any session is running, '
			+ 'and whether an idle restart is already scheduled. Also returns the exact systemd-run command a restart would use, '
			+ 'so the plan can be checked without restarting anything. Read-only.',
		parameters: { type: 'object', properties: {}, additionalProperties: false },
		output: textOutput(),
		async execute() {
			return renderStatus(control.status());
		}
	});

	register({
		name: 'dsh_restart_when_idle',
		description:
			'Schedule a dsh restart that fires only after every session (including subagents and team members) has been idle for 10 seconds. '
			+ 'The restart is handed to systemd as a detached transient unit (`systemd-run --user`), which runs `systemctl --user restart <unit>` 3 seconds later; '
			+ 'the page disconnects briefly and reconnects with session history intact. Use this after changing a Host-half plugin, where the loaded module is cached and only a process restart picks it up. '
			+ 'Returns immediately (the restart has NOT happened yet); call dsh_restart_cancel to abort it. There is deliberately no immediate-restart tool.',
		parameters: { type: 'object', properties: {}, additionalProperties: false },
		output: textOutput(),
		async execute() {
			const result = control.schedule();
			if (!result.ok) return 'could not schedule: ' + result.code + ' — ' + result.message;
			return 'restart scheduled: it fires after all sessions stay idle for '
				+ String(Math.round(control.status().quietWindowMs / 1000)) + 's, then restarts ' + control.status().unit + ' '
				+ String(control.status().delaySec) + 's later.\n' + renderStatus(control.status());
		}
	});

	register({
		name: 'dsh_restart_cancel',
		description: 'Cancel a scheduled idle restart of dsh. Has no effect when nothing is scheduled.',
		parameters: { type: 'object', properties: {}, additionalProperties: false },
		output: textOutput(),
		async execute() {
			const result = control.cancel();
			return 'cancel request: ' + (result.ok ? 'scheduled restart cleared' : 'failed') + '\n' + renderStatus(control.status());
		}
	});
}

// #endregion

/**
 * 硬依赖：路由载体、信任围栏、agent 注册表（空闲判定）、工具表。
 * `agents` 由 `dsh-base` 保证存在（`@deepseek-ai/dsh-agent-loop` 在其中注册），
 * 空闲判定必须拿到它，所以这里是硬注入而不是可选注入。
 */
export const inject = ['webServer', 'connection', 'agents', 'tools'];

/**
 * Host 插件正文。
 * @param ctx - Host 上下文。
 */
export function apply(ctx) {
	const control = createRestartControl(ctx);
	// 版本检查器与路由共用一个实例：缓存与「上一次成功结果」都留在这一份里。
	const versionChecker = createVersionChecker();
	ctx.effect(() => () => control.dispose(), 'setting-pro: restart control');
	// 任何 agent 转为 running 都说明 dsh 不空闲：立刻把静默窗清零。
	ctx.effect(() => ctx.on('agent/status', ({ status }) => {
		if (status === 'running') control.idleWatch.reset();
	}), 'setting-pro: idle reset on agent activity');
	registerRoutes(ctx, control, versionChecker);
	// 工具网关：注册/注销都即时生效，开关值来自状态文件（换浏览器不会丢）。
	const toolGate = createToolGate(ctx, control);
	control.attachToolGate(toolGate);
	// 先按开关决定注不注册：关掉时**一个工具都不挂**，卸载/dispose 也就不用收尾。
	ctx.effect(() => {
		// 注册抛错（比如与别的插件撞工具名）不该把整个插件带崩：记下原因，界面会说。
		try {
			toolGate.sync();
		} catch (error) {
			toolGate.view.enabled = control.machine.agentTools();
			toolGate.view.exposed = false;
			toolGate.view.error = messageOf(error);
		}
		return () => toolGate.dispose();
	}, 'setting-pro: agent restart tools (gate)');
}
