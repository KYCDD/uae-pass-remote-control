/**
 * A real Chrome for the desktop surface, plus a tap on its network traffic.
 *
 * The desktop surface exists because the UAE Pass sign-in flags a Chrome driven
 * by Puppeteer. But the Growth session lives in request headers and JSON request
 * bodies, which pixels will never show, so the desktop surface still needs some
 * way to read traffic. This is that way, kept as small as it can be:
 *
 *  - Chrome is started as a plain process, not through Puppeteer: no
 *    `--enable-automation`, no automation infobar, no `navigator.webdriver`. It
 *    gets its own profile (per credential alias, so a sign-in persists across
 *    runs) and a debugging port on 127.0.0.1. Chrome refuses a debugging port
 *    on its default profile, which is why the profile is a separate one.
 *  - Nothing attaches while the sign-in happens. The port is open, but no
 *    session exists until the model calls `start_recording` after it has
 *    signed in.
 *  - Even then, only the Network domain is enabled, on each tab. Not Runtime,
 *    not Page, no script injection: the page has nothing to observe. (Enabling
 *    Runtime is how a page usually spots a CDP client; Puppeteer always does
 *    it, and this never does.)
 *
 * Chrome is left running when a run ends, so the next task (or the next prompt)
 * finds the same window and the same session. The recorder is detached.
 *
 * Note the port: any process on this machine can drive a Chrome that has one
 * open, including its signed-in session. It binds to 127.0.0.1 only.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { NetworkLog } from './NetworkLog.js';

/** Where Chrome usually is on Windows, tried in order when no path is configured. */
const CHROME_CANDIDATES = [
	join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
	join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
	join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
];

const LAUNCH_TIMEOUT_MS = 20000;
const CALL_TIMEOUT_MS = 15000;

/** Request bodies above this are truncated, matching NetworkLog. */
const MAX_POST_DATA_BYTES = 262144;

export class ChromeTapError extends Error {
	constructor(message) {
		super(message);
		this.name = 'ChromeTapError';
	}
}

export class ChromeTap {
	/**
	 * @param {object} options
	 * @param {string} options.profileDir The user-data-dir for this Chrome.
	 * @param {number} [options.port]
	 * @param {string|null} [options.chromePath]
	 * @param {string|null} [options.startUrl] Opened when Chrome is launched (not when reused).
	 */
	constructor({ profileDir, port = 9333, chromePath = null, startUrl = null }) {
		this.profileDir = profileDir;
		this.port = port;
		this.chromePath = chromePath;
		this.startUrl = startUrl && /^https?:/i.test(startUrl) ? startUrl : null;

		/** @type {NetworkLog|null} */
		this.log = null;
		this.connection = null;
	}

	get endpoint() {
		return `http://127.0.0.1:${this.port}`;
	}

	/**
	 * Makes sure the Chrome is up: reuses one already listening on the port, or
	 * starts one.
	 *
	 * @returns {Promise<{launched: boolean}>}
	 */
	async ensureRunning() {
		if (await this.version()) {
			return { launched: false };
		}

		const binary = this.chromePath || CHROME_CANDIDATES.find((candidate) => existsSync(candidate));

		if (!binary) {
			throw new ChromeTapError('Chrome was not found. Set REMOTE_AGENT_CHROME_PATH to chrome.exe.');
		}

		mkdirSync(this.profileDir, { recursive: true });

		const args = [
			`--user-data-dir=${this.profileDir}`,
			`--remote-debugging-port=${this.port}`,
			'--no-first-run',
			'--no-default-browser-check',
			'--new-window',
			// The agent sees the primary monitor only, whose top-left is always 0,0
			'--window-position=0,0',
			'--start-maximized',
			...(this.startUrl ? [this.startUrl] : []),
		];

		const child = spawn(binary, args, { detached: true, stdio: 'ignore', windowsHide: false });
		child.unref();

		const deadline = Date.now() + LAUNCH_TIMEOUT_MS;

		while (Date.now() < deadline) {
			if (await this.version()) {
				return { launched: true };
			}

			await sleep(300);
		}

		throw new ChromeTapError(
			`Chrome did not open its debugging port ${this.port}. If a Chrome window is already using the profile at ${this.profileDir} without that port, close it and try again.`,
		);
	}

	/**
	 * Whether network traffic is being recorded.
	 */
	get recording() {
		return Boolean(this.log);
	}

	/**
	 * Starts recording every tab's network traffic, existing and new.
	 *
	 * @returns {Promise<{already: boolean, tabs: number}>}
	 */
	async startRecording() {
		if (this.log) {
			return { already: true, tabs: this.connection?.pageSessions.size ?? 0 };
		}

		const version = await this.version();

		if (!version?.webSocketDebuggerUrl) {
			throw new ChromeTapError('The Chrome for this task is not running, so there is nothing to record.');
		}

		const connection = await CdpConnection.open(version.webSocketDebuggerUrl);
		const session = new TabsSession(connection);
		const log = new NetworkLog(null, { session });

		await log.start();
		await session.attachAll();

		this.connection = connection;
		this.log = log;

		return { already: false, tabs: connection.pageSessions.size };
	}

	/**
	 * Stops recording. Chrome keeps running; what was recorded stays readable.
	 */
	async stopRecording() {
		await this.log?.stop();
		this.connection = null;
	}

