/**
 * Extracts a Growth session from the network log.
 *
 * This is the deliberate half of the Growth task, and it is worth being clear
 * about why it is not the model's job.
 *
 * The playbook has the agent sign in, run a probe search, open a licence detail
 * screen and trigger a PDF export. That is navigation, and navigation is what a
 * computer-use model is for. What follows — a 2KB `Cookie` header, a CSRF token
 * and four version strings — is transcription, and handing transcription to a
 * model is a bad trade three times over:
 *
 *  - It would be wrong sometimes. A model retyping two kilobytes of cookie,
 *    character for character, will eventually drop one, and the failure surfaces
 *    much later as Growth refusing to answer for no visible reason.
 *  - It would send a live session cookie and an identity token carrying the
 *    signed-in person's name, Emirates ID and telephone number into a third
 *    party's request logs. Nothing about the task requires that.
 *  - It is unnecessary. The browser already sent those exact bytes, and this
 *    machine recorded them.
 *
 * So the model is never shown the values. It says when it believes the portal has
 * made the four calls; this reads them out of the log and reports back only which
 * of them were found, so the model can tell whether to keep going.
 *
 * Field sources, as confirmed against KYCDD's own client (puppeteer/Growth.js,
 * puppeteer/growth_export_pdf.js) and the paste-in form those values replace
 * (api/UaeMinistryOfEconomy/TradeLicenceVerification/Growth/Field.php).
 */

import { NetworkLog } from '../surface/NetworkLog.js';

/**
 * The four OutSystems actions, and which value each one is read for.
 *
 * Matched on a URL fragment rather than the full URL because the host and the
 * module path have changed before and the action name is the stable part.
 */
const CALLS = {
	search: {
		fragment: 'DataActionGetEconomicLicences2',
		label: 'the licence search',
	},
	detail: {
		fragment: 'DataActionGetEconomicLicenceDetails',
		label: 'the licence detail',
	},
	encrypt: {
		fragment: 'ActionEncryptText',
		label: 'the licence-number encryption',
	},
	pdf: {
		fragment: 'ActionGetPageAsBinaryByUrl',
		label: 'the PDF export',
	},
};

/**
 * The values a cookie row cannot be stored without, mirroring the
 * `required_fields` that UaeMinistryOfEconomy::getCookieConfig() holds for
 * Growth.
 */
const REQUIRED = ['cookie', 'token', 'module_version', 'search_api_version', 'detail_api_version'];

/**
 * Stored when found, not insisted on. The encryption and PDF actions sit in
 * other modules, so their versions come from separate calls a run can miss while
 * still collecting everything a search needs — and Growth falls back to the
 * detail version for the encryption rather than refusing the call.
 */
const OPTIONAL = ['encrypt_api_version', 'pdf_api_version'];

/**
 * Reads whatever of the session is present in the log.
 *
 * Returns everything it found rather than failing on the first gap, because the
 * platform stores a partial session quite happily: only the cookie, token,
 * module version, search version and detail version are required, and Growth
 * falls back to the detail version when the encryption one is absent. A run that
 * got as far as the detail screen but failed the PDF export is still worth
 * keeping.
 *
 * @param {import('../surface/NetworkLog.js').NetworkLog} network
 * @returns {{values: object, found: string[], missing: string[]}}
 */
export function extractGrowthSession(network) {
	const entries = Object.fromEntries(
		Object.entries(CALLS).map(([name, call]) => [name, network.latest(call.fragment)]),
	);

	const values = {};

	/**
	 * The cookie and the token come off whichever call was seen, because they are
	 * the same on all four. The search is preferred only because it is the one a
	 * run always reaches.
	 */
	const anyCall = entries.search ?? entries.detail ?? entries.encrypt ?? entries.pdf;

	if (anyCall) {
		const cookie = NetworkLog.header(anyCall, 'cookie');
		const token = NetworkLog.header(anyCall, 'x-csrftoken');

		if (cookie) {
			values.cookie = cookie;
		}

		if (token) {
			values.token = token;
		}
	}

	const search = versionInfo(entries.search);

	if (search) {
		// The module version is the same across the module; the search is where it is read
		values.module_version = search.moduleVersion;
		values.search_api_version = search.apiVersion;
	}

	const detail = versionInfo(entries.detail);

	if (detail) {
		values.detail_api_version = detail.apiVersion;
	}

	const encrypt = versionInfo(entries.encrypt);

	if (encrypt) {
		values.encrypt_api_version = encrypt.apiVersion;
	}

	const pdf = versionInfo(entries.pdf);

	if (pdf) {
		values.pdf_api_version = pdf.apiVersion;
	}

	// Whose session this is, for the platform's own records
	values.signed_in_as = values.cookie ? identityName(values.cookie) : '';

	const wanted = [...REQUIRED, ...OPTIONAL];

	/**
	 * Decided here rather than taken from the model. The model does not know
	 * which values came off the wire — it is never shown them — so it is in no
	 * position to say whether the harvest worked, and a model asserting success
	 * it cannot see is exactly the claim not to trust.
	 */
	values.harvested = REQUIRED.every((field) => isPresent(values[field]));

	return {
		values,
		found: wanted.filter((field) => isPresent(values[field])),
		missing: wanted.filter((field) => !isPresent(values[field])),
	};
}

