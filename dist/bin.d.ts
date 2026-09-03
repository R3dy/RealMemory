#!/usr/bin/env node
import { parseResetScope } from './traits.js';
import './store--7_59FoP.js';
import './types.js';

/**
 * Parse the --ui / --port / --no-browser / --doctor / --reset-self flags from
 * argv. Returns whether the browser UI mode was requested, the resolved port,
 * whether the side-channel auto-start is defeated, whether the doctor
 * diagnostic mode was requested, and whether the --reset-self one-shot was
 * requested (and with which scope). Unknown flags are ignored (the CLI has no
 * general-purpose arg parser — hand-rolled parsing adds zero deps, per
 * ADR-003's minimalism).
 *
 * --ui still wins over --no-browser: the combination starts the standalone
 * browser regardless (a nonsensical combo, tolerated without an error because
 * the CLI has no arg-validation surface). --doctor and --reset-self are each
 * mutually exclusive with all other modes (one-shots that load the store,
 * act, and exit).
 */
declare function parseArgs(argv: string[]): {
    ui: boolean;
    port: number;
    noBrowser: boolean;
    doctor: boolean;
    resetSelf: ReturnType<typeof parseResetScope>;
};

export { parseArgs };
