#!/usr/bin/env node

/**
 * Opens the persistent `inspect` browser profile and holds it open, so you can
 * sign in by hand. The session is saved in that profile, so a later
 * `bin/inspect-dom.js` (which uses the same profile) will already be signed in
 * and can read the screens behind the login.
 *
 * This types nothing and reads nothing - it just opens a window for you to drive.
 *
 *   node bin/open-profile.js                       # opens the Growth landing page
 *   node bin/open-profile.js <url>                 # opens a specific page
 *
 * Sign in (service -> Digital Identity -> UAE Pass -> approve on your phone),
 * navigate to the Economic Licence Enquiry screen so the licence field is
 * visible, then press Ctrl+C here to save the session and close.
 */

import 'dotenv/config';

import { loadConfig } from '../src/config.js';

const url = process.argv[2] || 'https://www.growth.gov.ae/G2C/';

const config = loadConfig({ server: false });
const { BrowserSurface } = await import('../src/surface/BrowserSurface.js');

const surface = new BrowserSurface({
	// Broad so your manual sign-in can cross to MOEC and UAE Pass and back
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

let closing = false;
const close = async () => {
	if (closing) return;
	closing = true;
	console.log('\nSaving the profile and closing...');
	await surface.close();
	process.exit(0);
};

process.on('SIGINT', close);
process.on('SIGTERM', close);

await surface.open();
await surface.go(url);

console.log('\nBrowser open on the "inspect" profile.');
console.log('  1. Sign in: open the Economic Licence Enquiry service, then "Login with Digital Identity",');
console.log('     enter your Emirates ID on UAE Pass, and approve on your phone.');
console.log('  2. Navigate to the Economic Licence Enquiry screen (so the licence field is on screen).');
console.log('  3. Press Ctrl+C here to save the session and close.\n');

// Hold open until interrupted
await new Promise(() => {});
