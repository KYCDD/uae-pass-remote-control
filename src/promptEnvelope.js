/**
 * Turns a free-form prompt into a task envelope, so the agent can be told what
 * to do in plain words instead of being sent a platform-built envelope.
 *
 * Everything downstream - the loop, the desktop surface, the credential and
 * two-factor handling, the failsafe - is the same as for a KYCDD task. Only the
 * instructions differ: a KYCDD envelope carries a portal-specific playbook, and
 * this one carries the operator's prompt plus the standing rules for driving a
 * Windows desktop by hand.
 *
 * The prompt is an instruction from the operator sitting at this machine, so it
 * goes in as the playbook. Values passed with --input stay data, fenced off the
 * same way platform inputs are.
 */

import { parseEnvelope } from './envelope.js';

/** The outcomes the model may stop with. */
const DEAD_ENDS = {
	'A visible CAPTCHA, image challenge or other bot check has to be solved to continue': 'blocked_by_bot_check',
	'A sign-in is rejected, or the account is reported locked or suspended': 'credentials_rejected',
	'A two-factor code or app approval does not arrive within the time allowed': 'two_factor_timeout',
	'The only way forward needs something the task did not ask for (a payment, a submission, a deletion, sending a message, changing settings)': 'needs_operator_decision',
	'The task cannot be done from what is on the screen, after trying sensible alternatives': 'cannot_complete',
};

const RULE_INTRO = 'You are driving the real Windows desktop of the operator who wrote the task, with its real mouse and keyboard. Their prompt, under WHAT TO DO, is the task.';

const RULE_OPEN_ANY_BROWSER = 'To open a website: if a browser window is already open, click it, press ctrl+l, type the URL and press enter. Otherwise press win+r, type the full URL (with https://) and press enter, which opens it in the default browser. To open an application, press win, type its name, wait a moment and press enter.';

const RULE_USE_TASK_CHROME = 'A Chrome window has been opened for this task, with a profile of its own that keeps its sign-ins between tasks. Do ALL browsing in that window (or new tabs of it): never open the default browser or another Chrome window with win+r. If it is behind other windows, find it on the taskbar. To go to a URL, click into it, press ctrl+l, type the URL and press enter. To open an application, press win, type its name, wait a moment and press enter.';

/** What a capturing task has to do after signing in, per extractor. */
const CAPTURE_STEPS = {
	growth_session: [
		'COLLECTING THE GROWTH SESSION (after the task above has you signed in to growth.gov.ae):',
		'1. Check you are actually signed in (the header shows a signed-in user, not a login control). If a session is already open, do NOT sign in again: a new UAE Pass sign-in invalidates the session already held.',
		'2. Call start_recording.',
		'3. Open the economic licence enquiry (https://www.growth.gov.ae/G2C/InquiryAboutEconomicLicenses), enter probe_licence_number from the values below as the licence number (and probe_emirate_id / probe_entity_id if the screen asks), and search.',
		'4. Open the first result to reach its detail screen.',
		'5. On the detail screen, use the export or download-as-PDF option. You do not need to keep the PDF.',
		'6. Call capture. Do the search, the detail screen and the export ONCE each. If capture says complete, stop: the run finishes by itself. Only if it names a REQUIRED value as missing, redo just the step it points to, once, and capture again. Optional values that were not seen are fine.',
	],
};

const OPERATING_RULES = [
	'Prefer the keyboard where it is reliable (ctrl+l, tab, enter, alt+tab), and prefer clicking a control you can clearly see over guessing at one. Take one action at a time and look at the result before the next one. Pages and apps are often slow; a screen that looks wrong is usually still loading, so wait and look again.',
	'A terminal window that started you may be visible. Ignore it: never click into it or type into it.',
	'Work only from what is visible on the screen. Never fill a field from your own knowledge or invent a value. If you are asked to read something, report exactly what the screen shows, and look closer at a region if it is too small to be sure.',
	'Use stored credentials only through type_credential, only in the sign-in form of the site or app the task is about, and never repeat them in your notes.',
	'Do not attempt to solve a CAPTCHA or any other bot check. If one blocks the way, give up with blocked_by_bot_check so the operator can deal with it.',
	'Do not make a payment, submit an application, delete anything, send a message, accept terms, or change account settings unless the task explicitly asks for exactly that. If the only way forward needs one of those, give up with needs_operator_decision and say what is needed.',
	'When you are done, leave the windows open as they are (do not close the browser or sign out) so a later task can carry on from there, then call finish with a short summary of what you did and what the screen now shows.',
];

