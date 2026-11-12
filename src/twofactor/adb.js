/**
 * A very small ADB client: enough to drive one Android device (a real phone over
 * USB or Wi-Fi, or an emulator) from Node by shelling out to the `adb` binary.
 * No dependency, same reasoning as the rest of this agent - a desktop machine
 * that nobody administers daily should not carry a native Android toolchain in
 * npm.
 *
 * Everything is scoped to one serial (`-s`), because the machine may have more
 * than one device and a stray `adb` with no serial picks one at random. The
 * serial may be left null only for commands that are not about a device
 * (`devices`, `connect`).
 */

import { spawn } from 'node:child_process';

export class AdbError extends Error {
	constructor(message) {
		super(message);
		this.name = 'AdbError';
	}
}

export class Adb {
	/**
	 * @param {object} options
	 * @param {string} options.binary Path to `adb`, or the bare name if on PATH.
	 * @param {string|null} options.serial Device serial, e.g. "R5CT32DADRA", "192.168.1.20:5555" or "emulator-5554".
	 * @param {number} [options.timeoutMs]
	 */
	constructor({ binary, serial, timeoutMs = 30000 }) {
		this.binary = binary;
		this.serial = serial || null;
		this.timeoutMs = timeoutMs;
	}

	/**
	 * Runs one adb command and returns stdout as text.
	 *
	 * @param {string[]} args Arguments after `-s <serial>`.
	 * @param {object} [options]
	 * @param {AbortSignal} [options.signal]
	 * @returns {Promise<string>}
	 */
	async run(args, options = {}) {
		return (await this.runBuffer(args, options)).toString('utf8');
	}

	/**
	 * Runs one adb command and returns stdout as bytes (for screencap).
	 *
	 * @param {string[]} args
	 * @param {object} [options]
	 * @param {AbortSignal} [options.signal]
	 * @param {boolean} [options.global] Leave out `-s <serial>`.
	 * @returns {Promise<Buffer>}
	 */
	runBuffer(args, { signal, global = false } = {}) {
		const full = global || !this.serial ? args : ['-s', this.serial, ...args];

		return new Promise((resolve, reject) => {
			const child = spawn(this.binary, full, { windowsHide: true });

			const chunks = [];
			let stderr = '';
			const timer = setTimeout(() => child.kill(), this.timeoutMs);

			const onAbort = () => child.kill();

			signal?.addEventListener('abort', onAbort, { once: true });

			child.stdout.on('data', (chunk) => chunks.push(chunk));
			child.stderr.on('data', (chunk) => {
				stderr += chunk;
			});

			child.on('error', (error) => {
				clearTimeout(timer);
				signal?.removeEventListener('abort', onAbort);
				reject(new AdbError(`adb could not be run ("${this.binary}"): ${error.message}`));
			});

			child.on('close', (code) => {
				clearTimeout(timer);
				signal?.removeEventListener('abort', onAbort);

				if (signal?.aborted) {
					reject(new AdbError('the run was cancelled'));
					return;
				}

				const stdout = Buffer.concat(chunks);

				if (code !== 0) {
					reject(new AdbError(`adb ${args[0]} failed (exit ${code}): ${stderr.trim() || stdout.toString('utf8').trim() || 'no output'}`));
					return;
				}

				resolve(stdout);
			});
		});
	}

