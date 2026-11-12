/**
 * Which service keys have a server-side extractor, and what it does.
 *
 * An extractor is this machine reading the answer itself rather than asking the
 * model for it. It exists for the values that are not on the screen — request
 * headers, request bodies — and for the ones where a model transcribing two
 * kilobytes by eye is a worse idea than reading the bytes that were actually
 * sent.
 *
 * Keeping this as a registry rather than a branch inside the agent loop means
 * the loop stays the same for every service: it offers the `capture` action only
 * when the task's service has an extractor, and merges whatever the extractor
 * produces into the result. A service with nothing to extract — an ordinary
 * read-a-licence-off-the-screen task — simply has no entry here, gets no
 * `capture` action, and answers the schema entirely from what the model saw.
 */

import { describeGrowthCapture, extractGrowthSession } from './growthSession.js';

/**
 * Service key, as sent by KYCDD, to its extractor.
 *
 * The keys mirror App\RemoteBrowser\RemoteService's own constants.
 */
const EXTRACTORS = {
	growth_session: {
		extract: extractGrowthSession,
		describe: describeGrowthCapture,
	},
};

/**
 * @param {string} serviceKey
 * @returns {{extract: Function, describe: Function}|null}
 */
export function extractorFor(serviceKey) {
	return EXTRACTORS[serviceKey] ?? null;
}
