/**
 * The browser surface: the action vocabulary carried out against a real
 * Chromium on this machine, through Puppeteer with the stealth plugin.
 *
 * One of the two surfaces the single agent loop can drive. This is the one for a
 * portal that can be reached in a browser, and the only one that can `capture`:
 * it records the network log over CDP, which is where the Growth session values
 * live (a request header and JSON request bodies, none of it ever on screen).
 *
 * Three decisions here are worth keeping:
 *
 *  - The profile directory is persistent and keyed to the credential alias, so a
 *    session survives between runs. Signing in again through UAE Pass invalidates
 *    the session already held, so a profile that forgets destroys working
 *    sessions rather than merely wasting a run.
 *
 *  - Where the agent may go is enforced here, not asked for in the prompt. A
 *    click can navigate, so the allowlist is checked on every main-frame
 *    navigation; a departure is recorded and the loop ends the run on it.
 *
 *  - A credential is typed, never returned. The loop resolves the secret and
 *    calls `typeText`; the value never enters a model request or the step log.
 *
 * Coordinates are 1:1 here - the screenshot is the viewport at its own size - so
 * the view mapping (src/view.js) is usually the identity, and a region is just a
 * clip of the page. That keeps the loop identical across both surfaces.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

import { ActionError } from '../actions.js';
import { View, pointOn, regionOn } from '../view.js';
import { NetworkLog } from './NetworkLog.js';
import { OriginRefused } from './errors.js';

export { OriginRefused };

puppeteerExtra.use(StealthPlugin());

/**
 * The screen the model is shown and clicks against. The model's coordinates are
 * in this space, so it has to match the viewport exactly.
 */
export const VIEWPORT = { width: 1366, height: 768 };

/**
 * How a navigation waits.
 *
 * `domcontentloaded`, not `networkidle2`. These portals are single-page
 * OutSystems apps that keep connections open - analytics, long-polling, a
 * websocket - so the network never goes idle and a navigation told to wait for
 * idle never resolves: the page sits there, visibly loaded, while the run hangs.
 * Waiting for the document instead resolves promptly, and readiness is then
 * established by waiting for a specific element (the recipe's waitFor steps, or
 * the model's own look), which is what actually matters.
 */
const NAV_WAIT_UNTIL = 'domcontentloaded';
const NAV_TIMEOUT_MS = 45000;

/**
 * Model key names mapped onto Puppeteer's. Anything not listed is passed
 * through, which covers single printable characters and the names that agree.
 */
const KEY_ALIASES = {
	ctrl: 'Control', control: 'Control', cmd: 'Meta', command: 'Meta', meta: 'Meta', win: 'Meta',
	alt: 'Alt', option: 'Alt', shift: 'Shift', enter: 'Enter', return: 'Enter',
	esc: 'Escape', escape: 'Escape', tab: 'Tab', space: 'Space', backspace: 'Backspace',
	delete: 'Delete', insert: 'Insert', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
	pagedown: 'PageDown', pageup: 'PageUp', home: 'Home', end: 'End',
};

export class BrowserSurface {
	/**
	 * @param {object} options
	 * @param {string[]} options.allowedOrigins
	 * @param {string} options.profileRoot Where persistent profiles are kept.
	 * @param {string} options.profileKey Usually the credential alias.
	 */
	constructor({ allowedOrigins, profileRoot, profileKey, chromeChannel = 'chrome', chromePath = null, connectUrl = null }) {
		this.allowedOrigins = allowedOrigins;
		this.profileRoot = profileRoot;
		this.profileKey = profileKey;

		// How to get a browser that looks real to bot checks
		this.chromeChannel = chromeChannel;
		this.chromePath = chromePath;
		this.connectUrl = connectUrl;

		this.browser = null;
		this.page = null;
		this.network = null;
		this.lastView = null;
		this.connected = false;

		/** Set when the page ends up somewhere it should not be. */
		this.originViolation = null;
	}

	/**
	 * What this surface can be asked to do. The browser owns an address bar, a
	 * network log and an origin, so it offers everything.
	 *
	 * @returns {{navigate: boolean, capture: boolean, origins: boolean, monitors: boolean}}
	 */
	get capabilities() {
		return { navigate: true, capture: true, origins: true, monitors: false };
	}

