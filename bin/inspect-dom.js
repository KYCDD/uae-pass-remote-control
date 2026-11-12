#!/usr/bin/env node

/**
 * Read-only: opens a page in the browser surface and lists the controls on it
 * with a usable CSS selector for each, so the deterministic recipe's selectors
 * (REMOTE_AGENT_GROWTH_SELECTORS) can be filled against the live portal.
 *
 * It navigates and reads the DOM. It does not type, click, or sign in. Point it
 * at the pages you need selectors for - the Growth landing page, the UAE Pass
 * sign-in page, the enquiry screen (once you are signed in in that profile).
 *
 *   node bin/inspect-dom.js https://www.growth.gov.ae/G2C/
 *
 * The profile is persistent and per the given origin, so if you sign in once by
 * hand in the opened window, a later inspection of a post-login screen will see
 * it.
 */

import 'dotenv/config';

import { loadConfig } from '../src/config.js';

const url = process.argv[2];

if (!url) {
	console.error('Usage: node bin/inspect-dom.js <url>');
	process.exit(2);
}

let origin;

try {
	origin = new URL(url).origin;
} catch {
	console.error(`Not a valid URL: ${url}`);
	process.exit(2);
}

const config = loadConfig({ server: false });
const { BrowserSurface } = await import('../src/surface/BrowserSurface.js');

const surface = new BrowserSurface({
	allowedOrigins: [origin],
	profileRoot: config.profileDir,
	profileKey: 'inspect',
	chromeChannel: config.chromeChannel,
	chromePath: config.chromePath,
	connectUrl: config.chromeConnectUrl,
});

await surface.open();

try {
	await surface.go(url);

	// These are single-page apps: the shell paints first and the controls arrive
	// later, so wait for them rather than guessing a fixed delay. Poll until some
	// controls exist or ~25s passes.
	const deadline = Date.now() + 25000;
	let count = 0;

	while (Date.now() < deadline) {
		count = await surface.evaluate(() => document.querySelectorAll('input, button, a, select, [role="button"]').length);

		if (count >= 3) {
			break;
		}

		await new Promise((resolve) => setTimeout(resolve, 1000));
	}

	// Diagnostics: where we ended up and how much actually rendered
	const info = await surface.evaluate(() => ({
		url: location.href,
		title: document.title,
		textLength: (document.body?.innerText || '').length,
		iframes: document.querySelectorAll('iframe').length,
	}));

	console.log(`\nfinal url:   ${info.url}`);
	console.log(`title:       ${info.title}`);
	console.log(`body text:   ${info.textLength} chars${info.textLength < 50 ? '  <-- page looks essentially blank' : ''}`);
	console.log(`iframes:     ${info.iframes}${info.iframes ? '  <-- content may be inside an iframe (selectors differ)' : ''}`);
	console.log(`controls:    ${count}`);

	const scan = () => {
		const cssSelector = (el) => {
			if (el.id) return `#${CSS.escape(el.id)}`;
			if (el.name) return `${el.tagName.toLowerCase()}[name="${el.name}"]`;
			const aria = el.getAttribute('aria-label');
			if (aria) return `${el.tagName.toLowerCase()}[aria-label="${aria}"]`;
			if (el.tagName === 'A' && el.getAttribute('href')) {
				const href = el.getAttribute('href');
				if (href && href !== '#' && !href.startsWith('javascript')) return `a[href="${href}"]`;
			}
			const cls = (el.className && typeof el.className === 'string') ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
			return `${el.tagName.toLowerCase()}${cls}`;
		};

		return [...document.querySelectorAll('input, button, a, select, [role="button"], [onclick]')]
			.filter((el) => el.offsetParent !== null)
			.slice(0, 120)
			.map((el) => ({
				tag: el.tagName.toLowerCase(),
				type: el.getAttribute('type') || '',
				text: (el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('aria-label') || '').trim().slice(0, 50),
				selector: cssSelector(el),
			}));
	};

	// Walk every frame: these apps put the working screens inside an iframe, and a
	// selector only resolves within its own frame.
	const frames = surface.page.frames();

	for (const frame of frames) {
		let controls = [];
		try { controls = await frame.evaluate(scan); } catch { continue; }
		if (controls.length === 0) continue;

		const where = frame === surface.page.mainFrame() ? 'main document' : `iframe: ${frame.url().split('?')[0]}`;
		console.log(`\n--- ${where} (${controls.length} control(s)) ---`);

		for (const c of controls) {
			const label = `${c.tag}${c.type ? `[${c.type}]` : ''}`;
			console.log(`  ${c.selector.padEnd(42)} ${label.padEnd(14)} ${c.text}`);
		}
	}

	console.log('\nMap these to REMOTE_AGENT_GROWTH_SELECTORS keys:');
	console.log('  loginButton, idField, idSubmit, enquiryNav, licenceInput, searchButton, firstResult, exportButton');
} finally {
	await surface.close();
}
