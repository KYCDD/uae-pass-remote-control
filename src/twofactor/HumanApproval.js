/**
 * The human-in-the-loop UAE Pass channel: when a run reaches the sign-in
 * approval, alert the operator and wait while THEY approve it on the phone, then
 * let the run carry on. It keeps the person on the one step a government-identity
 * sign-in is built around a person doing - it never taps approve, never enters a
 * PIN, never touches the screen. All it does is keep the phone awake, make a
 * noise so the approval is not missed, and watch (read-only) for the prompt to
 * be handled.
 *
 * This is the channel to pick when the goal is "the run should survive the 2FA
 * step without a human babysitting the terminal" but the approval itself must
 * stay a human decision. It is selected by REMOTE_AGENT_UAE_PASS_APPROVAL=assist
 * (as opposed to `auto`, which approves by itself, or `off`, which waits for a
 * typed code in a file).
 *
 * How it decides the step is done:
 *  - If it sees the approval prompt appear and then clear, the operator handled
 *    it: success.
 *  - If the prompt never appears (the phone may be off adb, or the prompt may be
 *    on a secure screen this cannot read), it does not fail the run on that
 *    alone - it gives the operator the full window, then proceeds "unconfirmed",
 *    and the agent's next screenshot of the portal is the real check.
 *  - It fails (so the run ends on two_factor_timeout) only when it DID see the
 *    prompt and it was still there when the window ran out.
 */

import { spawn } from 'node:child_process';

import { Adb } from './adb.js';
import { ApprovalDetector, NONE } from './ApprovalDetector.js';

/** How often to re-check the phone, and how often to re-sound the alert. */
const POLL_MS = 2000;
const REALERT_MS = 20000;

/** How long to wait for the prompt to first appear before treating it as undetectable. */
const APPEAR_MS = 60000;

export class HumanApprovalChannel {
	/**
	 * @param {object} options
	 * @param {string} options.channel
	 * @param {object} options.config
	 */
	constructor({ channel, config }) {
		this.channel = channel || 'uae_pass';
		this.config = config;

		this.adb = new Adb({ binary: config.adbBinary, serial: config.emulatorSerial });
		this.detector = new ApprovalDetector({
			adb: this.adb,
			package: config.uaePassPackage,
			approveLabels: config.uaePassApproveLabels,
		});
	}

	/**
	 * Alerts the operator and waits for them to approve on the phone.
	 *
	 * @param {object} context
	 * @param {AbortSignal} [context.signal]
	 * @param {function} [context.recordStep]
	 * @returns {Promise<{code: null, note: string}>}
	 */
	async collect({ signal, recordStep = () => {} }) {
		const timeoutMs = this.config.uaePassApprovalTimeoutSeconds * 1000;
		const online = await this.adb.isOnline({ signal }).catch(() => false);

		if (online) {
			await this.keepAwake({ signal });
		}

		recordStep('waiting for the operator to approve the sign-in on the phone', {
			serial: this.config.emulatorSerial,
			reachable: online,
		});
		this.alert();

		// No phone to watch: give the operator the window anyway, re-alerting, and
		// proceed unconfirmed. Better than failing a run the operator may approve.
		if (!online) {
			await this.waitBlind(timeoutMs, { signal, recordStep });

			return { code: null, note: 'phone was not reachable over adb; gave the operator the approval window, unconfirmed' };
		}

		const deadline = Date.now() + timeoutMs;

		// 1. Wait for the prompt to show on the phone (confirms the push arrived).
		const appeared = await this.detector.waitForApproval({
			timeoutMs: Math.min(APPEAR_MS, timeoutMs),
			intervalMs: POLL_MS,
			acceptPossible: true,
			signal,
			onPoll: this.heartbeat({ signal }),
		});

		if (!appeared) {
			recordStep('no approval prompt was detected on the phone; proceeding unconfirmed (the next screen shows if sign-in went through)');

			return { code: null, note: 'no approval prompt was detected on the phone; proceeded unconfirmed' };
		}

		recordStep('the approval prompt is on the phone; waiting for the operator to approve it', { via: appeared.via });

		// 2. Wait for it to clear - the operator approved (or dismissed) it.
		const cleared = await this.waitForCleared(deadline, { signal, recordStep });

		if (!cleared) {
			throw new Error(`the sign-in was not approved on the phone within ${this.config.uaePassApprovalTimeoutSeconds} seconds`);
		}

		recordStep('the approval was handled on the phone');

		return { code: null, note: 'the sign-in was approved by the operator on the phone' };
	}

