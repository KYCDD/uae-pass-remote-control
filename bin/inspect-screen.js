#!/usr/bin/env node

/**
 * Read-only: dumps the controls on the device's current screen, so the UAE Pass
 * approve/keypad labels can be configured against the real app.
 *
 * It only reads (uiautomator dump). It never taps, types, or launches anything,
 * and it shows no secret. Run it while the screen you want to configure for is in
 * the foreground - e.g. the UAE Pass approval or PIN screen, which you reach by
 * starting a sign-in yourself.
 *
 *   node bin/inspect-screen.js [adb-serial]
 *
 * The serial defaults to REMOTE_AGENT_EMULATOR_SERIAL. The most important thing
 * it tells you: whether the screen is readable at all. A UAE Pass PIN screen
 * marked FLAG_SECURE comes back empty here, which means automation cannot read or
 * tap it and the app-approval channel will not work on that screen.
 */

import path from 'node:path';
import 'dotenv/config';

import { Adb } from '../src/twofactor/adb.js';

const serial = process.argv[2] || process.env.REMOTE_AGENT_EMULATOR_SERIAL;

if (!serial) {
	console.error('Usage: node bin/inspect-screen.js <adb-serial>  (or set REMOTE_AGENT_EMULATOR_SERIAL)');
	process.exit(2);
}

const binary = process.env.REMOTE_AGENT_ADB
	|| path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe');

const adb = new Adb({ binary, serial });

if (!(await adb.isOnline())) {
	console.error(`Device "${serial}" is not online. Check "adb devices".`);
	process.exit(1);
}

let xml = '';

try {
	xml = await adb.uiDump();
} catch (error) {
	console.error(`Could not read the screen: ${error.message}`);
	process.exit(1);
}

const nodes = [...xml.matchAll(/<node\b[^>]*>/g)]
	.map((match) => match[0])
	.map((tag) => ({
		text: /\btext="([^"]*)"/.exec(tag)?.[1] ?? '',
		desc: /\bcontent-desc="([^"]*)"/.exec(tag)?.[1] ?? '',
		clickable: /\bclickable="true"/.test(tag),
		secure: /\bpassword="true"/.test(tag),
		bounds: /\bbounds="(\[[^"]*\])"/.exec(tag)?.[1] ?? '',
	}))
	.filter((node) => node.text || node.desc);

if (nodes.length === 0) {
	console.log('The screen came back EMPTY.');
	console.log('If the UAE Pass approval/PIN screen is in the foreground, this almost certainly means it');
	console.log('is marked FLAG_SECURE: automation cannot read or tap it, so the app-approval channel');
	console.log('will not work on this screen. There is no way around that from the agent side.');
	process.exit(0);
}

console.log(`Readable. ${nodes.length} labelled node(s) on screen:\n`);

for (const node of nodes) {
	const label = node.text || `(${node.desc})`;
	const flags = [node.clickable ? 'clickable' : '', node.secure ? 'SECURE-FIELD' : ''].filter(Boolean).join(' ');
	console.log(`  ${node.bounds.padEnd(24)} ${flags.padEnd(22)} ${label}`);
}

console.log('\nUse the labels above to set REMOTE_AGENT_UAE_PASS_APPROVE_TEXT / _CONFIRM_TEXT.');
console.log('Digit keys showing as single-character text ("0".."9") confirm the keypad is readable.');
