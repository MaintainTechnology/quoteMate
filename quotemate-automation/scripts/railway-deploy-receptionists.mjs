#!/usr/bin/env node
// This legacy entrypoint targeted original working copies and detached before
// release verification. Fail before credentials, provider calls or subprocesses.
console.error(`Legacy receptionist deployment is disabled: it bypassed the validated release contract.
Use the reviewed candidate procedure from the platform directory:
1. Export a fresh isolated candidate with scripts/export-receptionist.mjs --out-root=<candidate-root> <trade>.
2. Resolve its dependency lock, run scripts/seal-receptionist-release.mjs <candidate-directory>, then npm run build in that directory.
3. Run scripts/verify-receptionist-release.mjs <candidate-directory> and scripts/smoke-built-receptionist.mjs <candidate-directory>.
4. Complete the required website/schema and controlled authenticated capability checks, then explicitly approve promotion of that exact attested artifact.
Front desk uses scripts/stage-frontdesk-release.mjs before the same build/verification gates.
This command performs no deployment or environment-variable changes, including with --vars-only.`)
process.exitCode = 1
