/**
 * Every setting the agent reads, in one place.
 *
 * The agent runs on the Windows machine that holds the browser session, not on
 * the KYCDD web servers, so it is configured from its own environment (or a
 * `.env` file next to package.json, which the entry points in bin/ load when
 * dotenv is installed).
 *
 * Nothing that matters has a quiet default. A server that starts without a token
 * or secret would accept work from anyone who can reach the port while looking
 * perfectly healthy, and a model chosen by a constant in source is how a machine
 * ends up running something nobody chose. So a missing value is a ConfigError
 * naming every variable that is wrong, and the entry points refuse to start on
 * one.
 */

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SUPPORTED_VERSIONS } from './envelope.js';

/** The folder holding package.json; relative paths below resolve against it. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Which surface a run drives.
 *
 *  - browser: a Chromium window through Puppeteer. Enforces the origin allowlist
 *    and records the network log, so it is the only surface that can `capture`
 *    (the Growth session harvest needs that).
 *  - desktop: the real Windows mouse, keyboard and screen. Works with whatever
 *    is on screen, including native dialogs and portals that refuse an automated
 *    browser, but it cannot see URLs or network traffic.
 */
export const SURFACE_BROWSER = 'browser';
export const SURFACE_DESKTOP = 'desktop';
export const SURFACES = [SURFACE_BROWSER, SURFACE_DESKTOP];

/**
 * Binds to loopback unless told otherwise. This machine holds live portal
 * credentials and drives a signed-in browser for anything that can reach it, so
 * exposing it is a deliberate act: set REMOTE_AGENT_HOST, and prefer a tunnel or
 * a VPN to the open network.
 */
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;

/** Tolerated clock difference with KYCDD before a signed request is refused. */
const DEFAULT_CLOCK_SKEW_SECONDS = 300;

/**
 * How long a finished job is kept before it and its artifacts are purged. Short
 * on purpose: a finished Growth job holds a session cookie whose identity token
 * carries the signed-in person's name, Emirates ID and telephone number, and
 * KYCDD reads it within seconds.
 */
const DEFAULT_JOB_RETENTION_SECONDS = 1800;

/**
 * How long a repeat dispatch with the same idempotency key rejoins the existing
 * job. The key is derived from the service and inputs alone (see
 * RemoteInstruction::fingerprint()), so the same work next week has the same
 * key; the window only needs to cover a retried dispatch.
 */
const DEFAULT_IDEMPOTENCY_WINDOW_SECONDS = 600;

const DEFAULT_MAX_BODY_BYTES = 1048576;

/**
 * Runs execute one at a time, because the portals share one login each and a
 * second sign-in invalidates the first. The queue is a real wait, so it is kept
 * short rather than accepting work nobody will want by the time it runs.
 */
const DEFAULT_MAX_QUEUE_DEPTH = 8;

const DEFAULT_MODEL_DRIVER = 'openai';
const DEFAULT_API_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL_TIMEOUT_SECONDS = 180;

/**
 * How many screenshots stay in the conversation. Images dominate the cost of a
 * long run and an old screenshot is nearly worthless because the screen has
 * moved on; older ones are replaced with a line saying one was there.
 */
const DEFAULT_SCREENSHOT_HISTORY = 3;

/**
 * Screenshot sizing for the desktop surface, as a ratio rather than a width,
 * because the screen it will run against is not known in advance:
 *
 *  - MAX_SHRINK is the legibility target; 1.5x is comfortable for portal text.
 *  - MAX_SCREENSHOT_WIDTH bounds token cost on a large display, which is then
 *    read by zooming into regions rather than by a bigger capture.
 *  - MIN_SCREENSHOT_WIDTH stops a small screen being reduced to illegibility.
 */
const DEFAULT_MAX_SHRINK = 1.5;
const DEFAULT_MAX_SCREENSHOT_WIDTH = 1920;
const MIN_SCREENSHOT_WIDTH = 1024;

/**
 * Windows PowerShell 5.1 is on every supported Windows build and always has
 * System.Windows.Forms and System.Drawing, which the desktop host needs.
 */
const DEFAULT_POWERSHELL = 'powershell.exe';

