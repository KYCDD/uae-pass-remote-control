/**
 * The file channel: a one-time code arrives by whatever route it arrives by, and
 * someone or something writes it into `<workDir>/2fa.txt`. The agent waits for
 * the file, reads it, and types it; the file is deleted on read so a code is
 * never used twice.
 *
 * This is the mechanism KYCDD's existing scrapers use (`get2faCodeFromFile` in
 * puppeteer/Handler.js in the KYCDD repository), so an operator already knows the
 * drill. It is the default channel and the fallback for every other one.
 */

import { waitForCode } from '../credentials.js';

export class FileCodeChannel {
	/**
	 * @param {object} options
	 * @param {string} options.channel The envelope's channel name, for messages.
	 */
	constructor({ channel }) {
		this.channel = channel || 'one-time';
	}

	/**
	 * @param {object} context
	 * @param {string} context.workDir
	 * @param {AbortSignal} [context.signal]
	 * @returns {Promise<{code: string, note: string}>}
	 */
	async collect({ workDir, signal }) {
		const code = await waitForCode({ dir: workDir, channel: this.channel, signal });

		return { code, note: `a ${this.channel} code arrived and was typed` };
	}

	/**
	 * @returns {string}
	 */
	describe() {
		return `wait for a ${this.channel} one-time code in 2fa.txt`;
	}
}
