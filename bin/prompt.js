#!/usr/bin/env node

/**
 * Tell the agent what to do in plain words, and it does it with this machine's
 * real mouse and keyboard.
 *
 *   node bin/prompt.js "Open growth.gov.ae and sign in" --credential growth_uae_pass --two-factor uae_pass
 *   node bin/prompt.js -i                       # keep prompting; each task carries on from the last
 *
 * Always drives the desktop surface (whatever REMOTE_AGENT_SURFACE says): the
 * point is to work the screen the way a person would, with no automated browser
 * involved. Needs OPENAI_API_KEY and REMOTE_AGENT_MODEL.
 *
 * To stop a run: push the mouse pointer into the top-left corner of the main
 * screen. (Ctrl-C works too, but only while this terminal has focus - which it
 * loses at the agent's first click.)
 *
 * Options:
 *   -i, --interactive        Prompt again after each task, with earlier tasks as context.
 *   -c, --credential ALIAS   Offer the stored credential ALIAS (typed, never shown to the model).
 *   --two-factor CHANNEL     Offer a two-factor step: "uae_pass" (phone approval, if enabled) or "file".
 *   --input KEY=VALUE        A value for the task to type (repeatable). Treated as data.
 *   --capture EXTRACTOR      Harvest something off the wire, e.g. "growth_session". Opens a real Chrome
 *                            (own profile, no Puppeteer) with a network tap that starts only when the
 *                            model calls start_recording after signing in. The harvest is saved to a
 *                            file, never printed.
 *   --url URL                Where that Chrome opens when it is first started.
 *   --steps N                Step cap per task (default 60).
 *   --timeout SECONDS        Time limit per task (default 900).
 *   --screenshots MODE       Keep screenshots: none | on_error (default) | every_step.
 *   --delay SECONDS          Countdown before taking control (default 3).
 *   --json                   Print the whole job object, not just the summary.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import 'dotenv/config';

import { loadConfig, SURFACE_DESKTOP } from '../src/config.js';
import { CredentialStore } from '../src/credentials.js';
import { buildAgent } from '../src/runTask.js';
import { promptEnvelope } from '../src/promptEnvelope.js';
import { extractorFor } from '../src/extractors/index.js';

const options = parseArgs(process.argv.slice(2));

if (options.help) {
	console.log(usage());
	process.exit(0);
}

if (!options.prompt && !options.interactive) {
	console.error(usage());
	process.exit(2);
}

const config = { ...loadConfig({ server: false }), surface: SURFACE_DESKTOP };

if (!config.apiKey || !config.model) {
	console.error('Set OPENAI_API_KEY and REMOTE_AGENT_MODEL (in .env) - prompted tasks are worked by the model.');
	process.exit(2);
}

if (options.capture && !extractorFor(options.capture)) {
	console.error(`Nothing knows how to capture "${options.capture}". Known: growth_session.`);
	process.exit(2);
}

const credentials = new CredentialStore({ file: config.credentialsFile, env: config.env });

if (options.credential && !credentials.has(options.credential)) {
	console.error(`No credentials are configured for "${options.credential}" (credentials.json or REMOTE_AGENT_CRED_* variables).`);
	process.exit(2);
}

const runDir = join(config.artifactDir, 'prompt-runs', new Date().toISOString().replace(/[:.]/g, '-'));
const history = [];

/** The run in progress, so Ctrl-C stops it rather than the whole program. */
let current = null;

process.on('SIGINT', () => {
	if (current) {
		console.error('\nStopping after the current step...');
		current.abort();
		return;
	}

	process.exit(130);
});

if (options.interactive) {
	const rl = createInterface({ input: stdin, output: stdout });

	// readline takes Ctrl-C for itself while it owns the terminal
	rl.on('SIGINT', () => process.emit('SIGINT'));

	console.log('Type a task for the agent, or "exit". Push the pointer into the top-left corner of the screen to stop a run.');

	if (options.prompt) {
		await runOne(options.prompt);
	}

	while (true) {
		let line;

		try {
			line = (await rl.question('\n> ')).trim();
		} catch {
			break; // input closed
		}

		if (!line) {
			continue;
		}

		if (['exit', 'quit'].includes(line.toLowerCase())) {
			break;
		}

		if (line.toLowerCase() === 'forget') {
			history.length = 0;
			console.log('Earlier tasks forgotten.');
			continue;
		}

		await runOne(line);
	}

	rl.close();
	process.exit(0);
} else {
	const outcome = await runOne(options.prompt);
	process.exit(outcome.ok ? 0 : 1);
}

/**
 * Runs one prompt as one task.
 *
 * @param {string} prompt
 * @returns {Promise<object>}
 */