	/**
	 * Polls until the approval prompt is gone (handled) or the deadline passes.
	 *
	 * @param {number} deadline Epoch ms.
	 * @param {object} context
	 * @returns {Promise<boolean>}
	 */
	async waitForCleared(deadline, { signal, recordStep }) {
		let lastAlert = Date.now();

		while (Date.now() < deadline) {
			if (signal?.aborted) {
				throw new Error('cancelled while waiting for the operator to approve');
			}

			const result = await this.detector.check({ signal }).catch(() => ({ status: NONE }));

			if (result.status === NONE) {
				return true;
			}

			// Keep the screen lit and re-sound the alert now and then.
			await this.keepAwake({ signal });

			if (Date.now() - lastAlert >= REALERT_MS) {
				lastAlert = Date.now();
				this.alert();
				recordStep('still waiting for the operator to approve on the phone');
			}

			await sleep(POLL_MS, signal);
		}

		return false;
	}

	/**
	 * No phone to watch: just hold the window open, re-alerting, until it passes.
	 *
	 * @param {number} ms
	 * @param {object} context
	 * @returns {Promise<void>}
	 */
	async waitBlind(ms, { signal, recordStep }) {
		const deadline = Date.now() + ms;
		let lastAlert = Date.now();

		while (Date.now() < deadline) {
			if (signal?.aborted) {
				throw new Error('cancelled while waiting for the operator to approve');
			}

			await sleep(Math.min(POLL_MS, deadline - Date.now()), signal);

			if (Date.now() < deadline && Date.now() - lastAlert >= REALERT_MS) {
				lastAlert = Date.now();
				this.alert();
				recordStep('still waiting for the operator to approve on the phone (unwatched)');
			}
		}
	}

	/**
	 * A poll callback that keeps the screen lit and re-alerts while waiting for
	 * the prompt to appear.
	 *
	 * @param {object} context
	 * @returns {(result: object) => void}
	 */
	heartbeat({ signal }) {
		let lastAlert = Date.now();

		return () => {
			this.keepAwake({ signal }).catch(() => {});

			if (Date.now() - lastAlert >= REALERT_MS) {
				lastAlert = Date.now();
				this.alert();
			}
		};
	}

	/**
	 * Best-effort: keep the screen on and awake. Never throws.
	 *
	 * @param {object} context
	 * @returns {Promise<void>}
	 */
	async keepAwake({ signal }) {
		await this.adb.stayOn('true', { signal }).catch(() => {});

		if ((await this.adb.screenOn({ signal }).catch(() => null)) !== true) {
			await this.adb.wake({ signal }).catch(() => {});
		}
	}

	/**
	 * A cross-the-room alert: terminal bell, plus a desktop beep on Windows. The
	 * run is usually unattended, so the whole point is to be heard.
	 */
	alert() {
		process.stdout.write('\x07');

		if (process.platform !== 'win32' || this.config.uaePassAlertSound === false) {
			return;
		}

		try {
			const beep = spawn('powershell', ['-NoProfile', '-Command', '[console]::beep(880,350); [console]::beep(660,350)'], { stdio: 'ignore', windowsHide: true });
			beep.on('error', () => {});
			beep.unref();
		} catch {
			// the bell was enough
		}
	}

	/**
	 * @returns {string}
	 */
	describe() {
		return `alert the operator and wait for them to approve the ${this.channel} sign-in on the phone`;
	}
}

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
	return new Promise((resolve) => {
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};

		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);

		signal?.addEventListener('abort', onAbort, { once: true });
	});
}
