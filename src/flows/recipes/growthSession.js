/**
 * The Growth session harvest, as a deterministic recipe.
 *
 * This is the playbook the model would otherwise work by looking at the screen,
 * written instead as fixed steps against the DOM - no model in it. It was mapped
 * against the live portal, so the sign-in chain below is the real one:
 *
 *   1. Growth landing (growth.gov.ae/G2C/) has no "login" button. Opening the
 *      "Economic Licence Enquiry" service is what starts sign-in.
 *   2. That redirects to the MOEC Identity Server (id.moec.gov.ae/Account/Login),
 *      whose one control is "Login with Digital Identity".
 *   3. That goes to UAE Pass (ids.uaepass.ae), which takes the Emirates ID in
 *      `#username` (no password - `#password` is a hidden dummy field) and is
 *      submitted with `#basicPasswordForm-submitButton`.
 *   4. UAE Pass pushes the approval to the phone (the channel taps approve + PIN),
 *      then redirects back to the enquiry screen on growth.gov.ae.
 *
 * Whether we are already signed in is told from the URL after opening the
 * service - a bounce to id.moec/uaepass means we are not - rather than from a
 * guessed cookie name.
 *
 * ## Selectors
 *
 * The sign-in selectors have real defaults (discovered above) and can be
 * overridden with REMOTE_AGENT_GROWTH_SELECTORS. The enquiry-screen selectors
 * (licenceInput, searchButton, firstResult, exportButton) sit behind the login,
 * so they cannot be discovered without a session: sign in once by hand in the
 * `inspect` profile, then run `bin/inspect-dom.js` on the enquiry screen and set
 * them. Until they are set, the recipe signs in and reaches the enquiry screen
 * but skips the probe (and so reports the version values as missing).
 *
 * ## Known risk
 *
 * The UAE Pass page carries a reCAPTCHA Enterprise widget. If it ever presents a
 * visible challenge, automation cannot pass it and the run stops there - the same
 * bot-check limit that applies to any of these portals.
 */

const DEFAULTS = {
	appReady: '::-p-text(الأستعلام عن الرخص الأقتصادية)',
	serviceLink: '::-p-text(الأستعلام عن الرخص الأقتصادية)',
	moecDigitalId: '::-p-text(تسجيل الدخول بالهوية الرقمية)',
	idField: '#username',
	idSubmit: '#basicPasswordForm-submitButton',
	enquiryUrl: 'https://www.growth.gov.ae/G2C/InquiryAboutEconomicLicenses',
	// Behind the login - no defaults; set after a hand sign-in:
	licenceInput: '',
	searchButton: '',
	firstResult: '',
	exportButton: '',
};

/** The hosts a sign-in detours through; being on one means we are NOT signed in. */
const LOGIN_HOSTS = ['id.moec.gov.ae', 'uaepass.ae'];

const SIGN_IN_ESSENTIAL = ['serviceLink', 'moecDigitalId', 'idField', 'idSubmit'];
const PROBE_SELECTORS = ['licenceInput', 'searchButton', 'firstResult', 'exportButton'];

/**
 * @param {object} config
 * @returns {object}
 */
function selectors(config) {
	return { ...DEFAULTS, ...(config.growthSelectors ?? {}) };
}

/**
 * The recipe is ready as soon as the sign-in chain is known - which it is by
 * default. The probe runs only when its selectors are also set.
 *
 * @param {object} config
 * @returns {boolean}
 */
export function ready(config) {
	const sel = selectors(config);

	return SIGN_IN_ESSENTIAL.every((key) => typeof sel[key] === 'string' && sel[key].trim() !== '');
}

/**
 * @param {object} envelope
 * @param {object} config
 * @returns {object[]}
 */
export function build(envelope, config) {
	const sel = selectors(config);
	const timeout = (envelope.limits.timeoutSeconds ?? 600) * 1000;
	const probeReady = PROBE_SELECTORS.every((key) => sel[key]);

	const signIn = [
		{ op: 'set', field: 'reused_existing_session', value: { literal: false } },
		// On the MOEC login page: start Digital Identity (UAE Pass) sign-in
		{ op: 'click', selector: sel.moecDigitalId, label: 'Login with Digital Identity' },
		// On UAE Pass: the Emirates ID, then submit
		{ op: 'waitFor', selector: sel.idField, timeoutMs: 30000 },
		{ op: 'fillCredential', selector: sel.idField, field: 'username' },
		{ op: 'click', selector: sel.idSubmit, label: 'submit the Emirates ID' },
		// UAE Pass pushes to the phone; the channel taps approve + enters the PIN
		{ op: 'approve' },
		// Sign-in has landed when we are back on growth.gov.ae
		{ op: 'waitForUrl', includes: 'growth.gov.ae', timeoutMs: timeout, outcome: 'two_factor_timeout' },
	];

	const probe = probeReady
		? [
			{ op: 'navigate', url: sel.enquiryUrl },
			{ op: 'waitFor', selector: sel.licenceInput, timeoutMs: 30000 },
			{ op: 'fill', selector: sel.licenceInput, label: 'the licence number', value: { input: 'probe_licence_number' } },
			{ op: 'click', selector: sel.searchButton, label: 'search' },          // -> search call
			{ op: 'click', selector: sel.firstResult, label: 'the first result', timeoutMs: 20000 }, // -> detail + encrypt
			{ op: 'sleep', ms: 1500 },
			{ op: 'click', selector: sel.exportButton, label: 'export as PDF', timeoutMs: 20000 },    // -> pdf call
			{ op: 'sleep', ms: 1500 },
			{ op: 'set', field: 'notes', value: { literal: 'Harvested by the deterministic flow (no model).' } },
		]
		: [
			{ op: 'set', field: 'notes', value: { literal: 'Signed in, but the enquiry-screen selectors are not configured, so the probe (and the API-version harvest) was skipped. Inspect the enquiry screen while signed in and set licenceInput / searchButton / firstResult / exportButton.' } },
		];

	return [
		{ op: 'navigate', url: envelope.service.url },
		{ op: 'waitFor', selector: sel.appReady, timeoutMs: 30000, optional: true },

		// Opening the service either lands on the enquiry screen (already signed
		// in) or bounces to the login host (not signed in).
		{ op: 'click', selector: sel.serviceLink, label: 'the economic-licence service' },
		{ op: 'sleep', ms: 3500 },
		{
			op: 'branchUrl',
			includes: LOGIN_HOSTS,
			label: 'sign-in',
			present: signIn,
			absent: [{ op: 'set', field: 'reused_existing_session', value: { literal: true } }],
		},

		...probe,

		{ op: 'capture' },
		{ op: 'finish' },
	];
}