export class ConfigError extends Error {
	/**
	 * @param {string[]} problems
	 */
	constructor(problems) {
		super(`The agent is not configured:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
		this.name = 'ConfigError';
		this.problems = problems;
	}
}

/**
 * Reads the configuration.
 *
 * @param {object} [options]
 * @param {boolean} [options.server] Also require what the HTTP server needs.
 * @param {object} [options.env] Defaults to process.env; injectable for tests.
 * @returns {Readonly<object>}
 * @throws {ConfigError}
 */
export function loadConfig({ server = false, env = process.env } = {}) {
	const problems = [];

	const text = (name) => String(env[name] ?? '').trim();

	const required = (name, purpose) => {
		const value = text(name);

		if (!value) {
			problems.push(`${name} is not set: ${purpose}.`);
		}

		return value;
	};

	const positive = (name, fallback, parse = Number.parseInt) => {
		const raw = text(name);

		if (!raw) {
			return fallback;
		}

		const value = parse(raw, 10);

		if (!Number.isFinite(value) || value <= 0) {
			problems.push(`${name} must be a positive number, got "${raw}".`);
			return fallback;
		}

		return value;
	};

	const location = (name, fallback) => {
		const value = text(name);

		return value ? path.resolve(ROOT, value) : fallback;
	};

	const json = (name, fallback) => {
		const value = text(name);

		if (!value) {
			return fallback;
		}

		try {
			const parsed = JSON.parse(value);

			return parsed && typeof parsed === 'object' ? parsed : fallback;
		} catch {
			problems.push(`${name} is not valid JSON.`);
			return fallback;
		}
	};

	const surface = (text('REMOTE_AGENT_SURFACE') || SURFACE_BROWSER).toLowerCase();

	if (!SURFACES.includes(surface)) {
		problems.push(`REMOTE_AGENT_SURFACE must be one of ${SURFACES.join(', ')}, got "${surface}".`);
	}

	/**
	 * Under the system temp directory by default, so nothing accumulates in the
	 * folder and a restart clears whatever a purge missed. One-time codes are
	 * dropped into `work/2fa.txt` under it.
	 */
	const artifactDir = location('REMOTE_AGENT_ARTIFACT_DIR', path.join(os.tmpdir(), 'kycdd-remote-agent', 'artifacts'));

	const config = {
		// ---- the HTTP server ------------------------------------------------
		host: text('REMOTE_AGENT_HOST') || DEFAULT_HOST,
		port: positive('REMOTE_AGENT_PORT', DEFAULT_PORT),

		/**
		 * Must match remote_browser_agent_token / remote_browser_agent_secret in
		 * the KYCDD .env. The token says which caller this is; the secret proves
		 * a request was not tampered with or replayed. Rotated independently.
		 */
		token: server ? required('REMOTE_AGENT_TOKEN', 'shared with KYCDD as remote_browser_agent_token') : text('REMOTE_AGENT_TOKEN'),
		secret: server ? required('REMOTE_AGENT_SECRET', 'shared with KYCDD as remote_browser_agent_secret') : text('REMOTE_AGENT_SECRET'),

		clockSkewSeconds: positive('REMOTE_AGENT_CLOCK_SKEW_SECONDS', DEFAULT_CLOCK_SKEW_SECONDS),
		jobRetentionSeconds: positive('REMOTE_AGENT_JOB_RETENTION_SECONDS', DEFAULT_JOB_RETENTION_SECONDS),
		idempotencyWindowSeconds: positive('REMOTE_AGENT_IDEMPOTENCY_WINDOW_SECONDS', DEFAULT_IDEMPOTENCY_WINDOW_SECONDS),
		maxBodyBytes: positive('REMOTE_AGENT_MAX_BODY_BYTES', DEFAULT_MAX_BODY_BYTES),
		maxQueueDepth: positive('REMOTE_AGENT_MAX_QUEUE_DEPTH', DEFAULT_MAX_QUEUE_DEPTH),
		supportedEnvelopeVersions: SUPPORTED_VERSIONS,

		// ---- how a task is worked -------------------------------------------
		/**
		 * deterministic: work a known portal from a scripted recipe, with no model
		 *   (see src/flows). The default, because it is cheaper, more reliable, and
		 *   keeps a live session out of a third party's request logs.
		 * ai: always use the model-driven loop.
		 */
		mode: (text('REMOTE_AGENT_MODE') || 'deterministic').toLowerCase(),

		/**
		 * Whether a deterministic run that gets stuck on an unexpected page may hand
		 * the task to the model. On by default; set to 0 to never involve the model
		 * (and so need no model key at all).
		 */
		deterministicFallback: text('REMOTE_AGENT_AI_FALLBACK') !== '0',

		// ---- the model (only needed for the ai path / fallback) -------------
		driver: (text('REMOTE_AGENT_MODEL_DRIVER') || DEFAULT_MODEL_DRIVER).toLowerCase(),

		/**
		 * Not required at load: a deterministic-only deployment needs no model.
		 * The driver errors if a run actually reaches for a model without a key,
		 * which is the right place for that to surface.
		 */
		apiKey: text('OPENAI_API_KEY'),
		model: text('REMOTE_AGENT_MODEL'),

		apiBaseUrl: (text('REMOTE_AGENT_API_BASE_URL') || DEFAULT_API_BASE_URL).replace(/\/+$/, ''),
		modelTimeoutSeconds: positive('REMOTE_AGENT_MODEL_TIMEOUT_SECONDS', DEFAULT_MODEL_TIMEOUT_SECONDS),
		screenshotHistory: positive('REMOTE_AGENT_SCREENSHOT_HISTORY', DEFAULT_SCREENSHOT_HISTORY),

		/**
		 * Off unless an operator turns it on. These requests carry a government
		 * portal's screens; none of that should be retained by a third party.
		 */
		storeConversation: text('REMOTE_AGENT_STORE_CONVERSATION') === '1',

		reasoningEffort: text('REMOTE_AGENT_REASONING_EFFORT') || null,

		// ---- what a run drives ------------------------------------------------
		surface,

		/**
		 * Persistent browser profiles, one per credential alias. This is what
		 * lets a session survive between runs, which matters because signing in
		 * again through UAE Pass invalidates the session already held. Deleting
		 * the directory signs every portal out.
		 */
		profileDir: location('REMOTE_AGENT_PROFILE_DIR', path.join(ROOT, 'profiles')),

		// ---- which Chrome, to look like a real browser ----------------------
		/**
		 * Drive the installed Google Chrome rather than Puppeteer's bundled
		 * Chromium, and with the automation flags stripped. reCAPTCHA Enterprise
		 * scores a plain automated Chromium (navigator.webdriver, the
		 * --enable-automation banner) as a bot; a real Chrome with those removed
		 * looks far more like a person. Set to '' to force the bundled Chromium.
		 */
		chromeChannel: process.env.REMOTE_AGENT_CHROME_CHANNEL === undefined ? 'chrome' : text('REMOTE_AGENT_CHROME_CHANNEL'),

		/** An explicit path to a Chrome build, overriding the channel. */
		chromePath: text('REMOTE_AGENT_CHROME_PATH') || null,

		/**
		 * Strongest against reCAPTCHA: connect to a Chrome YOU launched (your real
		 * profile, with history), instead of launching one. Start Chrome with
		 * --remote-debugging-port=9222 and set this to http://127.0.0.1:9222. When
		 * set, the agent attaches to that browser and does not launch its own.
		 */
		chromeConnectUrl: text('REMOTE_AGENT_CHROME_DEBUG_URL') || null,

		powershell: text('REMOTE_AGENT_POWERSHELL') || DEFAULT_POWERSHELL,

		/**
		 * Desktop surface: pushing the pointer into the top-left corner of the main
		 * monitor stops the run. On unless set to 0.
		 */
		desktopFailsafe: text('REMOTE_AGENT_DESKTOP_FAILSAFE') !== '0',

		/**
		 * Desktop surface, capturing tasks: the 127.0.0.1 debugging port of the
		 * real Chrome the tap starts. Any local process can drive a Chrome with this
		 * port open, so keep it off machines shared with untrusted users.
		 */
		desktopChromePort: positive('REMOTE_AGENT_DESKTOP_CHROME_PORT', 9333),
		maxShrink: positive('REMOTE_AGENT_MAX_SHRINK', DEFAULT_MAX_SHRINK, Number.parseFloat),
		maxScreenshotWidth: positive('REMOTE_AGENT_MAX_SCREENSHOT_WIDTH', DEFAULT_MAX_SCREENSHOT_WIDTH),
		minScreenshotWidth: MIN_SCREENSHOT_WIDTH,

		/** An override; unset, the desktop capture width is worked out from the screen. */
		screenshotWidth: text('REMOTE_AGENT_SCREENSHOT_WIDTH') ? positive('REMOTE_AGENT_SCREENSHOT_WIDTH', null) : null,

		// ---- UAE Pass app approval (two-factor) -------------------------------
		/**
		 * How a `uae_pass` task gets past the sign-in approval. A deliberate
		 * choice, never a default, because it is the step 2FA exists to keep a
		 * human in:
		 *  - `assist`  : alert the operator and wait while THEY approve on the
		 *                phone; the run survives the step, the person still
		 *                approves. See src/twofactor/HumanApproval.js.
		 *  - `auto`    : approve by itself on an Android emulator, fully
		 *                unattended. See src/twofactor/UaePassApp.js.
		 *  - `off`     : (default) fall back to a typed code from a file.
		 */
		uaePassApproval: (text('REMOTE_AGENT_UAE_PASS_APPROVAL') || 'off').toLowerCase(),

		/** `assist` mode beeps the desktop (not just the terminal bell) on an alert; set to 0 to silence that. */
		uaePassAlertSound: text('REMOTE_AGENT_UAE_PASS_ALERT_SOUND') !== '0',
		adbBinary: text('REMOTE_AGENT_ADB') || 'adb',
		emulatorSerial: text('REMOTE_AGENT_EMULATOR_SERIAL') || 'emulator-5554',
		uaePassPackage: text('REMOTE_AGENT_UAE_PASS_PACKAGE') || 'ae.uaepass.mainapp',
		uaePassApprovalTimeoutSeconds: positive('REMOTE_AGENT_UAE_PASS_APPROVAL_TIMEOUT_SECONDS', 180),
		uaePassUseFingerprint: text('REMOTE_AGENT_UAE_PASS_FINGERPRINT') !== '0',

		// ---- deterministic flow selectors (see src/flows/recipes) -----------
		/**
		 * Per-service DOM selectors for the deterministic recipes, as a JSON
		 * object keyed by service. Discover them with bin/inspect-dom.js against
		 * the live pages. Left unset, the recipe is "not ready" and the task falls
		 * back to the model.
		 *   REMOTE_AGENT_GROWTH_SELECTORS={"loginButton":"#login","idField":"#eid",...}
		 */
		growthSelectors: json('REMOTE_AGENT_GROWTH_SELECTORS', {}),

		/** Cookie names that signal a live Growth session, overridable per deployment. */
		growthCookies: json('REMOTE_AGENT_GROWTH_COOKIES', {}),

		/** On-screen labels that count as the approve control, any language. */
		uaePassApproveLabels: (text('REMOTE_AGENT_UAE_PASS_APPROVE_TEXT') || 'approve,allow,confirm,موافق,تأكيد,السماح')
			.split(',')
			.map((label) => label.trim())
			.filter(Boolean),

		/**
		 * The UAE Pass passcode, for an approval gated on a PIN rather than (or
		 * after) a fingerprint. A secret: it is read here and used only to decide
		 * which on-screen keypad buttons to tap. It is never passed to adb as text
		 * and never written to a log. Left unset, the channel relies on the
		 * fingerprint step (or whatever the account requires) instead.
		 */
		uaePassPin: text('REMOTE_AGENT_UAE_PASS_PIN') || null,

		/** Labels of the control that submits the passcode, any language. */
		uaePassConfirmLabels: (text('REMOTE_AGENT_UAE_PASS_CONFIRM_TEXT') || 'confirm,login,log in,sign in,continue,done,submit,تأكيد,دخول,تسجيل الدخول,متابعة')
			.split(',')
			.map((label) => label.trim())
			.filter(Boolean),

		// ---- files -------------------------------------------------------------
		artifactDir,
		workDir: path.join(artifactDir, 'work'),

		/**
		 * Portal credentials by alias. Optional: the same aliases can be given as
		 * REMOTE_AGENT_CRED_<ALIAS>_* variables instead. See src/credentials.js.
		 */
		credentialsFile: location('REMOTE_AGENT_CREDENTIALS_FILE', path.join(ROOT, 'credentials.json')),

		env,
	};

	if (problems.length > 0) {
		throw new ConfigError(problems);
	}

	return Object.freeze(config);
}
