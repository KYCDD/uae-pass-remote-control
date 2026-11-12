/**
 * Detects, read-only, whether a UAE Pass sign-in approval is currently waiting
 * on the phone. It only observes - it never taps, approves, launches the app, or
 * touches the screen. Its whole job is to say "someone needs to approve now" so
 * the operator can be alerted; the approving stays with the person holding the
 * phone.
 *
 * Two signals, strongest first:
 *  1. A notification from the UAE Pass package whose text reads like an approval.
 *     This is the earliest signal and needs neither the screen on nor the phone
 *     unlocked - the push is there the moment UAE Pass sends it.
 *  2. The UAE Pass app in the foreground with an approve control on screen. A
 *     fallback for when the prompt is open but posted no (readable) notification.
 *
 * A notification from the app that does not clearly read as an approval, or the
 * app merely being in front, is reported as "possible" rather than "pending", so
 * a marketing push or an idle app does not raise a false alarm.
 */

import { findNode } from './adb.js';

/** Approval status. */
export const PENDING = 'pending';
export const POSSIBLE = 'possible';
export const NONE = 'none';

/**
 * Words that mark a notification or screen as a sign-in approval, English and
 * Arabic. Overridable; these are only defaults.
 */
const DEFAULT_KEYWORDS = [
	'approve', 'approval', 'authorise', 'authorize', 'authenticate', 'authentication',
	'sign in', 'sign-in', 'signin', 'log in', 'login', 'verify your', 'confirm your',
	'موافقة', 'الموافقة', 'تسجيل الدخول', 'تأكيد', 'توثيق', 'الدخول',
];

export class ApprovalDetector {
	/**
	 * @param {object} options
	 * @param {import('./adb.js').Adb} options.adb
	 * @param {string} options.package The UAE Pass package, e.g. "ae.uaepass.mainapp".
	 * @param {string[]} [options.approveLabels] On-screen approve-control labels (from config).
	 * @param {string[]} [options.keywords] Words that mark text as an approval.
	 */
	constructor({ adb, package: pkg, approveLabels = [], keywords = DEFAULT_KEYWORDS }) {
		this.adb = adb;
		this.package = pkg;
		this.approveLabels = approveLabels;
		this.keywords = keywords.map((word) => word.toLowerCase());
	}

	/**
	 * Looks once at the phone and reports whether an approval is waiting.
	 *
	 * @param {object} [options]
	 * @param {AbortSignal} [options.signal]
	 * @returns {Promise<{status: string, via: string|null, text: string|null, note?: string}>}
	 */
	async check({ signal } = {}) {
		if (!(await this.adb.isOnline({ signal }))) {
			return { status: NONE, via: null, text: null, note: 'phone not reachable over adb' };
		}

		// 1. Notifications - the earliest signal, works with the screen off/locked.
		const fromApp = (await this.adb.notifications({ signal }).catch(() => []))
			.filter((note) => note.pkg === this.package);

		const approval = fromApp.find((note) => this.readsAsApproval(`${note.title} ${note.text}`));

		if (approval) {
			return { status: PENDING, via: 'notification', text: (approval.title || approval.text || '').trim() };
		}

		// 2. The app is in front - is an approve control actually on screen?
		const foreground = (await this.adb.foregroundApp({ signal }).catch(() => null)) === this.package;

		if (foreground && this.approveLabels.length) {
			const hit = findNode(await this.adb.uiDump({ signal }).catch(() => ''), this.approveLabels);

			if (hit) {
				return { status: PENDING, via: 'screen', text: hit.text };
			}
		}

		// Weaker signals: present, but not clearly an approval.
		if (foreground) {
			return { status: POSSIBLE, via: 'foreground', text: null, note: 'UAE Pass is in the foreground, but no approve control is visible (the PIN screen may be secure)' };
		}

		if (fromApp.length) {
			return { status: POSSIBLE, via: 'notification', text: (fromApp[0].title || fromApp[0].text || '').trim(), note: 'a UAE Pass notification is present but does not clearly read as an approval' };
		}

		return { status: NONE, via: null, text: null };
	}

	/**
	 * Waits until an approval is pending, or the timeout passes.
	 *
	 * @param {object} [options]
	 * @param {number} [options.timeoutMs]
	 * @param {number} [options.intervalMs]
	 * @param {boolean} [options.acceptPossible] Resolve on a "possible" signal too.
	 * @param {AbortSignal} [options.signal]
	 * @param {(result: object) => void} [options.onPoll] Called with each check result.
	 * @returns {Promise<{status: string, via: string|null, text: string|null, note?: string} | null>} The pending result, or null on timeout.
	 */
	async waitForApproval({ timeoutMs = 180000, intervalMs = 2000, acceptPossible = false, signal, onPoll = () => {} } = {}) {
		const deadline = Date.now() + timeoutMs;

		while (Date.now() < deadline) {
			if (signal?.aborted) {
				throw new Error('cancelled while waiting for an approval to appear');
			}

			const result = await this.check({ signal });
			onPoll(result);

			if (result.status === PENDING || (acceptPossible && result.status === POSSIBLE)) {
				return result;
			}

			await sleep(intervalMs, signal);
		}

		return null;
	}

	/**
	 * @param {string} text
	 * @returns {boolean}
	 */
	readsAsApproval(text) {
		const haystack = String(text).toLowerCase();

		return this.keywords.some((word) => haystack.includes(word));
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
