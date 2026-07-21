// Local one-shot runner: `npm run ingest` (loads .env.local if present).
import 'dotenv/config';
import { runIngest } from '../lib/pipeline.js';
runIngest().then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(0); });
