/**
 * The approval phone, minded: one process that keeps the screen lit and watches
 * for a UAE Pass sign-in approval, so a human is alerted the instant one is
 * waiting and can approve it on the phone. It ties together the two pieces built
 * so far - KeepAwake and ApprovalDetector - and nothing more: it never taps,
 * approves, or enters a PIN. The approving stays with the person.
 *
 * It runs ONE loop rather than letting the two pieces each keep their own timer,
 * so only one thing talks to adb at a time (adb-over-USB does not love being
 * hit by two callers at once). Each tick:
 *   1. assert the phone is awake (and reconnect it if it dropped off adb);
 *   2. if it is reachable, check whether an approval is pending;
 *   3. hand both outcomes to onEvent, which the caller turns into log lines and
 *      an operator alert.
 *
 * onEvent receives one of:
 *   { kind: 'awake',    screenOn, mask, note? }          - a keep-awake beat
 *   { kind: 'offline',  state, note }                    - phone unreachable
 *   { kind: 'approval', status, via, text, note?, changed } - a detector result
 *                         (changed=true when status differs from the last tick)
 *   { kind: 'error',    note }
 */

import { KeepAwake } from './KeepAwake.js';
import { ApprovalDetector } from './ApprovalDetector.js';

const DEFAULT_POLL_MS = 3000;

export class PhoneMinder {
	/**
	 * @param {object} options
	 * @param {import('./adb.js').Adb} options.adb
	 * @param {number} [options.pollMs] Seconds between ticks.
	 * @param {number|null} [options.screenTimeoutMs] Raise the screen-off timeout as a fallback.
	 * @param {string} options.package The UAE Pass package.
	 * @param {string[]} [options.approveLabels] On-screen approve-control labels.
	 * @param {string[]} [options.keywords] Words that mark text as an approval.
	 * @param {(event: object) => void} [options.onEvent]
	 */
	constructor({ adb, pollMs = DEFAULT_POLL_MS, screenTimeoutMs = null, package: pkg, approveLabels = [], keywords, onEvent = () => {} }) {
		this.adb = adb;
		this.pollMs = pollMs;
		this.onEvent = onEvent;

		this.keepAwake = new KeepAwake({
			adb,
			screenTimeoutMs,
			onBeat: (beat) => this.onEvent(beat.type === 'offline'
				? { kind: 'offline', state: beat.state, note: beat.note }
				: { kind: 'awake', screenOn: beat.screenOn, mask: beat.mask, note: beat.note }),
		});

		this.detector = new ApprovalDetector({ adb, package: pkg, approveLabels, ...(keywords ? { keywords } : {}) });

		this.running = false;
		this.timer = null;
		this.lastStatus = null;
	}

	/**
	 * Asserts the awake settings once, then starts the single loop.
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

		await this.keepAwake.applyScreenTimeout({ signal });

		this.running = true;
		this.signal = signal;

		await this.tick({ wake: true });
		this.schedule();
	}

	/**
	 * One pass: keep awake, then (if reachable) look for a pending approval.
	 *
	 * @param {object} [options]
	 * @param {boolean} [options.wake]
	 * @returns {Promise<void>}
	 */
	async tick({ wake = false } = {}) {
		const signal = this.signal;

		try {
			const state = await this.keepAwake.assert({ signal, wake });

			// Only look for an approval when the phone was actually reachable;
			// the offline beat has already been reported by keepAwake.
			if (state !== 'device') {
				this.lastStatus = null;
				return;
			}

			const result = await this.detector.check({ signal });
			const changed = result.status !== this.lastStatus;
			this.lastStatus = result.status;

			this.onEvent({ kind: 'approval', ...result, changed });
		} catch (error) {
			this.onEvent({ kind: 'error', note: error.message });
		}
	}

	schedule() {
		this.timer = setTimeout(async () => {
			if (!this.running || this.signal?.aborted) {
				return;
			}

			await this.tick();

			if (this.running && !this.signal?.aborted) {
				this.schedule();
			}
		}, this.pollMs);

		this.timer.unref?.();
	}

	/**
	 * Stops the loop and restores the screen-off timeout if it was raised.
	 *
	 * @returns {Promise<void>}
	 */
	async stop() {
		this.running = false;

		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}

		await this.keepAwake.stop();
	}
}
