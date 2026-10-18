/**
 * 静态回归探针：`node probe.mjs`
 *
 * 这个仓库没有前端测试环境，能自动验的只有「宿主侧纯逻辑 + 产物形状」这一层：
 *
 *   1. `index.js` 的探测/构造/状态机（注入时间与 /proc 读取，不碰真实 systemd）；
 *   2. 包与路由的对外契约（路径、常量、只 import `node:` 内建、没有裸包名导入）；
 *   3. `client.js` 仍注册着 `settings.section`，且 `package.json` 的 `dsh.client` 声明没丢。
 *
 * **它不证明重启真的能成功** —— 那需要一次真实的 `systemctl restart`，只能在界面上由人触发。
 * 它证明的是：真正开火之前，那条 `systemd-run` 命令与空闲闸的形状是对的（只构造、不执行）。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	compareVersions,
	createIdleWatch,
	createMachineStore,
	createRestartControl,
	createToolGate,
	describeAgentTools,
	createVersionChecker,
	describeHost,
	describeRunningSession,
	detectSupervisor,
	formatDuration,
	parseServiceUnit,
	parseVersion,
	registerRoutes,
	resolveDshVersion,
	resolveUnit,
	restartUnitArgv,
	sanitizeMachineName,
	stateFilePath,
	summariseVersions,
	DSH_PACKAGE,
	DSH_VERSION_ENV,
	AGENT_TOOLS_DEFAULT,
	FIRE_DELAY_SEC,
	MACHINE_NAME_MAX,
	QUIET_MS,
	REGISTRY_ENV,
	ROUTE_CANCEL,
	ROUTE_MACHINE,
	ROUTE_AGENT_TOOLS,
	ROUTE_RESTART,
	ROUTE_SCHEDULE,
	ROUTE_STATUS,
	ROUTE_VERSION,
	STATE_FILE,
	UNIT_ENV,
	VERSION_TTL_MS,
} from './index.js';

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
	if (condition) {
		passed += 1;
		return;
	}
	failures.push(name + (detail === '' ? '' : ' — ' + detail));
}

function equal(name, actual, expected) {
	check(name, actual === expected, 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

function deepEqual(name, actual, expected) {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	check(name, a === b, 'expected ' + b + ', got ' + a);
}

// #region 1. cgroup → 单元名

equal(
	'parseServiceUnit: 真实 dsh.service cgroup 行',
	parseServiceUnit('0::/user.slice/user-1000.slice/user@1000.service/app.slice/dsh.service\n'),
	'dsh.service'
);
equal(
	'parseServiceUnit: 只用叶子，路径里的 user@1000.service 不参与竞争',
	parseServiceUnit('0::/user.slice/user-1000.slice/user@1000.service/app.slice/dsh.service\n'),
	'dsh.service'
);
equal(
	'parseServiceUnit: 叶子是 scope 时返回 null（绝不回退到上一层的 user@1000.service）',
	parseServiceUnit('0::/user.slice/user-1000.slice/user@1000.service/app.slice/dsh-subprocess-1-abc.scope\n'),
	null
);
equal('parseServiceUnit: 完全没有 .service', parseServiceUnit('0::/\n'), null);

// #endregion

// #region 2. supervisor 探测：两条信号缺一不可

const markedEnv = { INVOCATION_ID: 'abc', JOURNAL_STREAM: '10:1' };
const bareEnv = {};
equal('detectSupervisor: 标记 + 父进程 systemd', detectSupervisor(markedEnv, 4242, () => 'systemd'), 'systemd');
equal('detectSupervisor: 标记 + ppid=1', detectSupervisor(markedEnv, 1, () => null), 'systemd');
equal('detectSupervisor: 只有标记、父进程是 shell（后代继承）', detectSupervisor(markedEnv, 4242, () => 'bash'), null);
equal('detectSupervisor: 只有 ppid=1、没有标记', detectSupervisor(bareEnv, 1, () => 'systemd'), null);
equal('detectSupervisor: JOURNAL_STREAM 单条也够', detectSupervisor({ JOURNAL_STREAM: '10:1' }, 4242, () => 'systemd'), 'systemd');

// #endregion

// #region 3. 单元解析优先级：env → cgroup → 兜底

deepEqual(
	'resolveUnit: env 覆盖优先',
	resolveUnit({ env: { [UNIT_ENV]: 'dsh-staging.service' }, cgroup: () => '0::/x/dsh.service\n' }),
	{ unit: 'dsh-staging.service', source: 'env' }
);
deepEqual(
	'resolveUnit: 从 cgroup 解析',
	resolveUnit({ env: {}, cgroup: () => '0::/user.slice/user-1000.slice/user@1000.service/app.slice/dsh.service\n' }),
	{ unit: 'dsh.service', source: 'cgroup' }
);
deepEqual(
	'resolveUnit: cgroup 读不到时兜底',
	resolveUnit({
		env: {},
		cgroup: () => {
			throw new Error('ENOENT (非 Linux)');
		}
	}),
	{ unit: 'dsh', source: 'fallback' }
);

// #endregion

// #region 4. 重启命令：必须走游离临时单元，且带延迟

const argv = restartUnitArgv({ unit: 'dsh.service', delaySec: 3, now: 1_700_000_000_000 });
equal('restartUnitArgv: 用 systemd-run', argv.command, 'systemd-run');
deepEqual('restartUnitArgv: 参数逐条正确', argv.args, [
	'--user',
	'--collect',
	'--unit=dsh-restart-setting-pro-1700000000000',
	'--description=dsh restart requested by setting-pro',
	'--on-active=3s',
	'systemctl',
	'--user',
	'restart',
	'dsh.service'
]);
equal('restartUnitArgv: fireAt = now + delay', argv.fireAt, 1_700_000_000_000 + FIRE_DELAY_SEC * 1000);
check('restartUnitArgv: 含 --user（用户 manager 才有权限）', argv.args.includes('--user'));
check('restartUnitArgv: 含 --collect（跑完不留垃圾单元）', argv.args.includes('--collect'));
check('restartUnitArgv: 延迟不为 0（否则应答回不去）', /^--on-active=\d+s$/u.test(argv.args[4]) && argv.args[4] !== '--on-active=0s');
check('restartUnitArgv: 目标单元是最后两个参数', argv.args[argv.args.length - 2] === 'restart' && argv.args[argv.args.length - 1] === 'dsh.service');

// #endregion

// #region 5. 空闲闸状态机（注入时钟，不真的等 10 秒）

let clock = 1_000;
const watch = createIdleWatch({ now: () => clock, quietMs: QUIET_MS });
equal('idle: 未排程时不轮询开火', watch.poll(false), false);
watch.arm();
equal('idle: 排程后先记起点', watch.poll(true), false);
equal('idle: 繁忙时静默为 0', watch.quietMs(), 0);
clock += 5_000;
equal('idle: 繁忙不计时', watch.poll(true), false);
equal('idle: 繁忙后仍为 0', watch.quietMs(), 0);
// 转空闲：第一次 poll 只记起点
watch.poll(false);
clock += QUIET_MS - 1;
equal('idle: 差 1ms 不开火', watch.poll(false), false);
clock += 1;
equal('idle: 满窗开火', watch.poll(false), true);
equal('idle: 开火后自动收排程', watch.armed, false);
equal('idle: 收排程后不再开火', watch.poll(false), false);
// 活动清零
watch.arm();
watch.poll(false);
clock += 6_000;
watch.reset();
equal('idle: 有活动即清零', watch.quietMs(), 0);
watch.disarm();
equal('idle: 取消后排程为空', watch.armed, false);

// #endregion

// #region 6. 产物形状：路由、常量、依赖边界

equal('route: status 路径', ROUTE_STATUS, '/setting-pro/status');
equal('route: restart 路径', ROUTE_RESTART, '/setting-pro/restart');
equal('route: schedule 路径', ROUTE_SCHEDULE, '/setting-pro/schedule');
equal('route: cancel 路径', ROUTE_CANCEL, '/setting-pro/cancel');
check('常量: 空闲窗 10s', QUIET_MS === 10_000);
check('常量: 延迟 3s', FIRE_DELAY_SEC === 3);

const host = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
const bareImports = [...host.matchAll(/from\s+'([^']+)'/gu)].map((m) => m[1]).filter((spec) => !spec.startsWith('node:') && !spec.startsWith('.'));
deepEqual('index.js: 只 import node: 内建与相对路径', bareImports, []);
check('index.js: 不再是无行为的空 apply', !/export function apply\(\)\s*\{\s*\}/u.test(host));
check('index.js: 声明了四个硬依赖服务', /export const inject = \['webServer', 'connection', 'agents', 'tools'\]/u.test(host));
check('index.js: 没有给模型「立即重启」工具', !host.includes("name: 'dsh_restart_now'") && !host.includes('dsh_restart_now'));

const client = readFileSync(new URL('./client.js', import.meta.url), 'utf8');
check('client.js: 仍注册 settings.section', client.includes("'settings.section'"));
check('client.js: 面板几何覆盖仍在', client.includes('data-shortcut-modal'));

const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
deepEqual('package.json: dsh.client.inject 未被改动', manifest.dsh.client.inject, [
	'@deepseek-ai/dsh-client-ui-settings-general',
	'@deepseek-ai/dsh-client-locale'
]);
equal('package.json: platform 仍是 web', manifest.dsh.client.platform, 'web');
check('package.json: bundle patch 仍指向 cordis.patch.yml', manifest.dsh.bundle.patch === './cordis.patch.yml');

// #endregion

// #region 7. Host 半边挂载与路由契约（假 ctx，绝不真的触发重启）

/** 假 Host 上下文：记录注册了哪些路由/工具/事件，不碰真实 systemd。 */
function fakeHostCtx({ running = [], rejection = undefined, get = undefined } = {}) {
	const routes = new Map();
	const tools = new Map();
	const events = new Map();
	const disposers = [];
	const ctx = {
		connection: { requestRejection: () => rejection },
		webServer: {
			register: (route) => {
				routes.set(route.path, route);
				return () => routes.delete(route.path);
			}
		},
		tools: {
			register: (tool) => {
				tools.set(tool.name, tool);
				return () => tools.delete(tool.name);
			}
		},
		agents: { list: () => running },
		...(get === undefined ? {} : { get }),
		effect: (fn) => {
			const disposer = fn();
			if (typeof disposer === 'function') disposers.push(disposer);
			return disposer;
		},
		on: (event, listener) => {
			events.set(event, listener);
			return () => events.delete(event);
		}
	};
	return { ctx, routes, tools, events, disposers };
}

/**
 * 从 README 协议表那一行里抽出**顶层**字段名。
 *
 * 不能直接 `\{([^}]*)\}`：那份清单里有嵌套（`runningSessions[{sessionId, workspace, title}]`），
 * 非嵌套的正则只会匹到最内层那一段。这里按花括号深度扫一遍，只取深度 0 的逗号分隔项。
 * @param line - 表格行。
 * @returns 字段名数组（`running[]` 归一成 `running`）。
 */