/**
 * What to tell the model after a capture.
 *
 * Names which calls were seen and which values are still missing, and nothing
 * else. That is enough for it to decide whether to go back and trigger the PDF
 * export, without any of the values crossing into its context.
 *
 * @param {{found: string[], missing: string[]}} capture
 * @param {import('../surface/NetworkLog.js').NetworkLog} network
 * @returns {object}
 */
export function describeGrowthCapture(capture, network) {
	const requiredMissing = REQUIRED.filter((field) => !capture.found.includes(field));
	const optionalMissing = OPTIONAL.filter((field) => !capture.found.includes(field));
	const complete = requiredMissing.length === 0;

	/**
	 * Said in so many words, because a model shown any "missing" list will keep
	 * re-running the search to fill it - including for the optional values, which
	 * a run can miss without anything being wrong.
	 */
	const next = complete
		? `Everything required has been captured. Do NOT search again or repeat any step: call finish now.${optionalMissing.length ? ` (${optionalMissing.join(', ')} ${optionalMissing.length === 1 ? 'was' : 'were'} not seen; that is optional and fine.)` : ''}`
		: `Still missing required values: ${requiredMissing.join(', ')}. ${hint(requiredMissing)} Then capture again. Do not repeat a step that already worked.`;

	return {
		calls_seen: Object.fromEntries(
			Object.entries(CALLS).map(([name, call]) => [call.label, Boolean(network.latest(call.fragment))]),
		),
		complete,
		values_found: capture.found,
		required_missing: requiredMissing,
		optional_missing: optionalMissing,
		next,
	};
}

/**
 * Which step makes the calls the missing values come from.
 *
 * @param {string[]} missing
 * @returns {string}
 */
function hint(missing) {
	const steps = [];

	if (missing.some((field) => ['cookie', 'token', 'module_version', 'search_api_version'].includes(field))) {
		steps.push('run the licence search once (that call carries the cookie, token, module and search versions)');
	}

	if (missing.includes('detail_api_version')) {
		steps.push('open a search result\'s detail screen');
	}

	return steps.length ? `To get them, ${steps.join(' and ')}.` : '';
}

/**
 * @param {object|null} entry
 * @returns {{apiVersion: string, moduleVersion: string}|null}
 */
function versionInfo(entry) {
	const body = NetworkLog.json(entry);
	const info = body?.versionInfo;

	if (!info || (!info.apiVersion && !info.moduleVersion)) {
		return null;
	}

	return {
		apiVersion: info.apiVersion ? String(info.apiVersion) : '',
		moduleVersion: info.moduleVersion ? String(info.moduleVersion) : '',
	};
}

/**
 * The `name` claim out of the IdentityTokenId cookie, which is a JWT.
 *
 * Only the claim is read. The token is not verified, because nothing here is
 * trusting it: it is being quoted back to the platform so an administrator can
 * see which account the session belongs to.
 *
 * @param {string} cookie The full Cookie header.
 * @returns {string}
 */
function identityName(cookie) {
	const match = /(?:^|;\s*)IdentityTokenId=([^;]+)/.exec(cookie);

	if (!match) {
		return '';
	}

	const parts = decodeURIComponent(match[1]).split('.');

	if (parts.length < 2) {
		return '';
	}

	try {
		const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));

		return String(payload.name ?? payload.email ?? payload.username ?? '');
	} catch {
		return '';
	}
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPresent(value) {
	return typeof value === 'string' && value.trim() !== '';
}
