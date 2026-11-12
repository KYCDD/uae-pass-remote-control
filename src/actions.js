/**
 * The action vocabulary: the contract between the model driver, the agent loop
 * and the surface that carries actions out.
 *
 * This exists so that neither the loop nor a surface ever sees a vendor's wire
 * format. A driver's only job is to offer these as tools and translate the
 * model's calls back into them, which is what makes the model swappable, and a
 * surface's only job is to carry out the screen actions, which is what makes the
 * browser and the desktop interchangeable. Nothing in src/surface or
 * src/Agent.js should ever branch on which model is running.
 *
 * Three groups, and the distinction matters:
 *
 *  - SCREEN_ACTIONS are carried out by the surface: pointer, keyboard, and (on
 *    a surface that can) navigation.
 *
 *  - LOOP_ACTIONS are carried out by the agent loop itself, whatever the
 *    surface: looking, waiting, and the ones that exist only here.
 *    `type_credential` and `type_two_factor_code` let a secret be entered
 *    without the model ever holding it. `capture` is the deterministic half of a
 *    harvest: the model says when the portal has done what was needed, and this
 *    machine reads the values off its own network log. The connection details
 *    behind a Growth session live in a request header and JSON request bodies,
 *    and no amount of screenshotting will produce them.
 *
 *  - TERMINAL_ACTIONS end the run.
 *
 * Coordinates are always in the pixels of the screenshot the model was last
 * shown; the surface maps them to the real screen (see src/surface/view.js).
 */

import { TYPEABLE_FIELDS } from './credentials.js';

export const SCREEN_ACTIONS = ['click', 'move', 'drag', 'scroll', 'type', 'keypress', 'navigate'];
export const LOOP_ACTIONS = ['screenshot', 'wait', 'type_credential', 'type_two_factor_code', 'start_recording', 'capture'];
export const TERMINAL_ACTIONS = ['finish', 'give_up'];

export const ALL_ACTIONS = [...SCREEN_ACTIONS, ...LOOP_ACTIONS, ...TERMINAL_ACTIONS];

/** Actions that leave the screen as it was, so need no fresh look afterwards. */
export const PASSIVE_ACTIONS = ['screenshot', 'start_recording', 'capture'];

/** The longest single wait, in seconds. Longer idles are several waits, each re-reading the screen. */
export const MAX_WAIT_SECONDS = 30;

/**
 * Key names the surfaces accept in a chord. Single letters and digits are
 * accepted as well.
 */
export const KEY_NAMES = [
	'enter', 'tab', 'escape', 'space', 'backspace', 'delete', 'insert', 'home', 'end', 'pageup', 'pagedown',
	'up', 'down', 'left', 'right', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
	'shift', 'ctrl', 'alt', 'win',
];

const POINT = { type: 'number' };

/**
 * What each action is and takes, vendor-neutral. A driver wraps these in its
 * own tool format; `finish` and `give_up` are completed per task by toolSpecs().
 */