function topLevelFields(line) {
	const start = line.indexOf('{');
	const end = line.lastIndexOf('}');
	if (start === -1 || end <= start) return [];
	const body = line.slice(start + 1, end);
	const names = [];
	let depth = 0;
	let current = '';
	for (const char of body) {
		if (char === '{' || char === '[') depth += 1;
		else if (char === '}' || char === ']') depth -= 1;
		if (char === ',' && depth === 0) {
			names.push(current);
			current = '';
			continue;
		}
		current += char;
	}
	names.push(current);
	return names
		.map((entry) => entry.trim().replace(/[[{].*$/u, '').trim())
		.filter((name) => /^[A-Za-z][A-Za-z0-9]*$/u.test(name));
}

/** 假请求：能按需把 body 推给监听器（handler 注册监听是同步发生的）。 */
function fakeRequest({ method = 'GET', headers = {}, body = undefined } = {}) {
	const listeners = new Map();
	const req = {
		method,
		headers,
		on(event, listener) {
			const list = listeners.get(event) ?? [];
			list.push(listener);
			listeners.set(event, list);
			return req;
		},
		destroy() {},
		push() {
			if (body !== undefined) for (const listener of listeners.get('data') ?? []) listener(Buffer.from(body));
			for (const listener of listeners.get('end') ?? []) listener();
		}
	};
	return req;
}

/** 假应答：只记状态码、头与正文。 */
function fakeResponse() {
	return {
		statusCode: 0,
		headers: {},
		body: '',
		setHeader(name, value) {
			this.headers[name] = value;
		},
		end(text) {
			this.body = text === undefined ? '' : String(text);
		}
	};
}

async function callRoute(routes, path, options = {}) {
	const route = routes.get(path);
	if (route === undefined) return { statusCode: -1, headers: {}, body: '' };
	const req = fakeRequest(options);
	const res = fakeResponse();
	const pending = route.handler(req, res);
	req.push();
	await pending;
	return res;
}

const fake = fakeHostCtx({
	running: [{
		sessionId: 'session-x',
		status: 'running',
		session: { id: 'session-x', header: { cwd: '/data/ai/dsh/dsh_setting_pro/' } }
	}],
	// 假 sessionTitle 服务：get(session) 返回标题快照（真实服务同名同形）。
	get: (name) => (name === 'sessionTitle' ? { get: () => ({ title: '把尺寸调大' }) } : undefined)
});
const { apply } = await import('./index.js');
// 版本检查器在 apply() 里自己建（会用真实 fetch）：把 registry 指到一个必然连不上的地址，
// 让这条路由的契约测试不发外部网络，同时走一遍「查询失败仍是 200 + 带 error」的路径。
const savedRegistry = process.env[REGISTRY_ENV];
process.env[REGISTRY_ENV] = 'http://127.0.0.1:1';
apply(fake.ctx);

deepEqual(
	'apply: 注册七条路由',
	[...fake.routes.keys()].sort(),
	[ROUTE_AGENT_TOOLS, ROUTE_CANCEL, ROUTE_MACHINE, ROUTE_RESTART, ROUTE_SCHEDULE, ROUTE_STATUS, ROUTE_VERSION].sort()
);
deepEqual(
	'apply: 注册三个工具（没有「立即重启」）',
	[...fake.tools.keys()].sort(),
	['dsh_restart_cancel', 'dsh_restart_status', 'dsh_restart_when_idle']
);
check('apply: 订阅了 agent/status（有活动就清零静默窗）', fake.events.has('agent/status'));

for (const [name, tool] of fake.tools) {
	check('工具 ' + name + ': 有 parameters/output/render', typeof tool.parameters === 'object'
		&& typeof tool.output?.schema === 'object' && typeof tool.output?.render === 'function');
}

const statusRes = await callRoute(fake.routes, ROUTE_STATUS);
equal('route status: 200', statusRes.statusCode, 200);
check('route status: 是 JSON', String(statusRes.headers['content-type'] ?? '').includes('application/json'));
const snapshot = JSON.parse(statusRes.body);
/** 真实运行时（本沙箱）的那份快照；后面几组判据都用它。 */
const fakeHostStatus = snapshot;
check('route status: 带 bootId / unit / plan', typeof snapshot.bootId === 'string' && typeof snapshot.unit === 'string'
	&& snapshot.plan.command === 'systemd-run' && snapshot.plan.args.includes('--user'));
equal('route status: 认出忙（1 个 running 会话）', snapshot.busy, true);
equal('route status: runningCount', snapshot.runningCount, 1);
check('route status: running 仍是 id 数组（对外契约不变）',
	Array.isArray(snapshot.running) && snapshot.running[0] === 'session-x');
deepEqual('route status: runningSessions 带工作区与标题', snapshot.runningSessions,
	[{ sessionId: 'session-x', workspace: 'dsh_setting_pro', title: '把尺寸调大' }]);
// 标题缓存：两次连读 `/status` 不该把 sessionTitle 折两次（它每次要扫全量事件）。
let titleCalls = 0;
const countingFake = fakeHostCtx({
	running: [{ sessionId: 's-cache', status: 'running', session: { id: 's-cache', header: { cwd: '/data/ai/x' } } }],
	get: (name) => (name === 'sessionTitle' ? {
		get: () => {
			titleCalls += 1;
			return { title: '缓存测试' };
		}
	} : undefined)
});
apply(countingFake.ctx);
await callRoute(countingFake.routes, ROUTE_STATUS);
await callRoute(countingFake.routes, ROUTE_STATUS);
equal('route status: 标题按 sessionId 缓存（TTL 内两次读只折一次）', titleCalls, 1);
for (const dispose of countingFake.disposers) dispose();

const bareFake = fakeHostCtx({ running: [{ sessionId: 'session-bare', status: 'running' }] });
apply(bareFake.ctx);
const bareSnapshot = JSON.parse((await callRoute(bareFake.routes, ROUTE_STATUS)).body);
deepEqual('route status: agent 没有 session 元信息时字段留空，不报错', bareSnapshot.runningSessions,
	[{ sessionId: 'session-bare', workspace: '', title: '' }]);
for (const dispose of bareFake.disposers) dispose();

const rejectedFake = fakeHostCtx({ rejection: 403 });
apply(rejectedFake.ctx);
const rejectedRes = await callRoute(rejectedFake.routes, ROUTE_STATUS);
equal('信任围栏: requestRejection 非 undefined 时直接拒绝', rejectedRes.statusCode, 403);
equal('信任围栏: 拒绝时不给正文', rejectedRes.body, '');
for (const disposer of rejectedFake.disposers) disposer();

const wrongMethod = await callRoute(fake.routes, ROUTE_STATUS, { method: 'POST' });
equal('route status: 非 GET → 405', wrongMethod.statusCode, 405);

const busyRes = await callRoute(fake.routes, ROUTE_RESTART, {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: '{}'
});
equal('route restart: 忙且未 force → 409', busyRes.statusCode, 409);
equal('route restart: 409 带 busy 码', JSON.parse(busyRes.body).code, 'busy');

const badType = await callRoute(fake.routes, ROUTE_RESTART, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
equal('route restart: 非 JSON content-type → 400', badType.statusCode, 400);
const badJson = await callRoute(fake.routes, ROUTE_RESTART, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
equal('route restart: 坏 JSON → 400', badJson.statusCode, 400);
const wrongMethod2 = await callRoute(fake.routes, ROUTE_RESTART, { method: 'GET' });
equal('route restart: 非 POST → 405', wrongMethod2.statusCode, 405);

const scheduleRes = await callRoute(fake.routes, ROUTE_SCHEDULE, {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: '{}'
});
if (snapshot.supported === true) {
	equal('route schedule: 支持时 200 且已排程', scheduleRes.statusCode, 200);
	equal('route schedule: armed=true', JSON.parse(scheduleRes.body).armed, true);
} else {
	// 探针自己可能就跑在非 systemd 的沙箱里（父进程是 bwrap）：这条也必须是明确拒绝，不做猜测降级。
	equal('route schedule: 不支持的主机 → 501', scheduleRes.statusCode, 501);
	equal('route schedule: 501 带 unsupported-host', JSON.parse(scheduleRes.body).code, 'unsupported-host');
}
const cancelRes = await callRoute(fake.routes, ROUTE_CANCEL, {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: '{}'
});
equal('route cancel: 200', cancelRes.statusCode, 200);
equal('route cancel: armed=false', JSON.parse(cancelRes.body).armed, false);

const versionRes = await callRoute(fake.routes, ROUTE_VERSION, { method: 'GET' });
equal('route version: 200（查询失败也回 200 + error 字段）', versionRes.statusCode, 200);
const versionPayload = JSON.parse(versionRes.body);
equal('route version: 报的是 dsh 包', versionPayload.package, DSH_PACKAGE);
check('route version: 带 current/checkedAt/ttlMs', 'current' in versionPayload && typeof versionPayload.checkedAt === 'number' && versionPayload.ttlMs === VERSION_TTL_MS);
check('route version: registry 连不上时记录 error', typeof versionPayload.error === 'string' && versionPayload.error !== '');
const versionWrongMethod = await callRoute(fake.routes, ROUTE_VERSION, { method: 'POST' });
equal('route version: 非 GET → 405', versionWrongMethod.statusCode, 405);

// 机器名字：GET 是只读的（探针只读真文件，绝不写）；写路径在下面的 store 组里用假 fs 测。
const machineRes = await callRoute(fake.routes, ROUTE_MACHINE, { method: 'GET' });
equal('route machine: GET 200', machineRes.statusCode, 200);
const machinePayload = JSON.parse(machineRes.body);
check('route machine: 带 name/path/maxLength', typeof machinePayload.name === 'string'
	&& machinePayload.path.endsWith(STATE_FILE) && machinePayload.maxLength === MACHINE_NAME_MAX);
const machineBadBody = await callRoute(fake.routes, ROUTE_MACHINE, {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: '{"name":123}'
});
equal('route machine: 非字符串 name → 400（不静默清除）', machineBadBody.statusCode, 400);
equal('route machine: 400 带 bad-request', JSON.parse(machineBadBody.body).code, 'bad-request');
const machineBadJson = await callRoute(fake.routes, ROUTE_MACHINE, {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: '{oops'
});
equal('route machine: 坏 JSON → 400', machineBadJson.statusCode, 400);
const machineWrongMethod = await callRoute(fake.routes, ROUTE_MACHINE, { method: 'PUT' });
equal('route machine: 非 GET/POST → 405', machineWrongMethod.statusCode, 405);
check('status: 带 machineName 字段', typeof fakeHostStatus.machineName === 'string');
check('status: 带 machineNamePath（指向状态文件）', String(fakeHostStatus.machineNamePath).endsWith(STATE_FILE));

if (savedRegistry === undefined) delete process.env[REGISTRY_ENV];
else process.env[REGISTRY_ENV] = savedRegistry;

const statusToolText = await fake.tools.get('dsh_restart_status').execute();
check('工具 dsh_restart_status: 输出含 mechanism 与 plan', statusToolText.includes('mechanism:') && statusToolText.includes('plan:'));
const cancelToolText = await fake.tools.get('dsh_restart_cancel').execute();
check('工具 dsh_restart_cancel: 输出含 scheduled 行', cancelToolText.includes('scheduled:'));

// 强制立即重启那条路只在「本探针不在 systemd 服务里」时才敢测：在真服务里跑它会真的重启 dsh。
if (snapshot.supported === false) {
	const forced = await callRoute(fake.routes, ROUTE_RESTART, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: '{"force":true}'
	});
	equal('route restart: 非 systemd 上 force 也拒绝 → 501', forced.statusCode, 501);
	equal('route restart: 501 码为 unsupported-host', JSON.parse(forced.body).code, 'unsupported-host');
}
// 收摊前抓一份「网关确实挂着工具」的证据，再验卸载把工具**注销干净**。
// 这是 0.10 的开关带来的真变化：以前 registerTools 不挂 effect，插件卸载后工具还在表里。
const beforeSweepCount = fake.tools.size;
for (const disposer of fake.disposers) disposer(); // 收摊：清掉空闲计时器 + 注销工具
equal('卸载: 收摊前确实挂着三个工具', beforeSweepCount, 3);
equal('卸载: 三个工具都被注销（不留悬空注册）', fake.tools.size, 0);

// #endregion

// #region 8. 浏览器半边冒烟：假 React + 假 window，把组件树搭出来（不需要浏览器）

/** 假 React：只要能建元素、能过 hooks，就足以把组件调一遍。 */
const fakeReact = {
	createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
	useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
	useEffect: () => {},
	useCallback: (fn) => fn,
	useRef: (initial) => ({ current: initial }),
	// 模型那格读官方目录 store 用它：假实现就是「订阅一次（忽略）+ 读快照」。
	useSyncExternalStore: (_subscribe, getSnapshot) => (typeof getSnapshot === 'function' ? getSnapshot() : null)
};

/**
 * 假 DOM：够跑 installStyles / applySize，也够把「logo 下面的机器名」这段 DOM 注入测出来。
 * 只实现用到的那点选择器（`[data-window-drag]` / `svg` / `button` / `[aria-hidden="true"]`）。
 */
function createFakeDom() {
	let sequence = 0;
	const makeElement = (tagName) => {
		const element = {
			id: ++sequence,
			tagName: String(tagName).toUpperCase(),
			attributes: new Map(),
			children: [],
			parent: null,
			textContent: '',
			className: '',
			dataset: {},
			style: { setProperty() {}, removeProperty() {} },
			// 语义同浏览器：只要在文档树里（body 及其后代）就算 connected。
			// 注意别写成「一路走到根再比对 body」——body 的父是 documentElement，那样永远是 false。
			get isConnected() {
				let cursor = element;
				while (cursor !== null) {
					if (cursor === document.body) return true;
					cursor = cursor.parent;
				}
				return false;
			},
			get nextElementSibling() {
				if (element.parent === null) return null;
				const index = element.parent.children.indexOf(element);
				return index === -1 ? null : (element.parent.children[index + 1] ?? null);
			},
			setAttribute(name, value) {
				element.attributes.set(name, String(value));
			},
			getAttribute(name) {
				return element.attributes.has(name) ? element.attributes.get(name) : null;
			},
			hasAttribute(name) {
				return element.attributes.has(name);
			},
			appendChild(child) {
				child.parent = element;
				element.children.push(child);
				return child;
			},
			append(...children) {
				for (const child of children) element.appendChild(child);
			},
			insertAdjacentElement(position, child) {
				if (position !== 'afterend' || element.parent === null) return null;
				const index = element.parent.children.indexOf(element);
				child.parent = element.parent;
				element.parent.children.splice(index + 1, 0, child);
				return child;
			},
			remove() {
				if (element.parent === null) return;
				const index = element.parent.children.indexOf(element);
				if (index !== -1) element.parent.children.splice(index, 1);
				element.parent = null;
			},
			matches(selector) {
				if (selector === 'svg') return element.tagName === 'SVG';
				if (selector === 'button') return element.tagName === 'BUTTON';
				if (selector === '[data-window-drag]') return element.hasAttribute('data-window-drag');
				if (selector === '[aria-hidden="true"]') return element.getAttribute('aria-hidden') === 'true';
				const classContains = /^\[class\*="([^"]+)"\]$/u.exec(selector);
				if (classContains !== null) return String(element.className).includes(classContains[1]);
				if (selector.startsWith('.')) return String(element.className).split(/\s+/u).includes(selector.slice(1));
				return false;
			},
			querySelectorAll(selector) {
				const found = [];
				const walk = (current) => {
					for (const child of current.children) {
						if (child.matches(selector)) found.push(child);
						walk(child);
					}
				};
				walk(element);
				return found;
			},
			querySelector(selector) {
				return element.querySelectorAll(selector)[0] ?? null;
			}
		};
		return element;
	};

	const document = {
		documentElement: makeElement('html'),
		head: makeElement('head'),
		createElement: (tagName) => makeElement(tagName),
		querySelector: (selector) => document.body.querySelector(selector),
		querySelectorAll: (selector) => document.body.querySelectorAll(selector),
		addEventListener() {},
		removeEventListener() {}
	};
	document.body = makeElement('body');
	document.head.parent = document.documentElement;
	document.body.parent = document.documentElement;
	/**
	 * 造一个「品牌行」，**照真实结构**：`<hash>_logoRow` + data-window-drag，里面有品牌身份
	 * （`_brandIdentity` 含 `_brandMark`/`_brandName`），**并且有一个收起/展开按钮** ——
	 * 2026-10-17 的 bug 正是「按不含 button 筛」把自己排除了，这里必须留着这个按钮当回归。
	 */
	document.__brandRow = (() => {
		const row = makeElement('div');
		row.className = 'Xa_logoRow';
		row.setAttribute('data-window-drag', 'true');
		const identity = makeElement('span');
		identity.className = 'Xa_brandIdentity';
		identity.setAttribute('aria-hidden', 'true');
		const mark = makeElement('span');
		mark.className = 'Xa_brandMark';
		mark.appendChild(makeElement('svg'));
		const name = makeElement('span');
		name.className = 'Xa_brandName';
		identity.appendChild(mark);
		identity.appendChild(name);
		row.appendChild(identity);
		const toggle = makeElement('button');
		toggle.className = 'Xa_toggle';
		toggle.appendChild(makeElement('svg'));
		row.appendChild(toggle);
		document.body.appendChild(row);
		return row;
	})();
	/** 造一个「topStrip」：也有 data-window-drag，但里面是按钮（用来验证锚点不会选错）。 */
	document.__topStrip = (() => {
		const strip = makeElement('div');
		strip.className = 'Xa_topStrip';
		strip.setAttribute('data-window-drag', 'true');
		const toggle = makeElement('button');
		toggle.appendChild(makeElement('svg'));
		strip.appendChild(toggle);
		document.body.appendChild(strip);
		return strip;
	})();
	return document;
}

const fakeDocument = createFakeDom();

/** 假 MutationObserver：只记录被观察，不真的回调（对齐靠定时器与显式调用）。 */
const observedTargets = [];
class FakeMutationObserver {
	constructor(callback) {
		this.callback = callback;
	}
	observe(target, options) {
		observedTargets.push({ target, options });
	}
	disconnect() {
		this.disconnected = true;
	}
}
globalThis.MutationObserver = FakeMutationObserver;

/** 假 window：定时器被收集起来，探针可以手动触发或断言被清理。 */
const timers = { intervals: [], timeouts: [] };
const listeners = new Map();
// 注意：这里必须真的声明 storage。之前它没定义，于是所有走 localStorage 的分支
// （尺寸、重启排程记号、模型格开关）都靠 try/catch 兜住并静默退回默认值 ——
// 那条路等于没被测过。
const storage = new Map();
globalThis.window = {
	localStorage: {
		getItem: (key) => (storage.has(key) ? storage.get(key) : null),
		setItem: (key, value) => storage.set(key, String(value)),
		removeItem: (key) => storage.delete(key)
	},
	setInterval: (fn, ms) => {
		timers.intervals.push({ fn, ms });
		return timers.intervals.length;
	},
	clearInterval: (id) => {
		if (timers.intervals[id - 1] !== undefined) timers.intervals[id - 1] = null;
	},
	// 真执行（防抖靠它），但仍然记录，便于断言与清理；setInterval 只记录不触发。
	setTimeout: (fn, ms) => {
		const real = globalThis.setTimeout(fn, 0);
		timers.timeouts.push({ fn, ms, real, cleared: false });
		return real;
	},
	clearTimeout: (id) => {
		for (const entry of timers.timeouts) if (entry.real === id) entry.cleared = true;
		globalThis.clearTimeout(id);
	},
	addEventListener: (type, listener) => {
		const list = listeners.get(type) ?? [];
		list.push(listener);
		listeners.set(type, list);
	},
	removeEventListener: (type, listener) => {
		const list = listeners.get(type) ?? [];
		listeners.set(type, list.filter((entry) => entry !== listener));
	},
	dispatchEvent: (event) => {
		for (const listener of listeners.get(event.type) ?? []) listener(event);
	},
	confirm: () => true,
	fetch: async () => ({ ok: false, status: 0, json: async () => null })
};
globalThis.CustomEvent = class CustomEvent {
	constructor(type, init) {
		this.type = type;
		this.detail = init === undefined ? null : init.detail;
	}
};
globalThis.document = fakeDocument;

/** 假 fetch：只认本插件那几条路由，用于让「机器名标签」真的跑起来。 */
const machineRouteState = { name: '测试机' };
/** 假 `/status` 的忙闲：探针改它 + 手动触发轮询，就能验「运行中」指示的出现/消失。 */
const statusRouteState = { busy: false, runningCount: 0, sessions: [] };
globalThis.fetch = async (url) => {
	const target = String(url);
	const json = (payload) => ({
		ok: true,
		status: 200,
		headers: { get: () => 'application/json; charset=utf-8' },
		json: async () => payload
	});
	if (target.startsWith('/setting-pro/machine')) return json({ name: machineRouteState.name, path: '/tmp/x/setting-pro.json', error: null, maxLength: 64 });
	if (target.startsWith('/setting-pro/status')) {
		return json({
			supported: false,
			machineName: machineRouteState.name,
			busy: statusRouteState.busy,
			runningCount: statusRouteState.runningCount,
			runningSessions: statusRouteState.sessions
		});
	}
	if (target.startsWith('/setting-pro/version')) return json({ current: '0.2.0-rc.2', tags: [], newest: null, newer: null });
	return { ok: false, status: 404, headers: { get: () => 'text/html' }, json: async () => null };
};

let clientDefinition = null;
globalThis.window.__ModuleLoader__ = {
	load: (definition) => {
		clientDefinition = definition;
	}
};
// client.js 是手写 bundle：加载时只调用 window.__ModuleLoader__.load，不开副作用。
const clientSource = readFileSync(new URL('./client.js', import.meta.url), 'utf8');
new Function(clientSource)();

check('client.js: 通过 __ModuleLoader__ 注册了自己', clientDefinition !== null && clientDefinition.id === '@dongasai/dsh-setting-pro');
const clientModule = clientDefinition.factory((spec) => {
	if (spec === 'react') return fakeReact;
	throw new Error('client.js require 了预期外的包：' + spec);
});
deepEqual('client.js: inject 只声明 slots 与 locale', clientModule.inject, ['slots', 'locale']);

/** 假槽位表：记录每次 register（含 priority），并支持卸载。 */
function createFakeSlots(options = {}) {
	const registrations = [];
	const disposed = [];
	const pending = [];
	const slots = {
		registrations,
		disposed,
		pending,
		// deferInject：模拟「槽位还没声明」的官方语义 —— inject 先不跑回调，等 declare() 那一刻
		// 才跑（官方 notifyDeclaration 是裸循环、不隔离异常，所以回调自己必须兜住错误）。
		inject: (name, callback) => {
			if (options.deferInject === true) {
				pending.push({ name, callback });
				return () => {};
			}
			return callback();
		},
		declare: () => {
			let escaped = null;
			for (const item of pending.splice(0, pending.length)) {
				try {
					item.callback();
				} catch (error) {
					escaped = error;
				}
			}
			return escaped;
		},
		register: (registrationOptions, component) => {
			// 模拟「品牌区占位失败」：只对 sidebar.brand.* 抛，用来验 DOM 兜底那条路。
			if (options.failBrand === true && String(registrationOptions.name).startsWith('sidebar.brand.')) {
				throw new Error('single slot "' + registrationOptions.name + '" already has a registration at priority 0');
			}
			// 模拟「那一行的槽位挂不上」：注册抛错必须被我们自己兜住（官方通知循环不隔离异常）。
			if (options.failDock === true && registrationOptions.name === 'conversation.composer.dock') {
				throw new Error('slot "conversation.composer.dock" is not declared');
			}
			const entry = { options: registrationOptions, component, disposed: false };
			registrations.push(entry);
			return () => {
				entry.disposed = true;
				disposed.push(entry);
			};
		}
	};
	return slots;
}

const dictionaries = new Map();
const clientDisposers = [];
const fakeSlots = createFakeSlots();
clientModule.apply({
	effect: (fn) => {
		const disposer = fn();
		if (typeof disposer === 'function') clientDisposers.push(disposer);
		return disposer;
	},
	locale: {
		register: (ns, dict) => {
			dictionaries.set(ns, dict);
			return () => {};
		},
		// 官方约定：register(NS, { zh, en }) 由 locale 服务按当前语言取；假实现固定取 zh，
		// 但要认这个两层形状 —— 否则 t('runLabel') 会去找 DICT.runLabel 而报 MISSING。
		bind: (ns) => (key) => {
			const dict = dictionaries.get(ns) ?? {};
			const table = dict.zh !== undefined && typeof dict.zh === 'object' ? dict.zh : dict;
			return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : 'MISSING:' + key;
		}
	},
	slots: fakeSlots
});

const settingsRegistration = fakeSlots.registrations.find((entry) => entry.options.name === 'settings.section') ?? null;
check('client.js: 注册了 settings.section', settingsRegistration !== null);
equal('client.js: 页 id 仍是 advanced', settingsRegistration === null ? null : settingsRegistration.options.id, 'advanced');
equal('client.js: 排序仍是 50', settingsRegistration === null ? null : settingsRegistration.options.order, 50);
check('client.js: label 是 thunk（语言切换即时跟上）', settingsRegistration !== null && typeof settingsRegistration.options.label === 'function');
check('client.js: 字典注册为 dsh-setting-pro', dictionaries.has('dsh-setting-pro'));

// —— 品牌区顶替（官方 priority 0 → 我们用 -1 压过它）——
const MACHINE_EVENT = 'dsh-setting-pro:machine-name';
check('机器名: 事件名与 client.js 一致', clientSource.includes(MACHINE_EVENT));
check('机器名: 用了官方 priority 机制（不是抢 DOM）', clientSource.includes('BRAND_PRIORITY = -1'));
await new Promise((resolve) => setTimeout(resolve, 0)); // 等名字来源那次 fetch 落进 store
const brandEntries = () => fakeSlots.registrations.filter((entry) => String(entry.options.name).startsWith('sidebar.brand.'));
equal('品牌区: 有名字时占两个槽（mark + name）', brandEntries().length, 2);
check('品牌区: 两个占位都带 priority -1', brandEntries().every((entry) => entry.options.priority === -1));
deepEqual('品牌区: 占的是 mark 与 name', brandEntries().map((entry) => entry.options.name).sort(),
	['sidebar.brand.mark', 'sidebar.brand.name']);
const brandNameEntry = brandEntries().find((entry) => entry.options.name === 'sidebar.brand.name');
const brandMarkEntry = brandEntries().find((entry) => entry.options.name === 'sidebar.brand.mark');
const brandNameTree = brandNameEntry === undefined ? null : brandNameEntry.component();
equal('品牌区: 正文渲染出机器名', brandNameTree === null ? null : brandNameTree.children[0], '测试机');
equal('品牌区: 标记渲染为空（logo 让位给名字）', brandMarkEntry === undefined ? 'missing' : brandMarkEntry.component(), null);
const findLabel = () => fakeDocument.body.querySelectorAll('.dspro_machine')[0] ?? null;
check('品牌区: 顶替成功时不再画 DOM 兜底那一行（避免重复）', findLabel() === null);

// —— 「运行中」指示（品牌身份后面，和 orca 皮肤同一个位置）——
const findRun = () => fakeDocument.body.querySelectorAll('.dspro_run')[0] ?? null;
const identityOf = (row) => row.querySelector('[class*="_brandIdentity"]');
const runPoll = () => {
	const entry = timers.intervals.find((item) => item !== null && item.ms === 5000);
	return entry === undefined ? null : entry.fn;
};
check('运行指示: 第一次成功读到之前（状态未知）不画，不猜一个「空闲」', findRun() === null);
statusRouteState.busy = true;
statusRouteState.runningCount = 2;
const poll = runPoll();
check('运行指示: 找得到那个 5s 轮询', typeof poll === 'function');
if (typeof poll === 'function') poll();
await new Promise((resolve) => setTimeout(resolve, 250)); // 等一次 read + 120ms 防抖
const runNode = findRun();
check('运行指示: 忙时出现', runNode !== null);
check('运行指示: 挂在品牌身份之后（logo 后面，不是新起一行）',
	runNode !== null && identityOf(fakeDocument.__brandRow) !== null
	&& identityOf(fakeDocument.__brandRow).nextElementSibling === runNode);
equal('运行指示: 文案带计数', runNode === null ? null : runNode.querySelector('.dspro_runLabel').textContent, '运行中 ×2');
check('运行指示: 文案只走 textContent', clientSource.includes("label.textContent = text") && !clientSource.includes('innerHTML'));
check('运行指示: 明细缺失时 title 回退成纯计数（旧 Host 兼容）', runNode !== null && runNode.getAttribute('title') === '运行中 ×2');
statusRouteState.busy = false;
statusRouteState.runningCount = 0;
if (typeof poll === 'function') poll();
await new Promise((resolve) => setTimeout(resolve, 250));
// 用户要的语义（2026-10-17「没有运行中也给个提示」）：空闲**不撤掉**，换成灰色「空闲」。
const idleNode = findRun();
check('运行指示: 空闲时仍然显示（不是消失）', idleNode !== null);
equal('运行指示: 空闲态 data-state', idleNode === null ? null : idleNode.getAttribute('data-state'), 'idle');
equal('运行指示: 空闲态文案', idleNode === null ? null : idleNode.querySelector('.dspro_runLabel').textContent, '空闲');
equal('运行指示: 空闲态悬停', idleNode === null ? null : idleNode.getAttribute('title'), '当前没有会话在运行');

// 悬停明细：带工作区/会话标题
statusRouteState.busy = true;
statusRouteState.runningCount = 2;
statusRouteState.sessions = [
	{ sessionId: 's1', workspace: '客厅', title: '修登录 bug' },
	{ sessionId: 's2', workspace: '书房', title: '' }
];
if (typeof poll === 'function') poll();
await new Promise((resolve) => setTimeout(resolve, 250));
equal('运行指示: 悬停拼出「工作区 · 会话」明细（缺项自动省）', findRun() === null ? null : findRun().getAttribute('title'),
	'运行中 ×2\n客厅 · 修登录 bug\n书房');
// busy/count 没变、只有标题变 → 签名要认，chip 得跟上
statusRouteState.sessions = [{ sessionId: 's1', workspace: '客厅', title: '改名了' }, { sessionId: 's2', workspace: '书房', title: '' }];
if (typeof poll === 'function') poll();
await new Promise((resolve) => setTimeout(resolve, 250));
equal('运行指示: 标题变了（计数没变）悬停也跟上', findRun() === null ? null : findRun().getAttribute('title'),
	'运行中 ×2\n客厅 · 改名了\n书房');
equal('运行指示: 忙态 data-state 切回 running', findRun() === null ? null : findRun().getAttribute('data-state'), 'running');
statusRouteState.busy = false;
statusRouteState.runningCount = 0;
statusRouteState.sessions = [];
if (typeof poll === 'function') poll();
await new Promise((resolve) => setTimeout(resolve, 250));
equal('运行指示: 再回空闲（带过明细后也能干净切回）', findRun() === null ? null : findRun().getAttribute('data-state'), 'idle');

// 清空名字 → 占位撤掉，官方 logo 回来
machineRouteState.name = '';
window.dispatchEvent(new CustomEvent(MACHINE_EVENT, { detail: { name: '' } }));
check('品牌区: 清空名字后两个占位都被卸载', brandEntries().length === 2 && brandEntries().every((entry) => entry.disposed));
check('品牌区: 卸载后不再插 DOM 兜底', findLabel() === null);

statusRouteState.busy = true;
statusRouteState.runningCount = 1;
if (typeof runPoll() === 'function') runPoll()();
await new Promise((resolve) => setTimeout(resolve, 250));
const beforeDispose = findRun();
for (const disposer of clientDisposers) disposer();
check('运行指示: 卸载前确实在显示（这条断言才有意义）', beforeDispose !== null);
check('运行指示: 卸载后撤掉', findRun() === null);
check('卸载: 全部 effect 都能安全收摊', true);

// —— DOM 兜底那条路：让品牌占位失败，名字应退回 logo 下面 ——
const fallbackDocument = createFakeDom();
globalThis.document = fallbackDocument;
machineRouteState.name = '兜底机';
const fallbackDisposers = [];
const fallbackSlots = createFakeSlots({ failBrand: true });
clientModule.apply({
	effect: (fn) => {
		const disposer = fn();
		if (typeof disposer === 'function') fallbackDisposers.push(disposer);
		return disposer;
	},
	locale: { register: () => () => {}, bind: () => (key) => key },
	slots: fallbackSlots
});
await new Promise((resolve) => setTimeout(resolve, 0));
await new Promise((resolve) => setTimeout(resolve, 0));
const fallbackLabel = () => fallbackDocument.body.querySelectorAll('.dspro_machine')[0] ?? null;
const fallbackNode = fallbackLabel();
check('兜底: 品牌占位失败时插到品牌行之后', fallbackNode !== null && fallbackDocument.__brandRow.nextElementSibling === fallbackNode);
check('兜底: 没插到 topStrip（锚点没选错）', fallbackDocument.__topStrip.nextElementSibling !== fallbackNode);
equal('兜底: 文案来自 Host', fallbackNode === null ? null : fallbackNode.textContent, '兜底机');
check('兜底: 名字只走 textContent（不是 innerHTML）', clientSource.includes('nameNode.textContent = name') && !clientSource.includes('innerHTML'));
check('兜底: 装了 MutationObserver 重新对齐', observedTargets.length > 0);
check('兜底: 回归 —— logo 行里有 button 也要能命中（2026-10-17 的 bug）',
	fallbackDocument.__brandRow.querySelector('button') !== null && fallbackNode !== null);
window.dispatchEvent(new CustomEvent(MACHINE_EVENT, { detail: { name: '<b>注入</b>' } }));
await new Promise((resolve) => setTimeout(resolve, 200)); // 等标签那边的 120ms 防抖
equal('兜底: 改名即时更新（当文本处理）', fallbackLabel() === null ? null : fallbackLabel().textContent, '<b>注入</b>');
for (const disposer of fallbackDisposers) disposer();
check('兜底: 卸载后节点撤掉', fallbackLabel() === null);
globalThis.document = fakeDocument;

const dict = dictionaries.get('dsh-setting-pro');
deepEqual('字典: zh 与 en 的键完全一致', Object.keys(dict.zh).sort(), Object.keys(dict.en).sort());

const texts = [];
/** 浅渲染：遇到函数组件就调用它（hooks 是假的），把文本收集出来。 */
function renderNode(node) {
	if (node === null || node === undefined || typeof node !== 'object') {
		if (typeof node === 'string') texts.push(node);
		return;
	}
	if (Array.isArray(node)) {
		for (const child of node) renderNode(child);
		return;
	}
	if (typeof node.type === 'function') {
		renderNode(node.type(node.props ?? {}));
		return;
	}
	for (const child of node.children ?? []) renderNode(child);
}

const bound = (locale) => (key) => dict[locale][key];
for (const locale of ['zh', 'en']) {
	let tree = null;
	try {
		tree = settingsRegistration.component({ t: bound(locale) });
	} catch (error) {
		check('组件渲染（' + locale + '）不抛错', false, String(error && error.message ? error.message : error));
	}
	if (tree !== null) renderNode(tree);
}

check('组件树: 渲染出了「Host 运维」标题', texts.includes(dict.zh.opsHeading));
check('组件树: 渲染出了「DSH 版本」标题', texts.includes(dict.zh.versionHeading));
check('组件树: 渲染出了「输入框下方那一行」标题', texts.includes(dict.zh.modelGroupTitle));
check('组件树: Host 运维里有「开放给 agent」那一行', texts.includes(dict.zh.agentToolsTitle));
check('组件树: 还没读到状态时那行说「不知道」（不说「未开放」）', texts.includes(dict.zh.agentToolsUnknown));
check('组件树: 三个运维动作标签齐全', texts.includes(dict.zh.restartAction) && texts.includes(dict.zh.scheduleAction) && texts.includes(dict.zh.cancelAction));
check('组件树: 尺寸三行仍在', texts.includes(dict.zh.widthTitle) && texts.includes(dict.zh.heightTitle) && texts.includes(dict.zh.resetTitle));
check('组件树: 没有缺失的字典键', !texts.some((text) => text.startsWith('MISSING:')));

// 组件初始 status 是 null，上面的渲染只走到「读取中」；把源码里**所有** t('key') 抽出来
// 逐个核对，才能覆盖状态行 / 错误行那些只在有状态时才渲染的文案键。
const usedKeys = [...new Set([...clientSource.matchAll(/\bt\('([a-zA-Z]+)'\)/gu)].map((match) => match[1]))];
check('字典: 源码用到的 t(key) 都在 zh/en 里',
	usedKeys.every((key) => Object.prototype.hasOwnProperty.call(dict.zh, key) && Object.prototype.hasOwnProperty.call(dict.en, key)),
	usedKeys.filter((key) => !(key in dict.zh) || !(key in dict.en)).join(', '));
check('字典: t(key) 数量合理（防抽键正则失效）', usedKeys.length >= 30, String(usedKeys.length));

// 用户报过「空闲后重启不可点」：排程按钮不得再被 supported / armed 关掉。
check('按钮: 排程按钮不再因 !supported 被禁用', !clientSource.includes('disabled: !supported'));
check('按钮: 只有动作进行中才禁用', /disabled: working,/u.test(clientSource));
check('按钮: 取消排程仍只在已排程时可用', /disabled: !armed \|\| working,/u.test(clientSource));
check('真回执防护: 非 JSON 响应不当成功（含 missing 标记）', clientSource.includes("includes('application/json')") && clientSource.includes('missing: true'));

// #endregion

// #region 8b. 在跑会话的行文本描述（工具输出用）
equal('describeRunningSession: 工作区 · 标题（id）',
	describeRunningSession({ sessionId: 's1', workspace: 'dsh_setting_pro', title: '修登录 bug' }),
	'dsh_setting_pro · 修登录 bug（s1）');
equal('describeRunningSession: 只有工作区', describeRunningSession({ sessionId: 's1', workspace: 'game', title: '' }), 'game（s1）');
equal('describeRunningSession: 只有标题', describeRunningSession({ sessionId: 's1', workspace: '', title: '聊天' }), '聊天（s1）');
equal('describeRunningSession: 什么都没有就退回 id', describeRunningSession({ sessionId: 's1' }), 's1');
equal('describeRunningSession: 坏输入不抛', describeRunningSession(null), 'unknown');
// #endregion

// #region 9. 宿主判据：cgroup 叶子，而不是父进程 comm

const DSH_CGROUP = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/dsh.service\n';

deepEqual(
	'describeHost: 真实 dsh.service（父进程是 npx 也算支持）',
	describeHost({ env: { INVOCATION_ID: 'x', JOURNAL_STREAM: 'y' }, cgroup: () => DSH_CGROUP }),
	{ supported: true, supervisor: 'systemd', unit: 'dsh.service', unitSource: 'cgroup', reason: '宿主是 systemd 用户服务 dsh.service' }
);
deepEqual(
	'describeHost: env 覆盖优先',
	describeHost({ env: { [UNIT_ENV]: 'dsh-staging.service' }, cgroup: () => DSH_CGROUP }),
	{ supported: true, supervisor: 'systemd', unit: 'dsh-staging.service', unitSource: 'env', reason: UNIT_ENV + ' 指定了单元，跳过探测' }
);
const scopeHost = describeHost({ env: { INVOCATION_ID: 'x' }, cgroup: () => '0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-123.scope\n' });
equal('describeHost: 叶子是 scope → 不支持', scopeHost.supported, false);
check('describeHost: 叶子是 scope 时给出原因', scopeHost.reason.includes('不是 .service'));
const unreadableHost = describeHost({
	env: { INVOCATION_ID: 'x' },
	cgroup: () => {
		throw new Error('ENOENT');
	}
});
equal('describeHost: /proc 读不到 → 不支持', unreadableHost.supported, false);
const managerHost = describeHost({ env: { JOURNAL_STREAM: 'y' }, cgroup: () => '0::/user.slice/user-1000.slice/user@1000.service\n' });
equal('describeHost: 叶子是用户管理器 → 拒绝重启', managerHost.supported, false);
check('describeHost: 管理器拒绝有明确原因', managerHost.reason.includes('用户管理器'));
equal('describeHost: 有服务 cgroup 但缺 systemd 标记 → 不支持', describeHost({ env: {}, cgroup: () => DSH_CGROUP }).supported, false);

check('runtime: 沙箱里判为不支持（叶子是 dsh-subprocess-*.scope）', fakeHostStatus.supported === false, JSON.stringify(fakeHostStatus));
check('runtime: 不支持时带着原因', typeof fakeHostStatus.reason === 'string' && fakeHostStatus.reason !== '');
check('runtime: parentManaged 只是展示字段（布尔），不参与能不能重启的判据', typeof fakeHostStatus.parentManaged === 'boolean');

// #endregion

// #region 10. 最后启动时间

check('status: 带 startedAt（毫秒时间戳）', typeof fakeHostStatus.startedAt === 'number' && fakeHostStatus.startedAt > 0);
check('status: 带 uptimeMs（非负）', typeof fakeHostStatus.uptimeMs === 'number' && fakeHostStatus.uptimeMs >= 0);
check('status: startedAt + uptimeMs ≈ 现在', Math.abs((fakeHostStatus.startedAt + fakeHostStatus.uptimeMs) - Date.now()) < 5000);
equal('formatDuration: 秒', formatDuration(8_000), '8 秒');
equal('formatDuration: 分', formatDuration(125_000), '2 分 5 秒');
equal('formatDuration: 小时', formatDuration(3 * 3600_000 + 4 * 60_000), '3 小时 4 分');
equal('formatDuration: 天', formatDuration(2 * 86400_000 + 5 * 3600_000), '2 天 5 小时');
equal('formatDuration: 负数收敛到 0', formatDuration(-1), '0 秒');
// 组 7 那份 fake 已经收摊（工具被注销了），这里重新挂一份只用来验工具输出。
const startedCtx = fakeHostCtx({ running: [] });
apply(startedCtx.ctx);
const startedToolText = await startedCtx.tools.get('dsh_restart_status').execute();
for (const disposer of startedCtx.disposers) disposer();
check('工具输出: 含 startedAt 与 up', startedToolText.includes('startedAt:') && startedToolText.includes('(up '));

// #endregion

// #region 11. 版本与更新检查

equal('parseVersion: 基本三段', JSON.stringify(parseVersion('1.2.3')), JSON.stringify({ core: [1, 2, 3], pre: [] }));
equal('parseVersion: 预发布段', JSON.stringify(parseVersion('0.2.1-alpha.5')), JSON.stringify({ core: [0, 2, 1], pre: ['alpha', '5'] }));
equal('parseVersion: 忽略 build 元数据', JSON.stringify(parseVersion('1.0.0-rc.1+build.7')), JSON.stringify({ core: [1, 0, 0], pre: ['rc', '1'] }));
equal('parseVersion: 不认范围/标签', parseVersion('^1.2.3'), null);
equal('parseVersion: 不认两段', parseVersion('1.2'), null);

equal('compareVersions: 相等', compareVersions('1.2.3', '1.2.3'), 0);
check('compareVersions: patch 更高', compareVersions('1.2.4', '1.2.3') > 0);
check('compareVersions: minor 更高', compareVersions('1.3.0', '1.2.9') > 0);
check('compareVersions: 正式版高于预发布', compareVersions('0.2.0', '0.2.0-rc.2') > 0);
check('compareVersions: 0.2.1-alpha.5 > 0.2.0-rc.2（升级线跨越）', compareVersions('0.2.1-alpha.5', '0.2.0-rc.2') > 0);
check('compareVersions: alpha.10 > alpha.5（数字段按数值比）', compareVersions('1.0.0-alpha.10', '1.0.0-alpha.5') > 0);
check('compareVersions: alpha < beta（字母段按字典序）', compareVersions('1.0.0-alpha', '1.0.0-beta') < 0);
equal('compareVersions: 解析不出返回 null（不装作相等）', compareVersions('1.2.3', 'not-a-version'), null);

const DSH_MANIFEST = JSON.stringify({ name: DSH_PACKAGE, version: '0.2.0-rc.2' });
const fakeFs = (files) => ({
	exists: (file) => Object.prototype.hasOwnProperty.call(files, file),
	readFile: (file) => {
		if (!Object.prototype.hasOwnProperty.call(files, file)) throw new Error('ENOENT');
		return files[file];
	}
});
const binPath = '/opt/node_modules/@deepseek-ai/dsh/lib/bin.js';
deepEqual(
	'resolveDshVersion: 从 argv[1] 往上找到 dsh 包',
	resolveDshVersion({ env: {}, argv1: binPath, ...fakeFs({ '/opt/node_modules/@deepseek-ai/dsh/package.json': DSH_MANIFEST }) }),
	{ version: '0.2.0-rc.2', source: 'package', path: '/opt/node_modules/@deepseek-ai/dsh/package.json', name: DSH_PACKAGE }
);
const nearestResult = resolveDshVersion({
	env: {},
	argv1: '/opt/node_modules/@deepseek-ai/dsh/lib/bin.js',
	...fakeFs({ '/opt/node_modules/@deepseek-ai/dsh/lib/package.json': JSON.stringify({ name: 'dsh-lib', version: '9.9.9' }) })
});
equal('resolveDshVersion: 找不到 dsh 时记最近一个 manifest（标 nearest）', nearestResult.source, 'nearest');
equal('resolveDshVersion: env 覆盖优先', resolveDshVersion({ env: { [DSH_VERSION_ENV]: '1.2.3' }, argv1: binPath }).source, 'env');
equal('resolveDshVersion: 什么都没有 → null', resolveDshVersion({ env: {}, argv1: '', ...fakeFs({}) }).version, null);

const REAL_TAGS = { next: '0.2.0-rc.2', latest: '0.2.0-rc.2', alpha: '0.2.1-alpha.5' };
const summary = summariseVersions('0.2.0-rc.2', REAL_TAGS);
equal('summariseVersions: 取到最高版本', summary.newest, '0.2.1-alpha.5');
equal('summariseVersions: 并指出它挂在哪个 tag', summary.newestTag, 'alpha');
check('summariseVersions: 只盯 latest 会漏（这里判出有更新）', summary.newer !== null && summary.newer.version === '0.2.1-alpha.5');
equal('summariseVersions: 当前同线 tag（rc）不存在时 line 为 null', summary.line, null);
const sameLine = summariseVersions('0.2.0-rc.2', { latest: '0.2.0-rc.2', rc: '0.2.0-rc.3' });
equal('summariseVersions: 同线 tag 有值就给出 line', JSON.stringify(sameLine.line), JSON.stringify({ tag: 'rc', version: '0.2.0-rc.3' }));
const upToDate = summariseVersions('0.2.0-rc.2', { latest: '0.2.0-rc.2' });
equal('summariseVersions: 已是最新时 newer=null', upToDate.newer, null);
equal('summariseVersions: 已是最新时 upToDate=true', upToDate.upToDate, true);
check('summariseVersions: 当前版本坏数据时不硬下结论', summariseVersions('garbage', REAL_TAGS).comparable === false);

let fetchCount = 0;
let versionClock = 1_000_000;
const fakeFetch = async () => {
	fetchCount += 1;
	return { ok: true, status: 200, json: async () => REAL_TAGS };
};
const checker = createVersionChecker({
	fetchImpl: fakeFetch,
	now: () => versionClock,
	ttlMs: VERSION_TTL_MS,
	env: { [DSH_VERSION_ENV]: '0.2.0-rc.2' },
	resolveCurrent: () => ({ version: '0.2.0-rc.2', source: 'env', path: null, name: DSH_PACKAGE })
});
const first = await checker.get();
equal('checker: 首次查询打了一次 registry', fetchCount, 1);
equal('checker: 报出 current', first.current, '0.2.0-rc.2');
check('checker: 报出有更新（alpha 通道）', first.newer !== null && first.newer.tag === 'alpha');
await checker.get();
equal('checker: TTL 内不再打 registry（缓存生效）', fetchCount, 1);
versionClock += VERSION_TTL_MS + 1;
await checker.get();
equal('checker: 过期后重新查询', fetchCount, 2);
await checker.get({ refresh: true });
equal('checker: refresh=1 强制重查', fetchCount, 3);

const failing = createVersionChecker({
	fetchImpl: async () => {
		throw new Error('network down');
	},
	now: () => versionClock,
	env: {},
	resolveCurrent: () => ({ version: '0.2.0-rc.2', source: 'env', path: null, name: DSH_PACKAGE })
});
const failedOnce = await failing.get();
check('checker: 查询失败记录 error', typeof failedOnce.error === 'string' && failedOnce.error.includes('network down'));
equal('checker: 失败时不给假的 tags', failedOnce.tags.length, 0);
const flaky = createVersionChecker({
	fetchImpl: (() => {
		let call = 0;
		return async () => {
			call += 1;
			if (call === 1) return { ok: true, status: 200, json: async () => REAL_TAGS };
			throw new Error('flaky');
		};
	})(),
	now: () => versionClock,
	env: {},
	resolveCurrent: () => ({ version: '0.2.0-rc.2', source: 'env', path: null, name: DSH_PACKAGE })
});
await flaky.get();
const keptGood = await flaky.get({ refresh: true });
check('checker: 一次网络抖动不抹掉上次成功结论', keptGood.tags.length === 3 && keptGood.newer !== null);
check('checker: 但会把 error 记上', typeof keptGood.error === 'string' && keptGood.error.includes('flaky'));

// #region 12. 机器名字（清洗 / 路径 / 存取）

equal('sanitizeMachineName: 去首尾空白', sanitizeMachineName('  小钢炮  '), '小钢炮');
equal('sanitizeMachineName: 折叠内部空白', sanitizeMachineName('a   b\tc'), 'a b c');
equal('sanitizeMachineName: 换行与控制字符换成空格', sanitizeMachineName('a\nb\u0000c'), 'a b c');
equal('sanitizeMachineName: 空串＝清除', sanitizeMachineName('   '), '');
equal('sanitizeMachineName: 非字符串 → null（调用方回 400）', sanitizeMachineName(42), null);
equal('sanitizeMachineName: 超长截断到上限', sanitizeMachineName('x'.repeat(MACHINE_NAME_MAX + 20)).length, MACHINE_NAME_MAX);
check('sanitizeMachineName: 上限是 64', MACHINE_NAME_MAX === 64);

equal('stateFilePath: 跟随 DSH_HOME', stateFilePath({ env: { DSH_HOME: '/tmp/dshhome' } }), '/tmp/dshhome/' + STATE_FILE);
equal('stateFilePath: DSH_HOME 为空时退到 ~/.dsh', stateFilePath({ env: {}, home: '/home/someone' }), '/home/someone/.dsh/' + STATE_FILE);

/** 假 fs：一个内存文件表，够 store 用（exists/read/write/rename/mkdir）。 */
function memoryFs(initial = {}) {
	const files = new Map(Object.entries(initial));
	return {
		files,
		existsSync: (file) => files.has(file),
		readFileSync: (file) => {
			if (!files.has(file)) throw Object.assign(new Error('ENOENT: ' + file), { code: 'ENOENT' });
			return files.get(file);
		},
		writeFileSync: (file, data) => {
			files.set(file, String(data));
		},
		renameSync: (from, to) => {
			if (!files.has(from)) throw Object.assign(new Error('ENOENT: ' + from), { code: 'ENOENT' });
			files.set(to, files.get(from));
			files.delete(from);
		},
		mkdirSync: () => {}
	};
}

const emptyFs = memoryFs();
const freshStore = createMachineStore({ env: {}, file: '/state/' + STATE_FILE, fs: emptyFs });
equal('store: 文件不存在时名字为空', freshStore.read().name, '');
equal('store: 文件不存在不算错误', freshStore.read().error, null);
const written = freshStore.write('  工作机  ');
check('store: 写入成功', written.ok === true && written.name === '工作机');
equal('store: 写入后能读回（清洗过）', freshStore.read().name, '工作机');
check('store: 写入走临时文件 + rename（落盘的是正式文件）', emptyFs.files.has('/state/' + STATE_FILE)
	&& !emptyFs.files.has('/state/' + STATE_FILE + '.tmp'));
equal('store: 落盘 JSON 里是 machineName 键', JSON.parse(emptyFs.files.get('/state/' + STATE_FILE)).machineName, '工作机');
check('store: name() 走进程内缓存', freshStore.name() === '工作机');
const cleared = freshStore.write('');
check('store: 空串清除', cleared.ok === true && cleared.name === '');
equal('store: 清除后读回为空', freshStore.read().name, '');

const badJsonFs = memoryFs({ ['/state/' + STATE_FILE]: '{not json' });
const badJsonStore = createMachineStore({ env: {}, file: '/state/' + STATE_FILE, fs: badJsonFs });
equal('store: 坏 JSON 退回空名字', badJsonStore.read().name, '');
check('store: 坏 JSON 记 error（不抛）', typeof badJsonStore.read().error === 'string');

const wrongTypeFs = memoryFs({ ['/state/' + STATE_FILE]: JSON.stringify({ machineName: 123 }) });
const wrongTypeStore = createMachineStore({ env: {}, file: '/state/' + STATE_FILE, fs: wrongTypeFs });
equal('store: machineName 非字符串时按空名字处理', wrongTypeStore.read().name, '');
check('store: 并说明原因', String(wrongTypeStore.read().error).includes('不是字符串'));

const keepFs = memoryFs({ ['/state/' + STATE_FILE]: JSON.stringify({ machineName: '旧名', other: 'keep-me' }) });
const keepStore = createMachineStore({ env: {}, file: '/state/' + STATE_FILE, fs: keepFs });
keepStore.write('新名');
const kept = JSON.parse(keepFs.files.get('/state/' + STATE_FILE));
check('store: 写名字不丢同文件里的其它键', kept.other === 'keep-me' && kept.machineName === '新名');

const brokenFs = memoryFs();
brokenFs.writeFileSync = () => {
	throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' });
};
const brokenStore = createMachineStore({ env: {}, file: '/state/' + STATE_FILE, fs: brokenFs });
const brokenResult = brokenStore.write('x');
check('store: 写失败返回 write-failed 而不是抛', brokenResult.ok === false && brokenResult.code === 'write-failed');
check('store: 写失败带原因', String(brokenResult.message).includes('EROFS'));

equal('store: 非字符串写入被拒', createMachineStore({ env: {}, file: '/s', fs: memoryFs() }).write(undefined).code, 'bad-request');

// —— 一个文件两个键：写名字不能抹掉开关，反之亦然（共用同一套 read-modify-write）——
const twoKeyFs = memoryFs();
const twoKeyStore = createMachineStore({ env: {}, file: '/state/' + STATE_FILE, fs: twoKeyFs });
twoKeyStore.write('客厅机');
twoKeyStore.writeAgentTools(false);
twoKeyStore.write('书房机');
equal('store: 改名字后开关仍是关', twoKeyStore.read().agentTools, false);
equal('store: 改名字后名字是新值', twoKeyStore.read().name, '书房机');
twoKeyStore.writeAgentTools(true);
equal('store: 改开关后名字没被抹掉', twoKeyStore.read().name, '书房机');
check('store: 落盘 JSON 里两个键都在', (() => {
	const row = JSON.parse(twoKeyFs.files.get('/state/' + STATE_FILE));
	return row.machineName === '书房机' && row.agentTools === true;
})());
// 开关只认布尔：文件里写了别的类型 → 按缺省（开）并记 error，不猜「1」=开
const badFlagFs = memoryFs({ ['/state/' + STATE_FILE]: JSON.stringify({ machineName: 'x', agentTools: 'false' }) });
const badFlagStore = createMachineStore({ env: {}, file: '/state/' + STATE_FILE, fs: badFlagFs });
equal('store: agentTools 非布尔时按缺省（开）', badFlagStore.read().agentTools, true);
check('store: agentTools 类型不对要说明原因', String(badFlagStore.read().error).includes('不是布尔值'));
equal('store: writeAgentTools 非布尔 → bad-request', createMachineStore({ env: {}, file: '/s', fs: memoryFs() }).writeAgentTools('nope').code, 'bad-request');
equal('store: 文件里没有 agentTools 键时用缺省（开）', createMachineStore({ env: {}, file: '/s', fs: memoryFs({ '/s': '{}' }) }).read().agentTools, AGENT_TOOLS_DEFAULT);
check('缺省值是开（不改既有行为：0.3.0 起工具一直注册着）', AGENT_TOOLS_DEFAULT === true);

// #endregion

// #region 13. 重启工具是否开放给 agent（网关注册 / 即时注销 / 路由契约）

deepEqual('describeAgentTools: 一致（开 + 已注册）', describeAgentTools({ agentTools: true, agentToolsExposed: true, agentToolsNames: ['a', 'b', 'c'] }), 'on（3 个已注册）');
equal('describeAgentTools: 一致（关 + 未注册）', describeAgentTools({ agentTools: false, agentToolsExposed: false }), 'off（模型看不到这些工具）');
check('describeAgentTools: 网关没挂上时报未知（不猜）', describeAgentTools({ agentTools: true, agentToolsExposed: null }).includes('未知'));
check('describeAgentTools: 开了却没注册上 → 明确说不一致', (() => {
	const line = describeAgentTools({ agentTools: true, agentToolsExposed: false, agentToolsError: 'dup name' });
	return line.includes('不一致') && line.includes('dup name');
})());
check('describeAgentTools: 关着却还挂着 → 也说不一致', describeAgentTools({ agentTools: false, agentToolsExposed: true, agentToolsNames: ['x'] }).includes('不一致'));

// —— 完整闭环：假 fs + 假 ctx，开关关掉后工具真的从表里消失，打开又回来 ——
{
	const gateFs = memoryFs({ ['/state/' + STATE_FILE]: JSON.stringify({ machineName: '网关机' }) });
	const gateStore = createMachineStore({ env: {}, file: '/state/' + STATE_FILE, fs: gateFs });
	const gateCtx = fakeHostCtx({ running: [] });
	const gateControl = createRestartControl(gateCtx.ctx, { machine: gateStore });
	const gate = createToolGate(gateCtx.ctx, gateControl);
	gateControl.attachToolGate(gate);
	equal('网关: 缺省开放 → sync 后已注册', gate.sync(), true);
	equal('网关: 三个工具都在表里', gateCtx.tools.size, 3);
	check('网关: view.exposed 反映真实注册状态', gate.view.exposed === true);
	equal('网关: 状态快照也报已注册', gateControl.status().agentToolsExposed, true);

	// 关掉：即时注销，不重启
	const off = gateControl.setAgentTools(false);
	check('网关: 关掉返回 ok', off.ok === true && off.enabled === false);
	equal('网关: 关掉后工具表是空的', gateCtx.tools.size, 0);
	equal('网关: 状态快照报未注册', gateControl.status().agentToolsExposed, false);
	check('网关: 关掉时落盘写了 agentTools:false', JSON.parse(gateFs.files.get('/state/' + STATE_FILE)).agentTools === false);
	check('网关: 关掉时机器名字没被抹掉', JSON.parse(gateFs.files.get('/state/' + STATE_FILE)).machineName === '网关机');

	// 再打开：同名可以重新注册（NamedEntries 是按名增删）
	gateControl.setAgentTools(true);
	equal('网关: 再打开又注册回三个', gateCtx.tools.size, 3);
	equal('网关: 重复 sync 不重复注册', (gate.sync(), gateCtx.tools.size), 3);
	gate.dispose();
	equal('网关: dispose 注销干净', gateCtx.tools.size, 0);
	for (const disposer of gateCtx.disposers) disposer();
}

// —— 路由契约：GET 读 / POST 写 / 非布尔 400 / 非 GET-POST 405 ——
{
	const apiFs = memoryFs();
	const apiStore = createMachineStore({ env: {}, file: '/state/' + STATE_FILE, fs: apiFs });
	const apiCtx = fakeHostCtx({ running: [] });
	const apiControl = createRestartControl(apiCtx.ctx, { machine: apiStore });
	const apiGate = createToolGate(apiCtx.ctx, apiControl);
	apiControl.attachToolGate(apiGate);
	apiGate.sync();
	registerRoutes(apiCtx.ctx, apiControl, { get: async () => ({ current: '0' }) });
	const got = await callRoute(apiCtx.routes, ROUTE_AGENT_TOOLS);
	equal('route agent-tools: GET 200', got.statusCode, 200);
	const gotPayload = JSON.parse(got.body);
	check('route agent-tools: GET 带 enabled/exposed/names', gotPayload.enabled === true && gotPayload.exposed === true
		&& Array.isArray(gotPayload.names) && gotPayload.names.length === 3);
	const turned = await callRoute(apiCtx.routes, ROUTE_AGENT_TOOLS, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: '{"enabled":false}'
	});
	equal('route agent-tools: POST false → 200', turned.statusCode, 200);
	check('route agent-tools: POST 之后确实注销了', apiCtx.tools.size === 0 && JSON.parse(turned.body).exposed === false);
	const turnedBack = await callRoute(apiCtx.routes, ROUTE_AGENT_TOOLS, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: '{"enabled":true}'
	});
	equal('route agent-tools: POST true 又挂回来', JSON.parse(turnedBack.body).exposed, true);
	const badFlag = await callRoute(apiCtx.routes, ROUTE_AGENT_TOOLS, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: '{"enabled":"false"}'
	});
	equal('route agent-tools: 非布尔 → 400（不猜字符串）', badFlag.statusCode, 400);
	equal('route agent-tools: 缺字段 → 400', JSON.parse(badFlag.body).code, 'bad-request');
	equal('route agent-tools: 非 GET/POST → 405', (await callRoute(apiCtx.routes, ROUTE_AGENT_TOOLS, { method: 'PUT' })).statusCode, 405);
	const statusAfter = JSON.parse((await callRoute(apiCtx.routes, ROUTE_STATUS)).body);
	check('route status: 带 agentTools 四个字段', statusAfter.agentTools === true && statusAfter.agentToolsExposed === true
		&& Array.isArray(statusAfter.agentToolsNames) && statusAfter.agentToolsError === null);