	/**
	 * Launches the browser on the persistent profile for this credential.
	 */
	async open() {
		if (this.connectUrl) {
			// Attach to a Chrome the operator launched (their real profile): the
			// most human-looking option, and nothing we can set on a launched
			// browser matches a session that has a real history behind it.
			this.browser = await puppeteerExtra.connect({ browserURL: this.connectUrl, defaultViewport: null });
			this.connected = true;
		} else {
			const userDataDir = join(this.profileRoot, this.profileKey ?? 'default');
			mkdirSync(userDataDir, { recursive: true });
			this.browser = await this.launch(userDataDir);
		}

		const pages = await this.browser.pages();
		this.page = pages[0] ?? (await this.browser.newPage());

		// Don't force a viewport on a browser we attached to - keep its real window
		if (!this.connected) {
			await this.page.setViewport(VIEWPORT);
		}

		this.page.setDefaultTimeout(60000);

		this.network = new NetworkLog(this.page);
		await this.network.start();

		this.page.on('framenavigated', (frame) => {
			if (frame !== this.page.mainFrame()) {
				return;
			}

			if (!this.isAllowed(frame.url())) {
				this.originViolation = frame.url();
			}
		});
	}

	/**
	 * Launches a browser that looks real to a bot check: the installed Google
	 * Chrome by preference, with the automation signals removed. The
	 * `--enable-automation` switch (which sets navigator.webdriver and shows the
	 * automation banner) is dropped, and AutomationControlled is disabled. Falls
	 * back to the bundled Chromium if no installed Chrome is found.
	 *
	 * @param {string} userDataDir
	 * @returns {Promise<import('puppeteer').Browser>}
	 */
	async launch(userDataDir) {
		const base = {
			headless: false,
			userDataDir,
			defaultViewport: VIEWPORT,
			ignoreDefaultArgs: ['--enable-automation'],
			args: [
				'--disable-blink-features=AutomationControlled',
				'--no-first-run',
				'--no-default-browser-check',
				'--no-sandbox',
				'--disable-setuid-sandbox',
				`--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
				'--window-position=0,0',
			],
		};

		if (this.chromePath) {
			return puppeteerExtra.launch({ ...base, executablePath: this.chromePath });
		}

		if (this.chromeChannel) {
			try {
				return await puppeteerExtra.launch({ ...base, channel: this.chromeChannel });
			} catch (error) {
				console.error(`[browser] installed Chrome ("${this.chromeChannel}") could not be launched (${error.message}); falling back to bundled Chromium, which a bot check is more likely to flag.`);
			}
		}

		return puppeteerExtra.launch(base);
	}

	/**
	 * Closes the browser. The profile, and so the session, survives. A browser we
	 * only attached to is left running - closing it would shut the operator's own
	 * Chrome.
	 */
	async close() {
		await this.network?.stop();

		try {
			if (this.connected) {
				this.browser?.disconnect();
			} else {
				await this.browser?.close();
			}
		} catch {
			// Nothing useful to do about a browser that has already gone
		}
	}

	/**
	 * @returns {View|null}
	 */
	view() {
		return this.lastView;
	}

	/**
	 * The current page URL, for the step log and for the first navigation.
	 *
	 * @returns {string}
	 */
	url() {
		return this.page?.url() ?? '';
	}

	/**
	 * @param {string} url
	 * @returns {boolean}
	 */
	isAllowed(url) {
		if (!url || url === 'about:blank' || url.startsWith('devtools://')) {
			return true;
		}

		try {
			return this.allowedOrigins.includes(new URL(url).origin);
		} catch {
			return false;
		}
	}

	/**
	 * Captures the viewport, or a region of it, as the frame the model's next
	 * coordinates are measured in. 1:1, so the mapping is the identity for a full
	 * shot and a simple offset for a region.
	 *
	 * @param {object} [options]
	 * @param {{x: number, y: number, width: number, height: number}} [options.region] In the last view's pixels.
	 * @returns {Promise<View>}
	 */
	async screenshot({ region = null } = {}) {
		let base64;
		let srcX = 0;
		let srcY = 0;
		let width = VIEWPORT.width;
		let height = VIEWPORT.height;
		let note = null;

		if (region) {
			const clip = { x: region.x, y: region.y, width: region.width, height: region.height };

			base64 = await this.page.screenshot({ encoding: 'base64', type: 'png', clip });
			srcX = Math.round(clip.x);
			srcY = Math.round(clip.y);
			width = Math.round(clip.width);
			height = Math.round(clip.height);
			note = `A closer view of the page, ${width} by ${height}. Coordinates you give now refer to this view until you next act.`;
		} else {
			base64 = await this.page.screenshot({ encoding: 'base64', type: 'png' });
		}

		const view = new View({ base64, width, height, srcX, srcY, srcW: width, srcH: height, note });

		this.lastView = view;

		return view;
	}

	// ---- deterministic primitives, for the scripted flow (src/flows) ----------
	// These drive the page by selectors and the DOM rather than by screenshots, so
	// a known portal can be worked with no model in the loop. They are still bound
	// by the origin allowlist: navigation is checked, and the flow only reaches
	// pages the task permits.

	/**
	 * Navigates to a URL, subject to the allowlist.
	 *
	 * @param {string} url
	 */
	async go(url) {
		if (!this.isAllowed(url)) {
			throw new OriginRefused(url);
		}

		await this.navigate(url);
	}

	/**
	 * Navigates, tolerating a slow page. A navigation timeout is not treated as a
	 * failure: on these portals the document is usually present and usable well
	 * before the timeout, and the caller waits for a specific element next anyway.
	 * A real failure - DNS, a refused connection - still throws.
	 *
	 * @param {string} url
	 */
	async navigate(url) {
		try {
			await this.page.goto(url, { waitUntil: NAV_WAIT_UNTIL, timeout: NAV_TIMEOUT_MS });
		} catch (error) {
			if (error?.name !== 'TimeoutError') {
				throw error;
			}
			// The page is probably up; the next waitFor decides.
		}
	}

	/**
	 * Waits for a selector to appear. Returns whether it did, rather than throwing,
	 * so the flow decides what a miss means.
	 *
	 * @param {string} selector
	 * @param {object} [options]
	 * @param {number} [options.timeoutMs]
	 * @returns {Promise<boolean>}
	 */
	async waitFor(selector, { timeoutMs = 15000 } = {}) {
		try {
			await this.page.waitForSelector(selector, { timeout: timeoutMs, visible: true });
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Clicks the element matching a selector.
	 *
	 * @param {string} selector
	 * @param {object} [options]
	 * @param {number} [options.timeoutMs]
	 */
	async clickSelector(selector, { timeoutMs = 15000 } = {}) {
		await this.page.waitForSelector(selector, { timeout: timeoutMs, visible: true });
		await this.page.click(selector);
	}

	/**
	 * Types a value into a field, replacing anything already there. With
	 * `secret: true` nothing about the value is logged anywhere (the caller logs
	 * only that a credential was entered).
	 *
	 * @param {string} selector
	 * @param {string} value
	 * @param {object} [options]
	 * @param {boolean} [options.secret]
	 */
	async fill(selector, value, { secret = false } = {}) {
		const element = await this.page.waitForSelector(selector, { timeout: 15000, visible: true });

		// Select whatever is there, then type over it
		await element.click({ clickCount: 3 });
		await this.page.keyboard.type(String(value), { delay: secret ? 20 : 40 });
	}

	/**
	 * The value of a named cookie on the current page, or null.
	 *
	 * @param {string} name
	 * @returns {Promise<string|null>}
	 */
	async cookie(name) {
		const cookies = await this.page.cookies();

		return cookies.find((entry) => entry.name === name)?.value ?? null;
	}

	/**
	 * Waits until a named cookie is set, polling. Used to confirm a sign-in landed.
	 *
	 * @param {string} name
	 * @param {object} [options]
	 * @param {number} [options.timeoutMs]
	 * @param {AbortSignal} [options.signal]
	 * @returns {Promise<boolean>}
	 */
	async waitForCookie(name, { timeoutMs = 60000, signal } = {}) {
		const deadline = Date.now() + timeoutMs;

		while (Date.now() < deadline) {
			if (signal?.aborted) {
				return false;
			}

			if (await this.cookie(name)) {
				return true;
			}

			await new Promise((resolve) => setTimeout(resolve, 1000));
		}

		return false;
	}

	/**
	 * Waits until the page URL contains one of the given fragments. Used to follow
	 * the cross-site sign-in hops (Growth -> MOEC -> UAE Pass -> back) without
	 * guessing a cookie name.
	 *
	 * @param {string[]} fragments
	 * @param {object} [options]
	 * @param {number} [options.timeoutMs]
	 * @param {AbortSignal} [options.signal]
	 * @returns {Promise<boolean>}
	 */
	async waitForUrl(fragments, { timeoutMs = 60000, signal } = {}) {
		const wanted = [].concat(fragments);
		const deadline = Date.now() + timeoutMs;

		while (Date.now() < deadline) {
			if (signal?.aborted) {
				return false;
			}

			const here = this.page.url();

			if (wanted.some((fragment) => here.includes(fragment))) {
				return true;
			}

			await new Promise((resolve) => setTimeout(resolve, 1000));
		}

		return false;
	}

	/**
	 * Runs a function in the page, for reading structure the flow needs to decide
	 * on. Read-only by convention; never used to type a secret.
	 *
	 * @param {Function|string} fn
	 * @param {...unknown} args
	 * @returns {Promise<unknown>}
	 */
	async evaluate(fn, ...args) {
		return this.page.evaluate(fn, ...args);
	}

	/**
	 * Types text into whatever has focus. Used for ordinary typing and, from the
	 * loop, for a credential or one-time code - the value is not logged here.
	 *
	 * Typed with a delay: these portals use selectize and similar controls that
	 * drop everything but the first keystroke when a value is set faster than
	 * their handlers run, which looks like the model mistyping.
	 *
	 * @param {string} text
	 * @returns {Promise<void>}
	 */
	async typeText(text) {
		await this.page.keyboard.type(String(text), { delay: 40 });
	}

	/**
	 * Carries out one screen action. Coordinates are mapped against the last view
	 * (identity for a full shot, an offset for a region).
	 *
	 * @param {{type: string, args: object}} act
	 * @returns {Promise<object>}
	 */
	async execute(act) {
		const { type, args } = act;
		const mouse = this.page.mouse;

		switch (type) {
			case 'click': {
				const point = pointOn(this.lastView, args.x, args.y);

				if (point.error) {
					return { ok: false, error: point.error };
				}

				await mouse.click(point.x, point.y, {
					button: mouseButton(args.button),
					clickCount: args.count === 2 ? 2 : 1,
				});

				return { ok: true };
			}

			case 'move': {
				const point = pointOn(this.lastView, args.x, args.y);

				if (point.error) {
					return { ok: false, error: point.error };
				}

				await mouse.move(point.x, point.y);
				return { ok: true };
			}

			case 'drag': {
				const from = pointOn(this.lastView, args.from_x, args.from_y);
				const to = pointOn(this.lastView, args.to_x, args.to_y);

				if (from.error || to.error) {
					return { ok: false, error: from.error || to.error };
				}

				await mouse.move(from.x, from.y);
				await mouse.down();
				await mouse.move(to.x, to.y);
				await mouse.up();
				return { ok: true };
			}

			case 'scroll': {
				if (args.x !== undefined && args.y !== undefined) {
					const point = pointOn(this.lastView, args.x, args.y);

					if (point.error) {
						return { ok: false, error: point.error };
					}

					await mouse.move(point.x, point.y);
				}

				// A wheel notch is ~120px; sign matches the vocabulary (positive is up/left)
				const delta = -120 * (Number(args.clicks) || 0);
				await mouse.wheel(args.horizontal ? { deltaX: delta } : { deltaY: delta });
				return { ok: true };
			}

			case 'type':
				await this.typeText(String(args.text ?? ''));
				return { ok: true };

			case 'keypress': {
				const keys = (Array.isArray(args.keys) ? args.keys : [args.keys]).map(puppeteerKey);
				const keyboard = this.page.keyboard;

				for (const key of keys.slice(0, -1)) {
					await keyboard.down(key);
				}

				await keyboard.press(keys[keys.length - 1]);

				for (const key of keys.slice(0, -1).reverse()) {
					await keyboard.up(key);
				}

				return { ok: true };
			}

			case 'navigate': {
				if (!this.isAllowed(args.url)) {
					throw new OriginRefused(args.url);
				}

				await this.navigate(args.url);
				return { ok: true };
			}

			default:
				throw new ActionError(`The browser surface cannot carry out "${type}".`, act);
		}
	}
}

/**
 * @param {string|undefined} button
 * @returns {'left'|'right'|'middle'}
 */
function mouseButton(button) {
	if (button === 'right') {
		return 'right';
	}

	return button === 'middle' ? 'middle' : 'left';
}

/**
 * @param {string} key
 * @returns {string}
 */
function puppeteerKey(key) {
	const name = String(key);

	return KEY_ALIASES[name.toLowerCase()] ?? name;
}
