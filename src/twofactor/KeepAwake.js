/**
 * Keeps the approval phone's screen on, so a UAE Pass prompt is visible the
 * instant it arrives and the operator can act on it without first waking the
 * device.
 *
 * It does three things, all of them about the screen staying lit and nothing
 * about what is on it:
 *  - sets the developer "stay awake while charging" setting (the phone is on
 *    USB, so this holds the screen on as long as it is plugged in);
 *  - optionally raises the screen-off timeout, as a fallback for a build that
 *    ignores the first setting;
 *  - runs a heartbeat that re-asserts the setting and nudges the screen awake
 *    again if something (a reboot, a system dialog) let it sleep.
 *
 * It never unlocks the phone, taps anything, or approves anything. Keeping the
 * screen on is all it does.
 */

import { Adb } from './adb.js';

const DEFAULT_INTERVAL_MS = 30000;

export class KeepAwake {
	/**
	 * @param {object} options
	 * @param {Adb} options.adb
	 * @param {number} [options.intervalMs] How often the heartbeat checks, in ms.
	 * @param {number|null} [options.screenTimeoutMs] Raise the screen-off timeout
	 *        to this as a fallback; null leaves it alone. The original is restored
	 *        by stop().
	 * @param {(event: {type: string, screenOn: boolean|null, mask: number, note?: string}) => void} [options.onBeat]
	 */
	constructor({ adb, intervalMs = DEFAULT_INTERVAL_MS, screenTimeoutMs = null, onBeat = () => {} }) {
		this.adb = adb;
		this.intervalMs = intervalMs;
		this.screenTimeoutMs = screenTimeoutMs;
		this.onBeat = onBeat;

		this.timer = null;
		this.running = false;
		this.originalTimeout = null;
	}

	/**
	 * Asserts the awake settings once, then starts the heartbeat.
	 *
	 * @param {object} [options]
	 * @param {AbortSignal} [options.signal]
	 * @returns {Promise<void>}
	 */
	async start({ signal } = {}) {
		if (this.running) {
			return;
		}

		if (!(await this.adb.isOnline({ signal }))) {
			throw new Error(`The phone "${this.adb.serial}" is not online (check "adb devices"). Connect it and authorise USB debugging, then try again.`);
		}

		await this.applyScreenTimeout({ signal });
		await this.assert({ signal, wake: true });

		this.running = true;
		this.schedule(signal);
	}

	/**
	 * Raises the screen-off timeout (if one was asked for), remembering the
	 * original so stop() can put it back. Safe to call once before driving
	 * assert() yourself, instead of start(), e.g. from PhoneMinder's own loop.
	 *
	 * @param {object} [options]
	 * @param {AbortSignal} [options.signal]
	 * @returns {Promise<void>}
	 */
	async applyScreenTimeout({ signal } = {}) {
		if (this.screenTimeoutMs === null || this.originalTimeout !== null) {
			return;
		}

		this.originalTimeout = await this.adb.screenTimeout({ signal }).catch(() => null);
		await this.adb.setScreenTimeout(this.screenTimeoutMs, { signal }).catch(() => {});
	}

	/**
	 * One beat: make sure the setting is on and the screen is awake.
	 *
	 * @param {object} [options]
	 * @param {AbortSignal} [options.signal]
	 * @param {boolean} [options.wake] Nudge the screen even if it looks on.
	 * @returns {Promise<string>} The device state seen ("device" when it was driven).
	 */
	async assert({ signal, wake = false } = {}) {
		const state = await this.adb.state({ signal }).catch(() => 'absent');

		// A phone that has dropped off adb (its USB drops when it sleeps on some
		// builds) can't be driven. Try to nudge it back, and say so plainly -
		// never mistake "couldn't read it" for "the setting is off".
		if (state !== 'device') {
			await this.adb.reconnect({ signal }).catch(() => {});

			this.onBeat({
				type: 'offline',
				state,
				screenOn: null,
				mask: null,
				note: state === 'absent'
					? 'phone not visible to adb (unplugged, powered off, or asleep with USB dropped) - re-plug or wake it'
					: `phone is "${state}"; tried to reconnect`,
			});

			return state;
		}

		await this.adb.stayOn('true', { signal }).catch(() => {});

		let screenOn = await this.adb.screenOn({ signal }).catch(() => null);

		// Wake if it is off, unknown, or we were told to on the first beat
		if (wake || screenOn === false || screenOn === null) {
			await this.adb.wake({ signal }).catch(() => {});
			screenOn = await this.adb.screenOn({ signal }).catch(() => screenOn);
		}

		const mask = await this.adb.stayOnMask({ signal }).catch(() => null);

		this.onBeat({
			type: 'beat',
			state,
			screenOn,
			mask,
			// Only a real numeric 0 means the setting did not take; null is an unread value.
			note: mask === 0 ? 'stay-awake setting did not take; the screen may still sleep when idle' : undefined,
		});

		return state;
	}

	/**
	 * @param {AbortSignal} [signal]
	 */
	schedule(signal) {
		this.timer = setTimeout(async () => {
			if (!this.running || signal?.aborted) {
				return;
			}

			try {
				await this.assert({ signal });
			} catch (error) {
				this.onBeat({ type: 'error', screenOn: null, mask: 0, note: error.message });
			}

			if (this.running && !signal?.aborted) {
				this.schedule(signal);
			}
		}, this.intervalMs);

		// Don't keep the Node process alive on the heartbeat alone
		this.timer.unref?.();
	}

	/**
	 * Stops the heartbeat and restores the screen-off timeout if it was raised.
	 * Leaves the "stay awake while charging" setting on, since that is harmless
	 * and is what we wanted; pass restore:true to turn it off too.
	 *
	 * @param {object} [options]
	 * @param {boolean} [options.restore] Also set stay-awake back off.
	 * @returns {Promise<void>}
	 */
	async stop({ restore = false } = {}) {
		this.running = false;

		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}

		if (this.originalTimeout !== null) {
			await this.adb.setScreenTimeout(this.originalTimeout).catch(() => {});
			this.originalTimeout = null;
		}

		if (restore) {
			await this.adb.stayOn('false').catch(() => {});
		}
	}
}