// README 的协议表里抄了一份 status 字段清单 —— 那是最容易漂的文档，用断言钉住：
// 表里列出的字段必须与 status() 真实产出的字段**完全一致**（不多不少）。
{
	const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
	const row = readme.split('\n').find((line) => line.startsWith('| `/setting-pro/status` |'));
	check('README: 协议表里有 /status 那一行', typeof row === 'string');
	const declared = row !== undefined
		? topLevelFields(row)
		: [];
	const actual = Object.keys(snapshot);
	const missing = actual.filter((name) => !declared.includes(name.replace(/\[\]$/u, '')));
	const extra = declared.filter((name) => !actual.includes(name.replace(/\[\]$/u, '')));
	check('README: status 字段清单与代码一致（不缺字段）', missing.length === 0, missing.join(', '));
	check('README: status 字段清单与代码一致（不多写已删字段）', extra.length === 0, extra.join(', '));
	check('README: status 清单条数合理（防解析失效）', declared.length >= 20, String(declared.length));
}
	// 状态里的 agentTools（开关值）与 agentToolsExposed（实际注册）必须分开报：
	// 「开了但没挂上」是真实可能（撞工具名），抹平成一致就是假回执。
	const skewed = JSON.parse((await callRoute(apiCtx.routes, ROUTE_STATUS)).body);
	check('route status: 两个字段都存在且类型正确', typeof skewed.agentTools === 'boolean' && typeof skewed.agentToolsExposed === 'boolean');
	check('route status: agentToolsError 正常时是 null', skewed.agentToolsError === null);
	check('route status: agentToolsNames 就是三个工具名', Array.isArray(skewed.agentToolsNames) && skewed.agentToolsNames.length === 3);

	for (const disposer of apiCtx.disposers) disposer();
}