/**
 * @param {boolean} ownChrome Whether the task has a Chrome window of its own.
 * @returns {string[]}
 */
function operatingRules(ownChrome) {
	return [RULE_INTRO, ownChrome ? RULE_USE_TASK_CHROME : RULE_OPEN_ANY_BROWSER, ...OPERATING_RULES];
}

const RESULT_SCHEMA = {
	type: 'object',
	properties: {
		summary: { type: 'string', description: 'What you did, and what the screen shows now.' },
		details: { type: 'string', description: 'Anything you were asked to read or report, exactly as shown on screen. Empty if nothing was asked for.' },
	},
	required: ['summary', 'details'],
};

/**
 * @param {string} prompt The operator's instruction.
 * @param {object} [options]
 * @param {string|null} [options.credentialAlias] Offers type_credential for this alias.
 * @param {string|null} [options.twoFactor] A two-factor channel name, e.g. "uae_pass" or "file".
 * @param {Record<string, string>} [options.inputs] Values to type, kept as data.
 * @param {number} [options.maxSteps]
 * @param {number} [options.timeoutSeconds]
 * @param {'none'|'on_error'|'every_step'} [options.screenshots]
 * @param {{prompt: string, outcome: string, summary: string}[]} [options.history] Earlier tasks this session.
 * @param {string|null} [options.capture] An extractor to harvest with (e.g. "growth_session"). Gives the
 *        task a real Chrome of its own with a network tap, and the start_recording / capture tools.
 * @param {string|null} [options.url] Where that Chrome opens when it is first started.
 * @returns {object} A parsed envelope.
 */
export function promptEnvelope(prompt, options = {}) {
	const text = String(prompt ?? '').trim();

	if (!text) {
		throw new Error('The prompt is empty.');
	}

	const playbook = [text];
	const history = options.history ?? [];
	const capture = options.capture || null;

	if (capture && CAPTURE_STEPS[capture]) {
		playbook.push('', ...CAPTURE_STEPS[capture]);
	}

	if (history.length > 0) {
		playbook.push(
			'',
			'For context, earlier tasks in this session (already done; the screen may still show their result - do not redo them unless asked):',
			...history.map((entry, index) => `${index + 1}. "${entry.prompt}" -> ${entry.outcome}: ${entry.summary}`),
		);
	}

	const envelope = parseEnvelope({
		version: '1',
		service: {
			key: 'desktop_prompt',
			name: 'Prompted desktop task',
			// The desktop has no address bar of its own, so this is never navigated to
			url: 'about:blank',
			requires_login: Boolean(options.credentialAlias),
			credential_alias: options.credentialAlias || null,
		},
		inputs: options.inputs ?? {},
		instructions: {
			operating_rules: operatingRules(Boolean(capture)),
			playbook,
			dead_ends: DEAD_ENDS,
		},
		result_schema: RESULT_SCHEMA,
		limits: {
			max_steps: options.maxSteps ?? 60,
			timeout_seconds: options.timeoutSeconds ?? 900,
		},
		artifacts: { screenshots: options.screenshots ?? 'on_error' },
		two_factor: options.twoFactor ? { channel: options.twoFactor } : null,
	});

	// Read by the loop (which extractor) and the desktop surface (where Chrome opens)
	envelope.capture = capture;
	envelope.finishOnCapture = Boolean(capture);
	envelope.startUrl = options.url || null;

	return envelope;
}
