#!/usr/bin/env node

/**
 * Opens the persistent `inspect` profile, holds it open for you to sign in by
 * hand, and dumps the controls on the CURRENT screen whenever you press Enter -
 * all in one browser, so there is no profile-lock clash with a second tool.
 *
 *   node bin/inspect-live.js
 *
 * Sign in (service -> Digital Identity -> UAE Pass -> approve on your phone),
 * navigate to the Economic Licence Enquiry screen, then press Enter here. It
 * prints every control with a selector, across all frames, and also writes the
 * snapshot to a file so it can be read back. Press Ctrl+C to close.
 *
 * It types nothing and submits nothing - it only reads the screen you drive to.
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import 'dotenv/config';

import { loadConfig } from '../src/config.js';

const config = loadConfig({ server: false });
const { BrowserSurface } = await import('../src/surface/BrowserSurface.js');

const OUT = path.join(os.tmpdir(), 'kycdd-inspect-latest.txt');

const surface = new BrowserSurface({
	allowedOrigins: [
		'https://www.growth.gov.ae', 'https://id.moec.gov.ae', 'https://www.moec.gov.ae',
		'https://ids.uaepass.ae', 'https://id.uaepass.ae', 'https://uaepass.ae', 'https://selfcare.uaepass.ae',
	],
	profileRoot: config.profileDir,
	profileKey: 'inspect',
	chromeChannel: config.chromeChannel,
	chromePath: config.chromePath,
	connectUrl: config.chromeConnectUrl,
});

const DUMP = () => {
	const fn = () => {
		const txt = (el) => (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 60);
		const sel = (el) => {
			if (el.id) return `#${CSS.escape(el.id)}`;
			if (el.name) return `${el.tagName.toLowerCase()}[name="${el.name}"]`;
			const ph = el.getAttribute('placeholder');
			if (ph) return `${el.tagName.toLowerCase()}[placeholder="${ph}"]`;
			const aria = el.getAttribute('aria-label');
			if (aria) return `${el.tagName.toLowerCase()}[aria-label="${aria}"]`;
			return el.tagName.toLowerCase();
		};
		const vis = (el) => el.offsetParent !== null;
		return {
			url: location.href,
			title: document.title,
			inputs: [...document.querySelectorAll('input, select, textarea')].filter(vis).slice(0, 25).map((e) => ({ selector: sel(e), type: e.type || e.tagName.toLowerCase(), label: txt(e) })),
			buttons: [...document.querySelectorAll('button, a[role="button"], input[type="submit"], a.btn, [onclick]')].filter(vis).slice(0, 30).map((e) => ({ selector: sel(e), label: txt(e) })),
		};
	};

	return fn;
};

async function snapshot() {
	const lines = [];
	for (const frame of surface.page.frames()) {
		let data;
		try { data = await frame.evaluate(DUMP()); } catch { continue; }
		if ((data.inputs.length + data.buttons.length) === 0) continue;
		lines.push(`\n=== frame ${frame.url().slice(0, 90)} ===`);
		lines.push(`title: ${data.title}`);
		lines.push('INPUTS:');
		for (const i of data.inputs) lines.push(`   ${i.selector.padEnd(36)} [${i.type}] ${i.label}`);
		lines.push('BUTTONS:');
		for (const b of data.buttons) lines.push(`   ${b.selector.padEnd(36)} ${b.label}`);
	}
	const out = lines.join('\n') || '(no controls found on the current screen)';
	console.log(out);
	try { fs.writeFileSync(OUT, out); console.log(`\n[written to ${OUT}]`); } catch { /* ignore */ }
}

let closing = false;
const close = async () => { if (closing) return; closing = true; console.log('\nclosing...'); await surface.close(); process.exit(0); };
process.on('SIGINT', close);

await surface.open();
await surface.go('https://www.growth.gov.ae/G2C/');

console.log('\nBrowser open on the "inspect" profile.');
console.log('Sign in and navigate to the Economic Licence Enquiry screen, then press Enter here to capture it.');
console.log('Press Ctrl+C to close.\n');

process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
	if (String(chunk).trim().toLowerCase() === 'q') { close(); return; }
	snapshot();
});