	/**
	 * Chrome's /json/version, or null when nothing is listening.
	 *
	 * @returns {Promise<object|null>}
	 */
	async version() {
		try {
			const response = await fetch(`${this.endpoint}/json/version`, { signal: AbortSignal.timeout(1500) });
			return response.ok ? await response.json() : null;
		} catch {
			return null;
		}
	}
}

/**
 * The surface NetworkLog expects of a CDP session (send / on / detach), spread
 * over every tab of the browser. Each tab is its own CDP session, and request
 * ids are only unique within one, so they are prefixed with the session id.
 */
class TabsSession {
	/**
	 * @param {CdpConnection} connection
	 */
	constructor(connection) {
		this.connection = connection;
		this.networkParams = null;

		/** @type {Map<string, Function[]>} */
		this.handlers = new Map();

		connection.onEvent = (message) => this.dispatch(message);
	}

	/**
	 * NetworkLog calls send('Network.enable', ...) once; it is applied to every
	 * tab now and to every tab that opens later.
	 */
	async send(method, params = {}) {
		if (method !== 'Network.enable') {
			throw new ChromeTapError(`The network tap does not send ${method}.`);
		}

		this.networkParams = params;
	}

	on(event, handler) {
		if (!this.handlers.has(event)) {
			this.handlers.set(event, []);
		}

		this.handlers.get(event).push(handler);
	}

	async detach() {
		this.connection.close();
	}

	/**
	 * Attaches to the tabs that exist and to any that open from now on (a PDF
	 * export may open one). A new tab is held at its start until its Network
	 * domain is on, so its first requests are not missed.
	 */
	async attachAll() {
		await this.connection.send('Target.setAutoAttach', {
			autoAttach: true,
			waitForDebuggerOnStart: true,
			flatten: true,
		});
	}

	dispatch(message) {
		if (message.method === 'Target.attachedToTarget') {
			this.attached(message.params).catch(() => {});
			return;
		}

		if (message.method === 'Target.detachedFromTarget') {
			this.connection.pageSessions.delete(message.params.sessionId);
			return;
		}

		const handlers = message.sessionId ? this.handlers.get(message.method) : null;

		if (!handlers) {
			return;
		}

		const params = message.params?.requestId
			? { ...message.params, requestId: `${message.sessionId}:${message.params.requestId}` }
			: message.params;

		for (const handler of handlers) {
			handler(params);
		}
	}

	/**
	 * @param {{sessionId: string, targetInfo: {type: string}, waitingForDebugger: boolean}} params
	 */
	async attached({ sessionId, targetInfo, waitingForDebugger }) {
		try {
			if (targetInfo?.type === 'page') {
				this.connection.pageSessions.add(sessionId);
				await this.connection.send('Network.enable', this.networkParams ?? { maxPostDataSize: MAX_POST_DATA_BYTES }, sessionId);
			}
		} finally {
			// Never leave a tab paused, whatever else failed
			if (waitingForDebugger) {
				await this.connection.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
			}
		}
	}
}

/**
 * A minimal CDP client over one WebSocket, using the flattened session protocol.
 */
class CdpConnection {
	/**
	 * @param {string} url
	 * @returns {Promise<CdpConnection>}
	 */
	static async open(url) {
		const Socket = globalThis.WebSocket ?? (await loadWs());
		const socket = new Socket(url);

		await new Promise((resolve, reject) => {
			socket.onopen = () => resolve();
			socket.onerror = (event) => reject(new ChromeTapError(`Could not connect to Chrome: ${event?.message ?? 'socket error'}`));
		});

		return new CdpConnection(socket);
	}

	constructor(socket) {
		this.socket = socket;
		this.nextId = 1;
		this.pending = new Map();
		this.pageSessions = new Set();
		this.onEvent = () => {};

		socket.onmessage = (event) => this.receive(event.data);
		socket.onclose = () => {
			for (const { reject, timer } of this.pending.values()) {
				clearTimeout(timer);
				reject(new ChromeTapError('The connection to Chrome closed.'));
			}

			this.pending.clear();
		};
		socket.onerror = () => {};
	}

	/**
	 * @param {string} method
	 * @param {object} [params]
	 * @param {string} [sessionId]
	 * @returns {Promise<object>}
	 */
	send(method, params = {}, sessionId = undefined) {
		const id = this.nextId++;

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new ChromeTapError(`Chrome did not answer ${method}.`));
			}, CALL_TIMEOUT_MS);

			this.pending.set(id, { resolve, reject, timer });
			this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
		});
	}

	receive(data) {
		let message;

		try {
			message = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
		} catch {
			return;
		}

		if (message.id && this.pending.has(message.id)) {
			const { resolve, reject, timer } = this.pending.get(message.id);
			clearTimeout(timer);
			this.pending.delete(message.id);

			if (message.error) {
				reject(new ChromeTapError(message.error.message ?? 'CDP error'));
			} else {
				resolve(message.result ?? {});
			}

			return;
		}

		if (message.method) {
			this.onEvent(message);
		}
	}

	close() {
		try {
			this.socket.close();
		} catch {
			// already closed
		}
	}
}

/**
 * Node before 22 has no global WebSocket; `ws` comes in with Puppeteer.
 */
async function loadWs() {
	try {
		return (await import('ws')).default;
	} catch {
		throw new ChromeTapError('Recording Chrome traffic needs Node 22+, or the "ws" package (npm install).');
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