async function runOne(prompt) {
	const envelope = promptEnvelope(prompt, {
		credentialAlias: options.credential,
		twoFactor: options.twoFactor,
		inputs: options.inputs,
		maxSteps: options.steps,
		timeoutSeconds: options.timeout,
		screenshots: options.screenshots,
		history: history.slice(-5),
		capture: options.capture,
		url: options.url,
	});

	const steps = [];
	const artifacts = [];
	const controller = new AbortController();

	await countdown(options.delay);

	const agent = await buildAgent(envelope, {
		config,
		credentials,
		signal: controller.signal,
		recordStep: (name, detail) => {
			steps.push({ step: steps.length + 1, at: new Date().toISOString(), name, detail: detail ?? null });
			const fields = detail && (detail.found || detail.missing)
				? ` (found: ${(detail.found ?? []).join(', ') || 'none'}; missing: ${(detail.missing ?? []).join(', ') || 'none'})`
				: '';
			console.error(`  · ${name}${fields}`);
		},
		putArtifact: (artifact) => {
			mkdirSync(runDir, { recursive: true });
			const file = join(runDir, `${history.length + 1}-${artifacts.length + 1}-${artifact.name ?? 'artifact'}`);
			writeFileSync(file, artifact.data);
			const record = { id: String(artifacts.length + 1), kind: artifact.kind, file };
			artifacts.push(record);
			return record;
		},
	});

	current = controller;
	let outcome;

	try {
		outcome = await agent.run();
	} finally {
		current = null;
	}

	// What came off the wire is a live session: saved to a file, never printed
	let harvest = null;

	// A run that was stopped or failed after capturing still keeps what it got
	const source = outcome.result ?? (Object.keys(agent.captured ?? {}).length > 0 ? { summary: outcome.error ?? '', details: '', ...agent.captured } : null);

	if (options.capture && source) {
		const { summary, details, ...captured } = source;

		if (Object.keys(captured).length > 0) {
			mkdirSync(runDir, { recursive: true });
			const file = join(runDir, `${history.length + 1}-${options.capture}.json`);
			writeFileSync(file, JSON.stringify(captured, null, 2));
			harvest = {
				file,
				harvested: captured.harvested === true,
				found: Object.keys(captured).filter((key) => typeof captured[key] === 'string' && captured[key] !== ''),
			};
			if (outcome.result) {
				outcome.result = { summary, details, harvest };
			}
		}
	}

	if (options.json) {
		console.log(JSON.stringify({ ...outcome, steps, steps_taken: steps.length, artifacts }, null, 2));
	} else {
		console.log(`\n[${outcome.outcome}] ${outcome.result?.summary ?? outcome.error ?? ''}`);

		if (outcome.result?.details) {
			console.log(outcome.result.details);
		}

		if (harvest) {
			console.log(`  ${options.capture}: ${harvest.harvested ? 'harvested' : 'INCOMPLETE'} (found: ${harvest.found.join(', ') || 'nothing'})`);
			console.log(`  saved to: ${harvest.file}`);
		} else if (options.capture) {
			console.log(`  ${options.capture}: nothing was captured.`);
		}

		for (const artifact of artifacts) {
			console.log(`  screenshot: ${artifact.file}`);
		}
	}

	history.push({
		prompt,
		outcome: outcome.outcome,
		summary: String(outcome.result?.summary ?? outcome.error ?? '').slice(0, 400),
	});

	return outcome;
}

/**
 * Gives the operator a moment to take their hands off the mouse.
 *
 * @param {number} seconds
 */
async function countdown(seconds) {
	for (let left = seconds; left > 0; left--) {
		process.stderr.write(`\rTaking control of the mouse and keyboard in ${left}... `);
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}

	if (seconds > 0) {
		process.stderr.write('\r' + ' '.repeat(60) + '\r');
	}
}

/**
 * @param {string[]} argv
 * @returns {object}
 */
function parseArgs(argv) {
	const parsed = {
		prompt: '',
		interactive: false,
		credential: null,
		twoFactor: null,
		inputs: {},
		steps: undefined,
		timeout: undefined,
		screenshots: undefined,
		capture: null,
		url: null,
		delay: 3,
		json: false,
		help: false,
	};
	const words = [];

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		const value = () => {
			const next = argv[++index];

			if (next === undefined) {
				console.error(`${arg} needs a value.`);
				process.exit(2);
			}

			return next;
		};

		switch (arg) {
			case '-i':
			case '--interactive':
				parsed.interactive = true;
				break;
			case '-c':
			case '--credential':
				parsed.credential = value();
				break;
			case '--two-factor':
				parsed.twoFactor = value();
				break;
			case '--input': {
				const pair = value();
				const at = pair.indexOf('=');

				if (at < 1) {
					console.error(`--input expects KEY=VALUE, got "${pair}".`);
					process.exit(2);
				}

				parsed.inputs[pair.slice(0, at)] = pair.slice(at + 1);
				break;
			}
			case '--capture':
				parsed.capture = value();
				break;
			case '--url':
				parsed.url = value();
				break;
			case '--steps':
				parsed.steps = Number(value());
				break;
			case '--timeout':
				parsed.timeout = Number(value());
				break;
			case '--screenshots':
				parsed.screenshots = value();
				break;
			case '--delay':
				parsed.delay = Math.max(0, Number(value()) || 0);
				break;
			case '--json':
				parsed.json = true;
				break;
			case '-h':
			case '--help':
				parsed.help = true;
				break;
			default:
				if (arg.startsWith('-')) {
					console.error(`Unknown option ${arg}.\n\n${usage()}`);
					process.exit(2);
				}

				words.push(arg);
		}
	}

	parsed.prompt = words.join(' ').trim();

	return parsed;
}

function usage() {
	return [
		'Usage: node bin/prompt.js "<what to do>" [options]',
		'       node bin/prompt.js -i [options]',
		'',
		'  -i, --interactive        keep prompting; earlier tasks are passed as context',
		'  -c, --credential ALIAS   offer a stored credential (typed, never shown to the model)',
		'  --two-factor CHANNEL     uae_pass (phone approval, if enabled) or file',
		'  --input KEY=VALUE        a value to type (repeatable)',
		'  --capture EXTRACTOR      harvest off the wire (growth_session) via a tapped real Chrome',
		'  --url URL                where that Chrome opens when first started',
		'  --steps N                step cap per task (default 60)',
		'  --timeout SECONDS        time limit per task (default 900)',
		'  --screenshots MODE       none | on_error (default) | every_step',
		'  --delay SECONDS          countdown before taking control (default 3)',
		'  --json                   print the whole job object',
		'',
		'Stop a run by pushing the mouse pointer into the top-left corner of the main screen.',
	].join('\n');
}