// apply 这一层：开关是关的 → 一个工具都不注册（不是「注册完再撤」）。
// 用仓库里的临时 .probe-tmp 当 DSH_HOME（apply 内部会读它），用完删；不碰 ~/.dsh 的真文件。
{
	const tmpDir = fileURLToPath(new URL('./.probe-tmp/', import.meta.url));
	mkdirSync(tmpDir, { recursive: true });
	const savedHome = process.env.DSH_HOME;
	process.env.DSH_HOME = tmpDir;

	writeFileSync(tmpDir + '/' + STATE_FILE, JSON.stringify({ agentTools: false }), 'utf8');
	const offCtx = fakeHostCtx({ running: [] });
	apply(offCtx.ctx);
	equal('apply: 开关是关的 → 一个工具都不注册', offCtx.tools.size, 0);
	for (const disposer of offCtx.disposers) disposer();

	writeFileSync(tmpDir + '/' + STATE_FILE, JSON.stringify({ machineName: '默认' }), 'utf8');
	const onCtx = fakeHostCtx({ running: [] });
	apply(onCtx.ctx);
	equal('apply: 文件里没这个键 → 按缺省注册三个（不改既有行为）', onCtx.tools.size, 3);
	for (const disposer of onCtx.disposers) disposer();

	rmSync(tmpDir, { recursive: true, force: true });
	if (savedHome === undefined) delete process.env.DSH_HOME;
	else process.env.DSH_HOME = savedHome;
	equal('清理: 临时 DSH_HOME 已删掉', existsSync(tmpDir), false);
}

