#!/usr/bin/env node

/**
 * Keeps the approval phone's screen on, so a UAE Pass prompt is visible the
 * moment it arrives. Run it and leave it running alongside the agent.
 *
 *   node bin/keep-awake.js [adb-serial]
 *   node bin/keep-awake.js --timeout 1800000      # also raise the screen-off timeout (ms), restored on exit
 *   node bin/keep-awake.js --interval 15          # heartbeat seconds (default 30)
 *   node bin/keep-awake.js --once                 # assert once and exit, no heartbeat
 *
 * The serial defaults to REMOTE_AGENT_EMULATOR_SERIAL. If it looks like
 * host:port (wireless debugging), `adb connect` is tried first.
 *
 * It only keeps the screen lit: it sets "stay awake while charging" (the phone
 * is on USB), nudges the screen awake if it slept, and re-asserts on a timer. It
 * never unlocks the phone, taps anything, or approves anything. Ctrl-C stops it.
 */

import path from 'node:path';
import 'dotenv/config';

import { Adb } from '../src/twofactor/adb.js';
import { KeepAwake } from '../src/twofactor/KeepAwake.js';

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--timeout', '--interval']);
const flag = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const has = (name) => args.includes(name);

// Positionals: args that are neither a flag nor the value right after a value-flag.
const positionals = args.filter((a, i) => !a.startsWith('-') && !VALUE_FLAGS.has(args[i - 1]));
const serial = positionals[0] || process.env.REMOTE_AGENT_EMULATOR_SERIAL;

if (!serial) {
	console.error('Usage: node bin/keep-awake.js <adb-serial>  (or set REMOTE_AGENT_EMULATOR_SERIAL)');
	process.exit(2);
}

const binary = process.env.REMOTE_AGENT_ADB
	|| path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe');

const intervalMs = (Number.parseFloat(flag('--interval')) || 30) * 1000;
const screenTimeoutMs = flag('--timeout') ? Number.parseInt(flag('--timeout'), 10) : null;

const adb = new Adb({ binary, serial });

// Wireless debugging: a serial of host:port needs `adb connect` before it is seen.
if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(serial)) {
	process.stdout.write(`Connecting to ${serial}... `);
	console.log(await adb.connect(serial).catch((error) => `failed: ${error.message}`));
}

if (!(await adb.isOnline())) {
	const seen = await adb.devices().catch(() => []);
	console.error(`Device "${serial}" is not online. Check "adb devices".`);

	if (seen.length) {
		console.error('adb currently sees:');
		for (const d of seen) {
			console.error(`  ${d.serial}\t${d.state}${d.model ? `  (${d.model})` : ''}`);
		}
	} else {
		console.error('adb sees no devices. Plug the phone in over USB and accept the "Allow USB debugging?" prompt on it.');
	}

	process.exit(1);
}

const stamp = () => new Date().toLocaleTimeString();

const keepAwake = new KeepAwake({
	adb,
	intervalMs,
	screenTimeoutMs,
	onBeat: ({ type, screenOn, mask, note }) => {
		if (type === 'error') {
			console.error(`[${stamp()}] heartbeat error: ${note}`);
			return;
		}

		if (type === 'offline') {
			console.error(`[${stamp()}] phone unreachable - ${note}`);
			return;
		}

		const screen = screenOn === true ? 'screen ON' : screenOn === false ? 'screen off -> woke it' : 'screen state unreadable';
		const stay = mask === null ? 'stay-awake unreadable' : mask > 0 ? 'stay-awake set' : 'stay-awake NOT set';
		console.log(`[${stamp()}] ${screen}, ${stay}${note ? ` - ${note}` : ''}`);
	},
});

let stopping = false;

async function shutdown() {
	if (stopping) {
		return;
	}

	stopping = true;
	console.log('\nStopping (the screen will sleep again on its own timeout).');
	await keepAwake.stop();
	process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const model = (await adb.devices().catch(() => [])).find((d) => d.serial === serial)?.model;
console.log(`Keeping ${serial}${model ? ` (${model})` : ''} awake. Heartbeat every ${intervalMs / 1000}s. Ctrl-C to stop.\n`);

await keepAwake.start();

if (has('--once')) {
	await keepAwake.stop();
	console.log('Asserted once (--once); exiting.');
	process.exit(0);
}

// Keep the process alive; the heartbeat timer is unref'd so it would not on its own.
setInterval(() => {}, 1 << 30);