	/**
	 * The devices adb can see, with their state ("device", "unauthorized", "offline").
	 *
	 * @param {object} [options]
	 * @returns {Promise<{serial: string, state: string, model: string|null}[]>}
	 */
	async devices({ signal } = {}) {
		const out = (await this.runBuffer(['devices', '-l'], { signal, global: true })).toString('utf8');

		return out
			.split(/\r?\n/)
			.slice(1)
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => {
				const [serial, state] = line.split(/\s+/);
				return { serial, state, model: /\bmodel:(\S+)/.exec(line)?.[1] ?? null };
			});
	}

	/**
	 * `adb connect host:port`, for a phone on wireless debugging.
	 *
	 * @param {string} address
	 * @returns {Promise<string>}
	 */
	async connect(address, { signal } = {}) {
		return (await this.runBuffer(['connect', address], { signal, global: true })).toString('utf8').trim();
	}

	/**
	 * Nudges a device that has gone "offline" back to "device". Best-effort: it
	 * does nothing for a device that has physically left (unplugged, powered off),
	 * which only a re-plug or a wake can bring back.
	 *
	 * @param {object} [options]
	 * @returns {Promise<void>}
	 */
	async reconnect({ signal } = {}) {
		await this.runBuffer(['reconnect'], { signal }).catch(() => {});
	}

	/**
	 * The state adb reports for this serial: "device" when ready, "offline" or
	 * "unauthorized" when present but not usable, "absent" when adb cannot see it
	 * at all.
	 *
	 * @param {object} [options]
	 * @returns {Promise<string>}
	 */
	async state({ signal } = {}) {
		const here = (await this.devices({ signal }).catch(() => [])).find((d) => d.serial === this.serial);

		return here ? here.state : 'absent';
	}

	/**
	 * Whether the device is online.
	 *
	 * @param {object} [options]
	 * @returns {Promise<boolean>}
	 */
	async isOnline({ signal } = {}) {
		try {
			return (await this.run(['get-state'], { signal })).trim() === 'device';
		} catch {
			return false;
		}
	}

	/**
	 * @param {string[]} args
	 * @param {object} [options]
	 * @returns {Promise<string>}
	 */
	shell(args, { signal } = {}) {
		return this.run(['shell', ...args], { signal });
	}

	/**
	 * Brings an app to the foreground by package name.
	 *
	 * @param {string} pkg
	 * @param {object} [options]
	 * @returns {Promise<void>}
	 */
	async launch(pkg, { signal } = {}) {
		await this.shell(['monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'], { signal });
	}

	/**
	 * Opens the notification shade, where a UAE Pass approval prompt first lands.
	 *
	 * @param {object} [options]
	 * @returns {Promise<void>}
	 */
	async openNotifications({ signal } = {}) {
		await this.shell(['cmd', 'statusbar', 'expand-notifications'], { signal });
	}

	/**
	 * Closes the notification shade.
	 *
	 * @param {object} [options]
	 * @returns {Promise<void>}
	 */
	async closeNotifications({ signal } = {}) {
		await this.shell(['cmd', 'statusbar', 'collapse'], { signal });
	}

	/**
	 * Taps a point on screen.
	 *
	 * @param {number} x
	 * @param {number} y
	 * @param {object} [options]
	 * @returns {Promise<void>}
	 */
	async tap(x, y, { signal } = {}) {
		await this.shell(['input', 'tap', String(Math.round(x)), String(Math.round(y))], { signal });
	}

	/**
	 * Swipes from one point to another.
	 *
	 * @returns {Promise<void>}
	 */
	async swipe(x1, y1, x2, y2, durationMs = 300, { signal } = {}) {
		await this.shell(['input', 'swipe', ...[x1, y1, x2, y2].map((n) => String(Math.round(n))), String(durationMs)], { signal });
	}

	/**
	 * Sends a key event, e.g. "KEYCODE_WAKEUP", "KEYCODE_BACK", "KEYCODE_HOME".
	 *
	 * @param {string} keycode
	 * @returns {Promise<void>}
	 */
	async key(keycode, { signal } = {}) {
		await this.shell(['input', 'keyevent', keycode], { signal });
	}

	/**
	 * Turns the screen on (does not unlock it).
	 *
	 * @returns {Promise<void>}
	 */
	async wake({ signal } = {}) {
		await this.key('KEYCODE_WAKEUP', { signal });
	}

	/**
	 * Keeps the screen on while the device is charging - the developer "Stay
	 * awake" setting, set over adb so no one has to toggle it by hand. The phone
	 * here is on USB, which counts as charging, so the screen stays on for as
	 * long as it is plugged in.
	 *
	 * This only holds the screen on; it does not unlock the phone or touch
	 * anything on screen.
	 *
	 * @param {'true'|'false'|'usb'|'ac'|'wireless'} [mode] What charging sources keep it awake; "true" is all of them.
	 * @param {object} [options]
	 * @returns {Promise<void>}
	 */
	async stayOn(mode = 'true', { signal } = {}) {
		await this.shell(['svc', 'power', 'stayon', mode], { signal });
	}

	/**
	 * The raw `stay_on_while_plugged_in` bitmask the device reports, for checking
	 * that stayOn took. 0 means off; any non-zero value includes at least one
	 * charging source (bit 1 = AC, 2 = USB, 4 = wireless).
	 *
	 * @param {object} [options]
	 * @returns {Promise<number>}
	 */
	async stayOnMask({ signal } = {}) {
		const raw = (await this.shell(['settings', 'get', 'global', 'stay_on_while_plugged_in'], { signal })).trim();
		const value = Number.parseInt(raw, 10);

		// null, not 0: a read that failed is not the same as the setting being off.
		return Number.isNaN(value) ? null : value;
	}

	/**
	 * Whether the screen is currently on. Read from `dumpsys power`, trying the
	 * fields newer and older Android builds use in turn.
	 *
	 * @param {object} [options]
	 * @returns {Promise<boolean|null>} null when it cannot be read.
	 */
	async screenOn({ signal } = {}) {
		let dump;

		try {
			dump = await this.shell(['dumpsys', 'power'], { signal });
		} catch {
			return null;
		}

		const displayState = /Display Power:\s*state=(\w+)/i.exec(dump)?.[1];

		if (displayState) {
			return displayState.toUpperCase() === 'ON';
		}

		const wakefulness = /mWakefulness=(\w+)/.exec(dump)?.[1];

		if (wakefulness) {
			return wakefulness.toLowerCase() === 'awake';
		}

		const screenOn = /mScreenOn=(true|false)/.exec(dump)?.[1];

		return screenOn ? screenOn === 'true' : null;
	}

	/**
	 * The screen-off timeout in milliseconds, or null when it cannot be read.
	 *
	 * @param {object} [options]
	 * @returns {Promise<number|null>}
	 */
	async screenTimeout({ signal } = {}) {
		const raw = (await this.shell(['settings', 'get', 'system', 'screen_off_timeout'], { signal })).trim();
		const value = Number.parseInt(raw, 10);

		return Number.isNaN(value) ? null : value;
	}

	/**
	 * Sets the screen-off timeout, in milliseconds. A belt-and-braces companion
	 * to stayOn: on a build that ignores the "stay awake while charging" setting,
	 * a long timeout still keeps the screen on. This is a user setting; restore
	 * it when done if you raise it.
	 *
	 * @param {number} ms
	 * @param {object} [options]
	 * @returns {Promise<void>}
	 */
	async setScreenTimeout(ms, { signal } = {}) {
		await this.shell(['settings', 'put', 'system', 'screen_off_timeout', String(Math.round(ms))], { signal });
	}

	/**
	 * Touches the emulated fingerprint sensor, for an approval gated on biometrics.
	 * Uses the emulator console command, which is a no-op on a real phone: a real
	 * fingerprint sensor cannot be driven over adb.
	 *
	 * @param {number} [fingerId]
	 * @param {object} [options]
	 * @returns {Promise<void>}
	 */
	async fingerprint(fingerId = 1, { signal } = {}) {
		await this.run(['emu', 'finger', 'touch', String(fingerId)], { signal }).catch(() => {});
	}

	/**
	 * The screen as a PNG. A window marked FLAG_SECURE (PIN screens often are)
	 * comes back black; that is Android, not a fault here.
	 *
	 * @returns {Promise<Buffer>}
	 */
	screenshot({ signal } = {}) {
		return this.runBuffer(['exec-out', 'screencap', '-p'], { signal });
	}

	/**
	 * Dumps the current UI hierarchy as XML, for finding a control by its text.
	 *
	 * Tries the fast form first (straight to stdout), then the file form, which
	 * some Samsung builds need: the /dev/tty form fails there with "null root
	 * node" while the screen is animating.
	 *
	 * @param {object} [options]
	 * @returns {Promise<string>}
	 */
	async uiDump({ signal } = {}) {
		try {
			const out = await this.run(['exec-out', 'uiautomator', 'dump', '--compressed', '/dev/tty'], { signal });

			if (out.includes('<hierarchy')) {
				return out;
			}
		} catch (error) {
			if (signal?.aborted) {
				throw error;
			}
		}

		const file = '/sdcard/kycdd_window_dump.xml';
		await this.shell(['uiautomator', 'dump', '--compressed', file], { signal });
		const xml = await this.run(['exec-out', 'cat', file], { signal });
		await this.shell(['rm', '-f', file], { signal }).catch(() => {});

		if (!xml.includes('<hierarchy')) {
			throw new AdbError(`uiautomator returned no screen: ${xml.trim().slice(0, 200) || 'no output'}`);
		}

		return xml;
	}

	/**
	 * The device's currently posted notifications, as {pkg, title, text}. This is
	 * where a UAE Pass approval push first lands, and reading it needs neither the
	 * screen on nor the phone unlocked. `--noredact` keeps the text from coming
	 * back as "[REDACTED]" on newer builds.
	 *
	 * @param {object} [options]
	 * @returns {Promise<{pkg: string, title: string, text: string}[]>}
	 */
	async notifications({ signal } = {}) {
		let out = '';

		try {
			out = await this.shell(['dumpsys', 'notification', '--noredact'], { signal });
		} catch {
			out = await this.shell(['dumpsys', 'notification'], { signal }).catch(() => '');
		}

		return parseNotifications(out);
	}

	/**
	 * The package name of the app in the foreground, or null. When this is the
	 * UAE Pass package, the approval screen is likely showing.
	 *
	 * @param {object} [options]
	 * @returns {Promise<string|null>}
	 */
	async foregroundApp({ signal } = {}) {
		const out = await this.shell(['dumpsys', 'window'], { signal }).catch(() => '');

		const patterns = [
			/mCurrentFocus=Window\{[^}]*?\s([a-zA-Z][\w.]+)\/[\w./]+\}/,
			/mFocusedApp=\S+\s+\S+\s+([a-zA-Z][\w.]+)\/[\w./]+/,
			/mResumedActivity:?\s+\S+\s+([a-zA-Z][\w.]+)\/[\w./]+/,
		];

		for (const pattern of patterns) {
			const match = pattern.exec(out);

			if (match) {
				return match[1];
			}
		}

		return null;
	}
}

