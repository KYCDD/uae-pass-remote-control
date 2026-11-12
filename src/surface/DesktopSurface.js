/**
 * The desktop surface: the action vocabulary carried out against the real
 * Windows mouse, keyboard and screen, through the PowerShell host.
 *
 * This is the second of the two surfaces the one agent loop can drive (the other
 * is BrowserSurface). It is what reaches a portal that refuses an automated
 * browser, a native dialog, or anything outside a browser window - it drives the
 * machine, not a page.
 *
 * What it cannot do, and says so through `capabilities`, is as important as what
 * it can:
 *
 *  - No `navigate`: there is no address bar it owns, so a URL is reached by
 *    working the screen like a person would.
 *  - No `capture` of its own: it sees pixels only. Given a ChromeTap, though,
 *    it starts a real Chrome (no Puppeteer) and can record that Chrome's network
 *    traffic once the model calls `start_recording` after signing in - which is
 *    how the Growth session is harvested without an automated sign-in. See
 *    ChromeTap.js.
 *  - No origin allowlist: there is no notion of an origin when you are driving a
 *    whole desktop. A task that needs its movements fenced to particular sites
 *    belongs on the browser surface.
 *
 * Coordinates are handled the same way as everywhere: the model gives a point in
 * the pixels of the view it was last shown, and the view maps it back to the
 * screen. See src/view.js.
 *
 * ## The failsafe
 *
 * This surface takes the operator's own mouse and keyboard, so the terminal that
 * started the run loses focus at the first click and Ctrl-C no longer reaches
 * it. The way to stop a run by hand is therefore on the screen itself: push the
 * pointer into the top-left corner of the main monitor. The pointer is checked
 * before every action and every screenshot, and finding it there ends the run
 * (RunStopped) before anything else is clicked or typed. Set
 * REMOTE_AGENT_DESKTOP_FAILSAFE=0 to turn it off.
 */

import fs from 'node:fs';

import { ActionError } from '../actions.js';
import { RunStopped } from './errors.js';
import { View, pointOn } from '../view.js';

/** How close to the corner, in screen pixels, counts as being in it. */
const FAILSAFE_MARGIN_PX = 4;

export class DesktopSurface {
	/**
	 * @param {object} options
	 * @param {import('./desktopHost.js').Desktop} options.desktop
	 */
	constructor({ desktop, failsafe = true, tap = null }) {
		this.desktop = desktop;

		/** @type {import('./ChromeTap.js').ChromeTap|null} */
		this.tap = tap;
		this.failsafe = Boolean(failsafe);
		this.lastView = null;

		/** Where this surface last put the pointer, so its own move is not mistaken for the operator's. */
		this.lastPointer = null;
	}

	/**
	 * Ends the run if the operator has pushed the pointer into the top-left
	 * corner of the main monitor - unless the agent itself put it there.
	 *
	 * @throws {RunStopped}
	 */
	async guard() {
		if (!this.failsafe) {
			return;
		}

		const screen = this.desktop.screen ?? {};
		const corner = { x: screen.primary_x ?? 0, y: screen.primary_y ?? 0 };
		const inCorner = (point) => Boolean(point)
			&& Math.abs(point.x - corner.x) <= FAILSAFE_MARGIN_PX
			&& Math.abs(point.y - corner.y) <= FAILSAFE_MARGIN_PX;

		if (inCorner(this.lastPointer)) {
			return;
		}

		const cursor = await this.desktop.call('cursor_position');

		if (inCorner(cursor)) {
			throw new RunStopped('The operator stopped the run (pointer moved to the top-left corner of the screen).');
		}
	}

	/**
	 * What this surface can and cannot be asked to do. The loop reads this to
	 * decide which tools to offer the model.
	 *
	 * @returns {{navigate: boolean, capture: boolean, origins: boolean, monitors: boolean}}
	 */
	get capabilities() {
		return { navigate: false, capture: Boolean(this.tap), recordOnDemand: Boolean(this.tap), origins: false, monitors: true };
	}

	/** The tapped Chrome's network log, once recording has started; otherwise none. */
	get network() {
		return this.tap?.log ?? null;
	}

	/**
	 * Starts recording the tapped Chrome's traffic.
	 *
	 * @returns {Promise<object>}
	 */
	async startRecording() {
		if (!this.tap) {
			throw new ActionError('There is no browser to record on this task.');
		}

		return this.tap.startRecording();
	}

	/** The desktop has no origin to violate. */
	get originViolation() {
		return null;
	}

	/**
	 * Starts the host.
	 */
	async open() {
		await this.desktop.start();
		await this.desktop.measure();

		if (this.tap) {
			const { launched } = await this.tap.ensureRunning();

			if (launched) {
				// Let the window come up before the first screenshot
				await new Promise((resolve) => setTimeout(resolve, 2500));
			}
		}
	}

	/**
	 * Shuts the host down.
	 */
	async close() {
		// Chrome stays open (and signed in) for the next task; only the recorder goes
		await this.tap?.stopRecording().catch(() => {});
		this.desktop.close();
	}