// 「开了但注册不上」的端到端：让假 tools 抛（撞名），apply 不能崩，状态要如实报不一致。
{
	const tmpDir = fileURLToPath(new URL('./.probe-tmp/', import.meta.url));
	mkdirSync(tmpDir, { recursive: true });
	const savedHome = process.env.DSH_HOME;
	process.env.DSH_HOME = tmpDir;
	writeFileSync(tmpDir + '/' + STATE_FILE, JSON.stringify({ agentTools: true }), 'utf8');
	const crashCtx = fakeHostCtx({ running: [] });
	crashCtx.ctx.tools = {
		register: () => {
			throw new Error('tool "dsh_restart_status" is already registered');
		}
	};
	let survived = true;
	try {
		apply(crashCtx.ctx);
	} catch (error) {
		survived = false;
	}
	check('apply: 工具注册抛错不把插件带崩（别的插件还能装）', survived === true);
	equal('apply: 崩的那次一个工具都没挂上', crashCtx.tools.size, 0);
	const crashed = JSON.parse((await callRoute(crashCtx.routes, ROUTE_STATUS)).body);
	check('apply: 开关开着但没挂上 → 状态如实报不一致', crashed.agentTools === true && crashed.agentToolsExposed === false);
	check('apply: 不一致时带出真实原因', String(crashed.agentToolsError).includes('already registered'));
	for (const disposer of crashCtx.disposers) disposer();
	rmSync(tmpDir, { recursive: true, force: true });
	if (savedHome === undefined) delete process.env.DSH_HOME;
	else process.env.DSH_HOME = savedHome;
}

