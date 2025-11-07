import { initDrift } from './drift.js';
import { startIpc } from './ipc.js';

async function main() {
	await initDrift();
	startIpc();
}

main().catch((err) => {
	console.error(JSON.stringify({ level: 'fatal', message: err.message }));
	process.exit(1);
});