/**
 * Parses `dumpsys notification` into one entry per posted notification. The
 * format drifts between Android versions, so this leans on the stable bits: each
 * record opens with `NotificationRecord(... pkg=<package> ...)`, and the title
 * and body print as `android.title=` / `android.text=` extras.
 *
 * @param {string} out
 * @returns {{pkg: string, title: string, text: string}[]}
 */
export function parseNotifications(out) {
	const text = String(out ?? '');
	const chunks = text.split(/NotificationRecord\(/).slice(1);

	const clean = (value) => (value ?? '')
		.replace(/^String\s*\(/, '')
		.replace(/\)$/, '')
		.trim();

	const field = (chunk, name) => clean(new RegExp(`\\b${name}=([^\\n]*)`).exec(chunk)?.[1]);

	return chunks
		.map((chunk) => ({
			pkg: /\bpkg=(\S+)/.exec(chunk)?.[1] ?? '',
			title: field(chunk, 'android\\.title') || field(chunk, 'tickerText'),
			text: field(chunk, 'android\\.text'),
		}))
		.filter((entry) => entry.pkg);
}

/**
 * The nodes of a uiautomator XML dump, flattened.
 *
 * @param {string} xml
 * @returns {{text: string, desc: string, id: string, pkg: string, cls: string, clickable: boolean, password: boolean, bounds: number[]|null, x: number, y: number}[]}
 */
export function parseNodes(xml) {
	const nodes = [];

	for (const match of String(xml ?? '').matchAll(/<node\b[^>]*>/g)) {
		const tag = match[0];
		const attr = (name) => decodeXml(new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? '');
		const b = /\bbounds="\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]"/.exec(tag);
		const bounds = b ? b.slice(1).map(Number) : null;

		nodes.push({
			text: attr('text'),
			desc: attr('content-desc'),
			id: attr('resource-id'),
			pkg: attr('package'),
			cls: attr('class'),
			clickable: /\bclickable="true"/.test(tag),
			password: /\bpassword="true"/.test(tag),
			bounds,
			x: bounds ? (bounds[0] + bounds[2]) / 2 : 0,
			y: bounds ? (bounds[1] + bounds[3]) / 2 : 0,
		});
	}

	return nodes;
}

/**
 * Finds the centre of the first on-screen node whose text or content-description
 * matches one of the given labels, in a uiautomator XML dump.
 *
 * @param {string} xml
 * @param {string[]} labels Labels to match (case-insensitive).
 * @param {object} [options]
 * @param {boolean} [options.exact] Require the whole text/desc to equal a label,
 *        rather than merely contain it. Used for keypad digits, where a substring
 *        match ("1" inside "12") would tap the wrong key.
 * @param {string[]} [options.exclude] A node whose text/desc contains any of
 *        these is never a match: so "allow" does not hit "Don't allow", and
 *        "approve" does not hit "Disapprove".
 * @param {string} [options.pkg] Only nodes of this package.
 * @returns {{x: number, y: number, label: string, text: string} | null}
 */
export function findNode(xml, labels, { exact = false, exclude = [], pkg = null } = {}) {
	const wanted = labels.map((label) => label.toLowerCase());
	const unwanted = exclude.map((label) => label.toLowerCase());

	for (const node of parseNodes(xml)) {
		if (!node.bounds || (pkg && node.pkg !== pkg)) {
			continue;
		}

		const text = node.text.toLowerCase().trim();
		const desc = node.desc.toLowerCase().trim();

		if (unwanted.some((label) => text.includes(label) || desc.includes(label))) {
			continue;
		}

		const hit = wanted.find((label) => exact
			? (text === label || desc === label)
			: ((text && text.includes(label)) || (desc && desc.includes(label))));

		if (hit) {
			return { x: node.x, y: node.y, label: hit, text: node.text || node.desc };
		}
	}

	return null;
}

function decodeXml(value) {
	return value
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&amp;/g, '&');
}