const SPECS = {
	screenshot: {
		description: 'Look at the screen again without acting - while a slow page finishes rendering - or look closer by passing a region. A fresh screenshot is attached automatically after every action, so you rarely need this just to see the result of one.',
		parameters: {
			type: 'object',
			properties: {
				region: {
					type: 'object',
					description: 'Read part of the screen at full size or larger, instead of the whole screen. Give the rectangle in the coordinates of the screenshot you were last shown. Use this whenever text is too small to read with confidence. Until you next act, coordinates you give refer to this closer view.',
					properties: { x: POINT, y: POINT, width: POINT, height: POINT },
					required: ['x', 'y', 'width', 'height'],
				},
				monitor: {
					type: 'string',
					enum: ['primary', 'all'],
					description: 'Only on a machine with several monitors: "all" captures every monitor at once, smaller and harder to read. Use it only to find a window that opened on another screen.',
				},
			},
		},
		required: [],
	},
	click: {
		description: 'Click at a point on the screenshot you were last shown, in that image\'s pixels from its top-left corner.',
		parameters: {
			type: 'object',
			properties: {
				x: POINT,
				y: POINT,
				button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Defaults to left.' },
				count: { type: 'integer', description: '2 for a double click. Defaults to 1.' },
				what: { type: 'string', description: 'What you believe you are clicking, in a few words. Recorded in the run log.' },
			},
			required: ['x', 'y'],
		},
		required: ['x', 'y'],
	},
	move: {
		description: 'Move the pointer without clicking, to reveal a tooltip or a menu that opens on hover.',
		parameters: { type: 'object', properties: { x: POINT, y: POINT }, required: ['x', 'y'] },
		required: ['x', 'y'],
	},
	drag: {
		description: 'Press at one point, move to another, and release.',
		parameters: {
			type: 'object',
			properties: { from_x: POINT, from_y: POINT, to_x: POINT, to_y: POINT },
			required: ['from_x', 'from_y', 'to_x', 'to_y'],
		},
		required: ['from_x', 'from_y', 'to_x', 'to_y'],
	},
	scroll: {
		description: 'Turn the mouse wheel. Positive clicks scroll up (or left), negative scroll down (or right). Give a point to scroll the area under it.',
		parameters: {
			type: 'object',
			properties: {
				clicks: { type: 'integer', description: 'Wheel notches. Negative scrolls down.' },
				x: POINT,
				y: POINT,
				horizontal: { type: 'boolean', description: 'Scroll sideways instead.' },
			},
			required: ['clicks'],
		},
		required: ['clicks'],
	},
	type: {
		description: 'Type text into whatever has focus. Click the field first. Never use this for a password.',
		parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
		required: ['text'],
	},
	keypress: {
		description: `Press keys together as a chord, e.g. ["enter"], ["tab"], ["ctrl","a"]. Names: ${KEY_NAMES.join(', ')}, or a single letter or digit.`,
		parameters: {
			type: 'object',
			properties: { keys: { type: 'array', items: { type: 'string' } } },
			required: ['keys'],
		},
		required: ['keys'],
	},
	navigate: {
		description: 'Go straight to a URL, which is more reliable than typing into the address bar. Only this task\'s own origins are permitted; anywhere else is refused.',
		parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
		required: ['url'],
	},
	wait: {
		description: `Wait, then look again. These portals routinely render an empty table or a half-drawn form before the data arrives. At most ${MAX_WAIT_SECONDS} seconds.`,
		parameters: {
			type: 'object',
			properties: {
				seconds: { type: 'number' },
				why: { type: 'string', description: 'What you are waiting for.' },
			},
			required: ['seconds'],
		},
		required: [],
	},
	type_credential: {
		description: 'Type the stored username or password for this task\'s credential into the focused field. You are never shown the value. Click the field first.',
		parameters: {
			type: 'object',
			properties: { field: { type: 'string', enum: TYPEABLE_FIELDS } },
			required: ['field'],
		},
		required: ['field'],
	},
	type_two_factor_code: {
		description: 'Wait for the one-time code to arrive on this machine and type it into the focused field. Click the code field first. This blocks until the code arrives, so call it once.',
		parameters: { type: 'object', properties: {} },
		required: [],
	},
	start_recording: {
		description: 'Start recording the network traffic of the browser, so capture has something to read. Call it once you are signed in, before you trigger the calls capture needs. Nothing is recorded before this, so anything done earlier has to be done again afterwards.',
		parameters: { type: 'object', properties: {} },
		required: [],
	},
	capture: {
		description: 'Read the connection details out of the requests the browser has already sent. Replies with which values were found and which are still missing. You are not shown the values themselves.',
		parameters: { type: 'object', properties: {} },
		required: [],
	},
	finish: {
		description: 'End the run with the result. Every required field must be present; use an empty string or an empty array for anything the portal did not show, and put anything else worth saying in notes.',
		required: ['result'],
	},
	give_up: {
		description: 'End the run without a result, because you have hit a dead end. Say which, so the platform can tell "the portal had nothing" apart from "the agent broke".',
		required: ['outcome'],
	},
};

/**
 * The tools for one task, vendor-neutral.
 *
 * @param {object} envelope
 * @param {string[]} offered Which actions this run offers, see Agent.offeredActions().
 * @param {object} [options]
 * @param {string[]} [options.credentialFields] Which credential fields exist for
 *        this task, so type_credential only offers the ones that can be typed. A
 *        UAE Pass credential is the ID alone, so offering "password" would invite
 *        the model to type one that is not there.
 * @returns {{name: string, description: string, parameters: object}[]}
 */