	/**
	 * The view last shown to the model, or null before the first screenshot.
	 *
	 * @returns {View|null}
	 */
	view() {
		return this.lastView;
	}

	/**
	 * Captures the screen, or a region of it, and remembers it as the frame the
	 * model's next coordinates are measured in.
	 *
	 * @param {object} [options]
	 * @param {{x: number, y: number, width: number, height: number}} [options.region] In screen coordinates.
	 * @param {'primary'|'all'} [options.monitor]
	 * @returns {Promise<View>}
	 */
	async screenshot({ region = null, monitor = 'primary' } = {}) {
		await this.guard();

		const shot = region
			? await this.desktop.screenshotRegion(region)
			: await this.desktop.screenshot(monitor === 'all' ? 'all' : 'primary');

		const base64 = (await fs.promises.readFile(shot.path)).toString('base64');

		const view = new View({
			base64,
			width: shot.width,
			height: shot.height,
			srcX: shot.screenX,
			srcY: shot.screenY,
			srcW: shot.screenWidth,
			srcH: shot.screenHeight,
			note: region
				? `A closer view, ${shot.width} by ${shot.height}${shot.shrink <= 1.01 ? ' at full size' : `, reduced ${shot.shrink.toFixed(1)}x`}. Coordinates you give now refer to this view until you next act.`
				: `The screen is ${shot.screenWidth} by ${shot.screenHeight}, shown as ${shot.width} by ${shot.height}${shot.shrink > 1.01 ? ` (reduced ${shot.shrink.toFixed(1)}x; look closer at anything you cannot read)` : ' at full size'}.`,
		});

		this.lastView = view;

		// The file is not kept: the base64 is in the view now, and the loop
		// decides separately whether to retain a screenshot as an artifact.
		fs.promises.rm(shot.path, { force: true }).catch(() => {});

		return view;
	}

	/**
	 * Types text into whatever has focus. Used both for ordinary typing and,
	 * from the loop, for a credential or a one-time code - the value is never
	 * logged here.
	 *
	 * @param {string} text
	 * @returns {Promise<void>}
	 */
	async typeText(text) {
		await this.guard();
		await this.desktop.call('type_text', { text: String(text) });
	}

	/**
	 * Carries out one screen action. Coordinates are mapped against the last view.
	 *
	 * @param {{type: string, args: object}} act
	 * @returns {Promise<object>} A small result for the model. Never a secret.
	 */
	async execute(act) {
		const { type, args } = act;

		await this.guard();

		switch (type) {
			case 'click': {
				const point = pointOn(this.lastView, args.x, args.y);

				if (point.error) {
					return { ok: false, error: point.error };
				}

				this.lastPointer = point;

				await this.desktop.call('mouse_click', {
					x: point.x,
					y: point.y,
					button: args.button || 'left',
					count: args.count === 2 ? 2 : 1,
				});

				return { ok: true };
			}

			case 'move': {
				const point = pointOn(this.lastView, args.x, args.y);

				if (point.error) {
					return { ok: false, error: point.error };
				}

				this.lastPointer = point;
				await this.desktop.call('mouse_move', { x: point.x, y: point.y });
				return { ok: true };
			}

			case 'drag': {
				const from = pointOn(this.lastView, args.from_x, args.from_y);
				const to = pointOn(this.lastView, args.to_x, args.to_y);

				if (from.error || to.error) {
					return { ok: false, error: from.error || to.error };
				}

				this.lastPointer = { x: to.x, y: to.y };

				await this.desktop.call('mouse_drag', {
					from_x: from.x,
					from_y: from.y,
					to_x: to.x,
					to_y: to.y,
					button: args.button || 'left',
				});

				return { ok: true };
			}

			case 'scroll': {
				const params = { clicks: Number(args.clicks) || 0, horizontal: Boolean(args.horizontal) };

				if (args.x !== undefined && args.y !== undefined) {
					const point = pointOn(this.lastView, args.x, args.y);

					if (point.error) {
						return { ok: false, error: point.error };
					}

					params.x = point.x;
					params.y = point.y;
					this.lastPointer = point;
				}

				await this.desktop.call('scroll', params);
				return { ok: true };
			}

			case 'type':
				await this.typeText(String(args.text ?? ''));
				return { ok: true };

			case 'keypress': {
				const keys = (Array.isArray(args.keys) ? args.keys : [args.keys]).map(String);

				try {
					await this.desktop.call('press_keys', { keys });
				} catch (error) {
					// A rejected key name is the model's mistake to correct
					return { ok: false, error: `${error.message} Allowed names are in the tool description.` };
				}

				return { ok: true };
			}

			case 'navigate':
				throw new ActionError('This surface drives the desktop and has no address bar; reach the page by working the screen.');

			default:
				throw new ActionError(`The desktop surface cannot carry out "${type}".`, act);
		}
	}
}
