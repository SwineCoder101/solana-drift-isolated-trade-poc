import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const packagePath = path.resolve(__dirname, '..', 'node_modules', 'rpc-websockets', 'package.json');

function ensureLegacyExport() {
	if (!fs.existsSync(packagePath)) {
		console.warn('[patch-rpc-websockets] package.json not found, skipping');
		return;
	}

	const raw = fs.readFileSync(packagePath, 'utf8');
	const pkg = JSON.parse(raw);
	const exportsField = pkg.exports ?? {};
	let changed = false;

	// Normalize conditional exports into "." entry when mixing with subpaths.
	const conditionKeys = ['browser', 'node', 'default'];
	const extractedConditions = {};
	for (const key of conditionKeys) {
		if (Object.prototype.hasOwnProperty.call(exportsField, key)) {
			extractedConditions[key] = exportsField[key];
			delete exportsField[key];
		}
		changed = true;
	}
	if (Object.keys(extractedConditions).length > 0) {
		const mainExport = exportsField['.'] ?? {};
		for (const [key, value] of Object.entries(extractedConditions)) {
			if (
				!mainExport[key] ||
				mainExport[key].import !== value.import ||
				mainExport[key].require !== value.require
			) {
				mainExport[key] = value;
			}
		}
		exportsField['.'] = mainExport;
	}

	const targets = {
		'./dist/lib/client': {
			import: './dist/lib/client.mjs',
			require: './dist/lib/client.cjs',
		},
		'./dist/lib/client.js': {
			import: './dist/lib/client.mjs',
			require: './dist/lib/client.cjs',
		},
		'./dist/lib/client/websocket': {
			import: './dist/lib/client/websocket.mjs',
			require: './dist/lib/client/websocket.cjs',
		},
		'./dist/lib/client/websocket.js': {
			import: './dist/lib/client/websocket.mjs',
			require: './dist/lib/client/websocket.cjs',
		},
	};

	for (const [key, value] of Object.entries(targets)) {
		const existing = exportsField[key];
		if (
			!existing ||
			existing.import !== value.import ||
			existing.require !== value.require
		) {
			exportsField[key] = value;
			changed = true;
		}
	}

	if (changed) {
		pkg.exports = exportsField;
		fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
		console.info('[patch-rpc-websockets] added legacy exports for ./dist/lib/client');
	} else {
		console.info('[patch-rpc-websockets] exports already patched');
	}

	const distDir = path.resolve(packagePath, '..', 'dist');
	const libDir = path.resolve(distDir, 'lib', 'client');
	fs.mkdirSync(libDir, { recursive: true });

	const files = [
		{
			path: path.resolve(distDir, 'lib', 'client.cjs'),
			content: `'use strict';\nconst mod = require('../index.cjs');\nconst Client = mod.Client || mod.default;\nif (!Client) {\n  throw new Error('rpc-websockets fallback missing Client export');\n}\nmodule.exports = Client;\nmodule.exports.default = Client;\nmodule.exports.Client = Client;\nmodule.exports.CommonClient = mod.CommonClient;\nmodule.exports.WebSocket = mod.WebSocket;\n`,
		},
		{
			path: path.resolve(distDir, 'lib', 'client.mjs'),
			content: `import * as mod from '../index.mjs';\nconst ClientClass = mod.Client ?? mod.default;\nif (!ClientClass) {\n  throw new Error('rpc-websockets fallback missing Client export');\n}\nexport default ClientClass;\nexport const Client = ClientClass;\nexport const CommonClient = mod.CommonClient;\nexport const WebSocket = mod.WebSocket;\n`,
		},
		{
			path: path.resolve(distDir, 'lib', 'client', 'websocket.cjs'),
			content: `'use strict';\nconst mod = require('../../index.cjs');\nconst WebSocket = mod.WebSocket || (mod.Client && mod.Client.WebSocket) || mod.default;\nif (!WebSocket) {\n  throw new Error('rpc-websockets fallback missing WebSocket export');\n}\nmodule.exports = WebSocket;\nmodule.exports.default = WebSocket;\nmodule.exports.WebSocket = WebSocket;\n`,
		},
		{
			path: path.resolve(distDir, 'lib', 'client', 'websocket.mjs'),
			content: `import * as mod from '../../index.mjs';\nconst WebSocketClass = mod.WebSocket ?? (mod.Client && mod.Client.WebSocket) ?? mod.default;\nif (!WebSocketClass) {\n  throw new Error('rpc-websockets fallback missing WebSocket export');\n}\nexport default WebSocketClass;\nexport const WebSocket = WebSocketClass;\n`,
		},
	];

	for (const file of files) {
		fs.writeFileSync(file.path, file.content);
	}
}

ensureLegacyExport();