export function toolSpecs(envelope, offered, { credentialFields } = {}) {
	const deadEnds = [...new Set(Object.values(envelope.instructions.deadEnds).map(String))];

	return offered.map((name) => {
		const spec = SPECS[name];

		if (name === 'type_credential') {
			const fields = credentialFields?.length ? credentialFields : TYPEABLE_FIELDS;

			return {
				name,
				description: spec.description,
				parameters: {
					type: 'object',
					properties: { field: { type: 'string', enum: fields } },
					required: ['field'],
				},
			};
		}

		if (name === 'finish') {
			return {
				name,
				description: spec.description,
				parameters: {
					type: 'object',
					properties: { result: envelope.resultSchema },
					required: ['result'],
				},
			};
		}

		if (name === 'give_up') {
			return {
				name,
				description: spec.description,
				parameters: {
					type: 'object',
					properties: {
						outcome: deadEnds.length > 0
							? { type: 'string', enum: deadEnds, description: 'The dead end you reached.' }
							: { type: 'string', description: 'A short machine-readable reason.' },
						reason: { type: 'string', description: 'What you saw that led you to stop.' },
					},
					required: ['outcome', 'reason'],
				},
			};
		}

		return { name, description: spec.description, parameters: spec.parameters };
	});
}

/**
 * Builds an action, checking it carries what is needed to carry it out.
 *
 * Drivers call this rather than constructing objects by hand, so that a model
 * that leaves out a field fails here - with the offending payload, reported back
 * to it - rather than three layers down as a click at (undefined, undefined).
 *
 * @param {string} type
 * @param {object} args
 * @returns {{type: string, args: object}}
 */
export function action(type, args = {}) {
	if (!ALL_ACTIONS.includes(type)) {
		throw new ActionError(`There is no action called "${type}".`);
	}

	for (const field of SPECS[type].required) {
		if (args?.[field] === undefined || args?.[field] === null) {
			throw new ActionError(`Action "${type}" is missing "${field}".`, { type, args });
		}
	}

	return { type, args: args ?? {} };
}

/**
 * Thrown when an action cannot be carried out as asked. Reported back to the
 * model, which can usually correct it; it does not end the run.
 */
export class ActionError extends Error {
	constructor(message, detail = null) {
		super(message);
		this.name = 'ActionError';
		this.detail = detail;
	}
}

/**
 * A one-line description of an action, for the step log.
 *
 * This is the only place an action is turned into text that leaves the machine,
 * so it is also where secrets are kept out of it. Typed text is summarised by
 * length rather than quoted: the step log is written to the KYCDD failure log,
 * read by people with no need to see what was typed.
 *
 * @param {{type: string, args: object}} act
 * @returns {string}
 */
export function describe(act) {
	const { type, args } = act;

	switch (type) {
		case 'click':
			return `${args.count === 2 ? 'double click' : 'click'} at (${args.x}, ${args.y})${args.what ? ` on ${String(args.what).slice(0, 80)}` : ''}`;
		case 'move':
			return `move to (${args.x}, ${args.y})`;
		case 'drag':
			return `drag from (${args.from_x}, ${args.from_y}) to (${args.to_x}, ${args.to_y})`;
		case 'scroll':
			return `scroll ${args.clicks} notches${args.horizontal ? ' sideways' : ''}`;
		case 'type':
			return `type ${String(args.text ?? '').length} characters`;
		case 'keypress':
			return `press ${(args.keys ?? []).join('+')}`;
		case 'navigate':
			return `navigate to ${safeUrl(args.url)}`;
		case 'screenshot':
			return args.region ? 'look closer at a region' : 'look at the screen';
		case 'wait':
			return `wait ${args.seconds ?? 1}s${args.why ? ` for ${String(args.why).slice(0, 80)}` : ''}`;
		case 'type_credential':
			// The field is safe to name; the value is not
			return `type the stored ${args.field}`;
		case 'type_two_factor_code':
			return 'type the one-time code';
		case 'start_recording':
			return 'start recording network traffic';
		case 'capture':
			return 'capture the connection details';
		case 'finish':
			return 'finish with a result';
		case 'give_up':
			return `give up: ${args.outcome}`;
		default:
			return type;
	}
}

/**
 * A URL with its query string dropped. Growth puts an encrypted licence number
 * in the detail URL and these portals routinely put identifiers in query
 * strings, none of which belongs in a log.
 *
 * @param {string} url
 * @returns {string}
 */
export function safeUrl(url) {
	try {
		const parsed = new URL(url);
		return `${parsed.origin}${parsed.pathname}`;
	} catch {
		return '(unparseable url)';
	}
}
