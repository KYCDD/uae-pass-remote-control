/**
 * The UAE Pass app-approval channel: approve a sign-in push on an Android
 * emulator, so a run can complete when UAE Pass asks for an in-app approval
 * rather than a code that can be read and typed.
 *
 * This is the channel that closes the gap both agents were stuck on. It is NOT
 * on by default and should not be. Approving a government identity prompt is the
 * one step whose whole purpose is a human decision, so this is reached only when
 * an operator has set REMOTE_AGENT_UAE_PASS_APPROVAL=auto on a machine holding an
 * emulator that is enrolled with the account being used. Everything it does is
 * logged, and it collects no code: it satisfies the step out of band and tells
 * the loop there is nothing to type.
 *
 * ## Unverified
 *
 * This has not been run against the real UAE Pass app. The flow below - foreground
 * the app, open the notification, find an "approve" control by its text, tap it,
 * and touch the fingerprint sensor if the approval is gated on biometrics - is
 * the shape such an approval takes, but the app's actual screens, control labels
 * and whether it demands biometrics are not confirmed here. The approve labels,
 * the package name, and the sensor step are all configurable for that reason, and
 * the first real run against an enrolled emulator is where this gets tuned. Until
 * then it should be treated as a scaffold, not a finished channel.
 */

import { Adb, findNode } from './adb.js';

/**
 * How long to keep trying to find and tap the approval before giving up, and how
 * often to retry. An approval push can take a few seconds to arrive.
 */
const RETRY_INTERVAL_MS = 2000;

export class UaePassAppChannel {
	/**
	 * @param {object} options
	 * @param {string} options.channel
	 * @param {object} options.config
	 */
	constructor({ channel, config }) {
		this.channel = channel || 'uae_pass';
		this.config = config;

		this.adb = new Adb({
			binary: config.adbBinary,
			serial: config.emulatorSerial,
		});
	}

	/**
	 * Drives the emulator to approve the pending sign-in.
	 *
	 * @param {object} context
	 * @param {AbortSignal} [context.signal]
	 * @param {function} [context.recordStep]
	 * @returns {Promise<{code: null, note: string}>}
	 */
	async collect({ signal, recordStep = () => {} }) {
		const config = this.config;

		if (!(await this.adb.isOnline({ signal }))) {
			throw new Error(`The UAE Pass emulator "${config.emulatorSerial}" is not online. Start it, or set REMOTE_AGENT_EMULATOR_SERIAL.`);
		}

		recordStep('approving the sign-in in the UAE Pass app', { serial: config.emulatorSerial });

		// Bring the app and its prompt to the front. Either the push notification
		// or the app itself may carry the approve control, so try both.
		await this.adb.launch(config.uaePassPackage, { signal }).catch(() => {});
		await this.adb.openNotifications({ signal }).catch(() => {});

		const labels = config.uaePassApproveLabels;
		const deadline = Date.now() + config.uaePassApprovalTimeoutSeconds * 1000;

		let tapped = false;

		while (Date.now() < deadline) {
			if (signal?.aborted) {
				throw new Error('The run was cancelled while waiting to approve in UAE Pass.');
			}

			const target = await this.findApproval({ signal });

			if (target) {
				await this.adb.tap(target.x, target.y, { signal });
				recordStep('tapped the UAE Pass approval', { matched: target.label });
				tapped = true;
				break;
			}

			await sleep(RETRY_INTERVAL_MS, signal);
		}

		if (!tapped) {
			throw new Error(`No UAE Pass approval control appeared within ${config.uaePassApprovalTimeoutSeconds} seconds.`);
		}

		/**
		 * The approval is then confirmed by a passcode or a fingerprint. A PIN is
		 * preferred when configured, because a real device's fingerprint cannot be
		 * injected over adb (the emu command is emulator-only); on an emulator the
		 * fingerprint step is used instead.
		 */
		if (config.uaePassPin) {
			await this.enterPin({ signal, recordStep });
		} else if (config.uaePassUseFingerprint) {
			await this.adb.fingerprint(1, { signal });
			recordStep('supplied the emulator fingerprint');
		}

		return { code: null, note: 'the sign-in was approved in the UAE Pass app on the device' };
	}

	/**
	 * Enters the configured passcode on the UAE Pass PIN screen by tapping its
	 * on-screen keypad.
	 *
	 * The PIN never leaves this method as text: each digit is used only to pick
	 * which key to tap, the key is located by reading the screen, and the tap is a
	 * coordinate. Nothing is passed to adb as text and nothing records a digit -
	 * the step log says only how many digits were entered. The keypad is re-read
	 * before every digit because these screens routinely shuffle their keys.
	 *
	 * @param {object} context
	 * @param {AbortSignal} [context.signal]
	 * @param {function} context.recordStep
	 * @returns {Promise<void>}
	 */
	async enterPin({ signal, recordStep }) {
		const pin = String(this.config.uaePassPin);

		recordStep(`entering the ${pin.length}-digit UAE Pass passcode`);

		for (const digit of pin) {
			let tapped = false;

			for (let attempt = 0; attempt < 4 && !tapped; attempt++) {
				if (signal?.aborted) {
					throw new Error('The run was cancelled while entering the passcode.');
				}

				let xml = '';
				try { xml = await this.adb.uiDump({ signal }); } catch { xml = ''; }

				// Exact match so "1" never lands on "12"; a keypad key is usually its own node
				const key = findNode(xml, [digit], { exact: true });

				if (key) {
					await this.adb.tap(key.x, key.y, { signal });
					tapped = true;
				} else {
					await sleep(RETRY_INTERVAL_MS, signal);
				}
			}

			if (!tapped) {
				throw new Error('Could not find the on-screen keypad. The UAE Pass PIN screen may be marked secure (FLAG_SECURE), which blocks automation from reading or tapping it.');
			}
		}

		// Submit, if there is an explicit confirm control (many keypads auto-submit on the last digit)
		let confirmXml = '';
		try { confirmXml = await this.adb.uiDump({ signal }); } catch { confirmXml = ''; }

		const confirm = findNode(confirmXml, this.config.uaePassConfirmLabels);

		if (confirm) {
			await this.adb.tap(confirm.x, confirm.y, { signal });
		}

		recordStep('submitted the passcode');
	}

	/**
	 * Looks for the approve control in the current UI, foregrounding the app
	 * again if the notification shade has nothing.
	 *
	 * @param {object} context
	 * @returns {Promise<{x: number, y: number, label: string} | null>}
	 */
	async findApproval({ signal }) {
		let xml;

		try {
			xml = await this.adb.uiDump({ signal });
		} catch {
			return null;
		}

		const found = findNode(xml, this.config.uaePassApproveLabels);

		if (found) {
			return found;
		}

		// Nothing in the shade; the prompt may be inside the app
		await this.adb.launch(this.config.uaePassPackage, { signal }).catch(() => {});

		try {
			return findNode(await this.adb.uiDump({ signal }), this.config.uaePassApproveLabels);
		} catch {
			return null;
		}
	}

	/**
	 * @returns {string}
	 */
	describe() {
		return `approve the ${this.channel} push on emulator ${this.config.emulatorSerial}`;
	}
}

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);

		signal?.addEventListener('abort', () => {
			clearTimeout(timer);
			resolve();
		}, { once: true });
	});
}
