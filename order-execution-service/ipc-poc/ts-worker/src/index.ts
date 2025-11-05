import { initDrift } from './drift';
import { startIpc } from './ipc';

async function main() {
	await initDrift();
	startIpc();
}

main().catch((err) => {
	console.error(JSON.stringify({ level: 'fatal', message: err.message }));
	process.exit(1);
});