check('index.js: 工具名单只有一处（网关 view.names 直接引用 TOOL_NAMES）', /names: TOOL_NAMES/.test(host));


// #endregion

// #region 14. 「性能与用量」那一行：供应商 · 模型 · 思考档位

const { describeModelState, selectionOfProjection, modelPillStore, MODEL_RETRY_STEPS, agentToolsSummary, agentToolsClass } = clientModule.probe;

/** 探针用的名字回调（与组件里那份同形，zh 直接取字典）。 */
const pillNames = (locale = 'zh') => {
	const table = dict[locale];
	return {
		provider: (id, catalogName) => (id === 'deepseek-account' ? table.pillProviderAccount : catalogName),
		effortDefault: () => table.pillEffortDefault,
		providerLine: () => table.pillProvider,
		modelLine: () => table.pillModel,
		effortLine: () => table.pillEffort,
		valueSep: () => table.pillValueSep,
		sourceRaw: () => table.pillSourceRaw,
		noEffort: () => table.pillNoEffort
	};
};

/** 官方目录快照的形状（`{current, groups, retainedEffort}`）。 */
const catalogState = (overrides = {}) => ({
	current: { provider: 'bailian', model: 'qwen3-max', reasoningEffort: 'high' },
	groups: [{
		id: 'bailian',
		name: '阿里云百炼',
		models: [{
			id: 'qwen3-max',
			name: 'Qwen3 Max',
			reasoning: { efforts: [{ id: 'high', name: '高' }, { id: 'low', name: '低' }], defaultEffort: 'low' }
		}]
	}],
	...overrides
});

