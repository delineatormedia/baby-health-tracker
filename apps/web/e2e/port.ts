// The one place the browser-check port is set. Not 4317, which the owner's iPhone preview
// uses on the dev Mac. Set BHT_E2E_PORT to run two worktrees' checks side by side.
const raw = process.env.BHT_E2E_PORT ?? '4391';
if (!/^\d+$/.test(raw)) throw new Error(`BHT_E2E_PORT must be a port number, got "${raw}"`);
export const E2E_PORT = Number(raw);
