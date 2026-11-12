/**
 * Two-factor channels: how a run gets past a one-time code or a sign-in that has
 * to be approved somewhere else.
 *
 * The envelope names a channel (`two_factor.channel`, e.g. `uae_pass`) but not
 * how this machine satisfies it, because that is a property of the machine, not
 * the task. One task may run where a human watches a phone and types a code into
 * a file; another may run against an Android emulator that approves the UAE Pass
 * push itself. Same envelope, different machine, different channel here.
 *
 * A channel is small: it is asked to `collect`, and it returns either a `code`
 * for the loop to type, or `code: null` when it satisfied the step out of band
 * (an app approval that needs no typing). Everything a channel needs that is not
 * in the envelope - a watch directory, an emulator serial - comes from config.
 *
 * Channels today:
 *  - file   : a code is written to `<workDir>/2fa.txt`, the mechanism KYCDD's
 *             own scrapers already use. The default, and the fallback.
 *  - uae_pass_app : approve the UAE Pass push on an Android emulator. Selected
 *             only when the operator has turned it on (see config), because it
 *             removes the human from the one step 2FA exists to keep them in.
 */

import { FileCodeChannel } from './FileCode.js';
import { UaePassAppChannel } from './UaePassApp.js';
import { HumanApprovalChannel } from './HumanApproval.js';

export const APPROVAL_OFF = 'off';
export const APPROVAL_AUTO = 'auto';
export const APPROVAL_ASSIST = 'assist';

/**
 * Chooses the channel for a task, or null when the task needs no second factor.
 *
 * @param {object} envelope
 * @param {object} config
 * @returns {{collect: (context: object) => Promise<{code: string|null, note?: string}>, describe: () => string} | null}
 */
export function twoFactorChannel(envelope, config) {
	const twoFactor = envelope.twoFactor;

	if (!twoFactor) {
		return null;
	}

	const isUaePass = /uae[_ ]?pass/i.test(String(twoFactor.channel || ''));

	/**
	 * How this machine satisfies a UAE Pass approval is deliberately chosen, not a
	 * default, because it is the step 2FA exists to keep a human in:
	 *  - `assist`: alert the operator and wait while THEY approve on the phone, so
	 *    the run survives the step without the approval becoming unattended. This
	 *    is the one to pick when you want longevity but keep a person approving.
	 *  - `auto`: approve by itself on an Android emulator (fully unattended).
	 *  - `off` (default): fall back to a typed code from a file.
	 */
	if (isUaePass && config.uaePassApproval === APPROVAL_ASSIST) {
		return new HumanApprovalChannel({ channel: twoFactor.channel, config });
	}

	if (isUaePass && config.uaePassApproval === APPROVAL_AUTO) {
		return new UaePassAppChannel({ channel: twoFactor.channel, config });
	}

	return new FileCodeChannel({ channel: twoFactor.channel });
}