const full = describeModelState(catalogState(), null, pillNames());
deepEqual('模型格: 三段 = 供应商 · 模型 · 档位', full.segments.map((segment) => segment.text), ['阿里云百炼', 'Qwen3 Max', '高']);
deepEqual('模型格: 悬停三行带内部 id', full.hover.split('\n'), [
	'供应商：阿里云百炼（bailian）',
	'模型：Qwen3 Max（qwen3-max）',
	'思考档位：高（high）'
]);
equal('模型格: 目录命中时不标「内部 id」', full.usingIds, false);

const account = describeModelState(catalogState({
	current: { provider: 'deepseek-account', model: 'd1', reasoningEffort: 'high' }
}), null, pillNames());
equal('模型格: deepseek-account 用本地化供应商名', account.segments[0].text, 'DeepSeek 账号');

// 档位没选：落到目录里的 defaultEffort（官方 trigger 同一条判据）
const defaulted = describeModelState({
	...catalogState(), current: { provider: 'bailian', model: 'qwen3-max' }
}, null, pillNames());
equal('模型格: 未显式选档位时显示目录默认档', defaulted.segments[2].text, '低');

// 档位 id 在目录里查不到：如实显示 id，不编一个中文名
const unknownEffort = describeModelState({
	...catalogState(), current: { provider: 'bailian', model: 'qwen3-max', reasoningEffort: 'ultra' }
}, null, pillNames());
equal('模型格: 目录里没有的档位 id 原样显示', unknownEffort.segments[2].text, 'ultra');

// 模型没有 reasoning：档位取目录的 retainedEffort，并说明「没有可选档位」
const noReasoning = describeModelState({
	current: { provider: 'p', model: 'm' },
	groups: [{ id: 'p', name: 'P', models: [{ id: 'm', name: 'M' }] }],
	retainedEffort: 'remembered'
}, null, pillNames());
deepEqual('模型格: 无 reasoning 时用 retainedEffort', noReasoning.segments.map((segment) => segment.text), ['P', 'M', 'remembered']);
check('模型格: 无 reasoning 时悬停说明「没有可选档位」', noReasoning.hover.includes(dict.zh.pillNoEffort));

// 目录还没加载（state 为 null）：退到会话投影，显示内部 id，并且**如实说明**
const projectedOnly = describeModelState(null, { provider: 'p1', model: 'm2' }, pillNames());
deepEqual('模型格: 投影退路显示 provider/model', projectedOnly.segments.map((segment) => segment.text), ['p1', 'p1/m2']);
equal('模型格: 投影退路标为「内部 id」', projectedOnly.usingIds, true);
check('模型格: 投影退路悬停说明来源', projectedOnly.hover.includes(dict.zh.pillSourceRaw));

equal('模型格: 什么都不知道时不画', describeModelState(null, null, pillNames()), null);
equal('模型格: current 为空对象时不画', describeModelState({ current: null, groups: [] }, null, pillNames()), null);
equal('模型格: 坏输入不抛', describeModelState('nonsense', 42, pillNames()), null);

deepEqual('模型格: 投影取 next 优先', selectionOfProjection({ next: { provider: 'a', model: 'b' }, lastUsed: { provider: 'c', model: 'd' } }), { provider: 'a', model: 'b' });
deepEqual('模型格: next 为空时退 lastUsed', selectionOfProjection({ next: null, lastUsed: { provider: 'c', model: 'd', reasoningEffort: 'low' } }), { provider: 'c', model: 'd', reasoningEffort: 'low' });
equal('模型格: 投影缺失返回 null', selectionOfProjection(undefined), null);

// —— 挂载形状：list 槽里用我们自己的 id，不顶掉官方那条 ——
const dockEntry = fakeSlots.registrations.find((entry) => entry.options.name === 'conversation.composer.dock') ?? null;
check('模型格: 挂到了 conversation.composer.dock', dockEntry !== null);
equal('模型格: 用的是自己的 id（不覆盖官方 stats）', dockEntry === null ? null : dockEntry.options.id, 'model-usage');
check('模型格: 没有复用官方 id stats', dockEntry !== null && dockEntry.options.id !== 'stats');
equal('模型格: 排在官方那条之后', dockEntry === null ? null : dockEntry.options.order, 1);
check('模型格: 注册未抢 priority（并列共存，不是顶替）', dockEntry !== null && dockEntry.options.priority === undefined);
check('模型格: 重试有上限（不永久轮询官方内部服务）', Array.isArray(MODEL_RETRY_STEPS) && MODEL_RETRY_STEPS.length > 0 && MODEL_RETRY_STEPS.length <= 8);

/** 渲染 dock 那格一次，返回新增的文本。 */
function renderDock(entry, props) {
	const before = texts.length;
	renderNode(entry.component({ ...entry.options.inject('sess-1'), ...props }));
	return texts.slice(before).filter((text) => text !== '·');
}

// ctx.get 在这次 apply 的假 ctx 里没提供（= 服务不可用）→ 只有投影时也能渲染出内部 id
const dockProps = { useProjection: (key) => (key === 'modelSelection' ? { next: { provider: 'pv', model: 'md' } } : undefined) };
deepEqual('模型格: 无目录服务时用投影渲染内部 id 对', renderDock(dockEntry, dockProps), ['pv', 'pv/md']);
deepEqual('模型格: 投影也没有时整格不画', renderDock(dockEntry, { useProjection: () => undefined }), []);

// 开关：store 落盘 + 关掉后那一格**真的不渲染**（假 React 的 useState 在直接调用组件时
// 现场读 store，所以改完 store 再渲染一次就能看到效果）。
modelPillStore.set(false);
equal('模型格: 关掉的偏好写进 localStorage', storage.get('dsh.setting-pro.modelPill'), '0');
check('模型格: 关掉后读回来是 false', modelPillStore.get() === false);
deepEqual('模型格: 关掉后整格不渲染（那一行只剩官方内容）', renderDock(dockEntry, dockProps), []);
modelPillStore.set(true);
equal('模型格: 重新打开也落盘', storage.get('dsh.setting-pro.modelPill'), '1');
deepEqual('模型格: 重新打开后又出现', renderDock(dockEntry, dockProps), ['pv', 'pv/md']);
check('模型格: 默认开（localStorage 空时读回 true）', (() => {
	storage.delete('dsh.setting-pro.modelPill');
	// 重新物化一次模块：只有模块初始化才会重跑「读 localStorage 取默认值」那段。
	const fresh = clientDefinition.factory((spec) => (spec === 'react' ? fakeReact : (() => { throw new Error('unexpected require'); })()));
	return fresh.probe.modelPillStore.get() === true;
})());
check('模型格: 上次的选择会被读回来（默认值真的看 localStorage，不是恒为开）', (() => {
	storage.set('dsh.setting-pro.modelPill', '0');
	const fresh = clientDefinition.factory((spec) => (spec === 'react' ? fakeReact : (() => { throw new Error('unexpected require'); })()));
	return fresh.probe.modelPillStore.get() === false;
})());
storage.delete('dsh.setting-pro.modelPill');

// 目录服务可用那条路：假 service → directoryFor → store
{
	const snapshot = catalogState();
	const dirs = {
		directoryFor: () => ({
			store: { getSnapshot: () => snapshot, subscribe: () => () => {} },
			load: () => Promise.resolve()
		})
	};
	const secondDisposers = [];
	const secondSlots = createFakeSlots();
	clientModule.apply({
		get: (name) => (name === 'modelDirectories' ? dirs : undefined),
		effect: (fn) => {
			const disposer = fn();
			if (typeof disposer === 'function') secondDisposers.push(disposer);
			return disposer;
		},
		locale: { register: () => () => {}, bind: () => (key) => (dict.zh[key] ?? 'MISSING:' + key) },
		slots: secondSlots
	});
	const dock2 = secondSlots.registrations.find((entry) => entry.options.name === 'conversation.composer.dock');
	deepEqual('模型格: 目录可用时显示人类可读名',
		renderDock(dock2, { useProjection: () => undefined }), ['阿里云百炼', 'Qwen3 Max', '高']);

	// directoryFor 抛（session 未装配）不能把整格炸掉：退回投影
	const throwing = { directoryFor: () => { throw new Error('resolved no scope'); } };
	const thirdDisposers = [];
	const thirdSlots = createFakeSlots();
	clientModule.apply({
		get: () => throwing,
		effect: (fn) => {
			const disposer = fn();
			if (typeof disposer === 'function') thirdDisposers.push(disposer);
			return disposer;
		},
		locale: { register: () => () => {}, bind: () => (key) => (dict.zh[key] ?? 'MISSING:' + key) },
		slots: thirdSlots
	});
	const dock3 = thirdSlots.registrations.find((entry) => entry.options.name === 'conversation.composer.dock');
	deepEqual('模型格: directoryFor 抛错时不炸，退回投影',
		renderDock(dock3, { useProjection: (key) => (key === 'modelSelection' ? { next: { provider: 'zz', model: 'mm' } } : undefined) }),
		['zz', 'zz/mm']);
	for (const disposer of secondDisposers) disposer();
	for (const disposer of thirdDisposers) disposer();
}

// 纯文案防护：这一格绝不把任何文本当 HTML
check('模型格: 只用 createElement（不碰 innerHTML）', !clientSource.includes('innerHTML'));

// —— 界面那行：把「开关值」与「实际注册」分开说（客户端侧）——
const zhTools = dict.zh;
const tTools = (key) => zhTools[key];
equal('界面: 一致（开 + 已注册）', agentToolsSummary({ agentTools: true, agentToolsExposed: true, agentToolsNames: ['a', 'b', 'c'] }, tTools),
	zhTools.agentToolsOn + '（3）');
equal('界面: 一致（关 + 未注册）', agentToolsSummary({ agentTools: false, agentToolsExposed: false, agentToolsNames: [] }, tTools), zhTools.agentToolsOff);
equal('界面: 还没读到状态 → 说不知道（不是「未开放」）', agentToolsSummary(null, tTools), zhTools.agentToolsUnknown);
equal('界面: Host 半边没加载也说不知道', agentToolsSummary({ missing: true }, tTools), zhTools.agentToolsUnknown);
equal('界面: 老 Host 没这字段 → 不知道（不猜）', agentToolsSummary({ agentTools: undefined, agentToolsExposed: undefined }, tTools), zhTools.agentToolsUnknown);
check('界面: 开关与实际不一致时明确说没生效', (() => {
	const line = agentToolsSummary({ agentTools: true, agentToolsExposed: false, agentToolsError: 'dup name' }, tTools);
	return line === zhTools.agentToolsSkew + '：dup name';
})());
equal('界面: 不一致那行用错误色', agentToolsClass({ agentTools: true, agentToolsExposed: false }), 'dspro_error');
equal('界面: 一致那行用说明色', agentToolsClass({ agentTools: true, agentToolsExposed: true }), 'dspro_note');
equal('界面: 未知那行也用说明色（不吓唬人）', agentToolsClass(null), 'dspro_note');
// 复选框的勾选必须来自 /status 里的开关值。假 React 的 useState 只取初始值（status 恒为 null），
// checked 又不是文本，渲染层测不到这条绑定 —— 用源码断言钉住（和「排程按钮不再被禁用」同一种写法）。
check('界面: 复选框勾选状态读 /status 的 agentTools（不是常量、不是本地副本）',
	/checked: status !== null && status\.agentTools === true,/u.test(clientSource));
check('界面: 开关改动走 POST /setting-pro/agent-tools', clientSource.includes("opsPost(AGENT_TOOLS_URL, { enabled })"));

// 两半的 URL 字面必须一致（客户端拼的是路径串，改一边就得 404/SPA 兜底）
for (const [route, name] of [[ROUTE_AGENT_TOOLS, 'agent-tools'], [ROUTE_MACHINE, 'machine'], [ROUTE_VERSION, 'version']]) {
	check('两半 URL 一致: ' + name, clientSource.includes("'" + route + "'"), 'client.js 里没有 ' + route);
}


// —— 挂不上的那条路：声明时刻回调抛错，必须被我们兜住（官方通知循环不隔离异常）——
{
	const lateSlots = createFakeSlots({ deferInject: true, failDock: true });
	const lateDisposers = [];
	const lateModule = clientDefinition.factory((spec) => (spec === 'react' ? fakeReact : (() => { throw new Error('unexpected require'); })()));
	lateModule.apply({
		effect: (fn) => {
			const disposer = fn();
			if (typeof disposer === 'function') lateDisposers.push(disposer);
			return disposer;
		},
		locale: { register: () => () => {}, bind: () => (key) => (dict.zh[key] ?? 'MISSING:' + key) },
		slots: lateSlots
	});
	// inject 此刻还没跑（槽位未声明）：没挂上、也没报错
	check('模型格: 槽位未声明时先不挂（等声明）', lateModule.probe.modelPillState.mounted === false);
	const escaped = lateSlots.declare();
	check('模型格: 注册抛错时**没有**冒回槽位的通知循环（不连累别的插件）', escaped === null, String(escaped && escaped.message));
	check('模型格: 挂不上时 mounted 仍为 false', lateModule.probe.modelPillState.mounted === false);
	check('模型格: 挂不上时记下真实原因（设置页要显示它）', String(lateModule.probe.modelPillState.reason).includes('not declared'), lateModule.probe.modelPillState.reason);
	for (const disposer of lateDisposers) disposer();
}

// #endregion

if (failures.length > 0) {
	console.error('probe: ' + String(failures.length) + ' 项失败 / ' + String(passed + failures.length) + ' 项\n');
	for (const failure of failures) console.error('  ✗ ' + failure);
	process.exitCode = 1;
} else {
	console.log('probe: 全部通过（' + String(passed) + ' 项）');
}
