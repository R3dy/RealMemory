#!/usr/bin/env node
/**
 * Parse the --ui / --port / --no-browser / --doctor flags from argv. Returns
 * whether the browser UI mode was requested, the resolved port, whether the
 * side-channel auto-start is defeated, and whether the doctor diagnostic mode
 * was requested. Unknown flags are ignored (the CLI has no general-purpose arg
 * parser — hand-rolled parsing adds zero deps, per ADR-003's minimalism).
 *
 * --ui still wins over --no-browser: the combination starts the standalone
 * browser regardless (a nonsensical combo, tolerated without an error because
 * the CLI has no arg-validation surface). --doctor is mutually exclusive with
 * all other modes (it is a one-shot diagnostic that loads the store, prints,
 * and exits).
 */
declare function parseArgs(argv: string[]): {
    ui: boolean;
    port: number;
    noBrowser: boolean;
    doctor: boolean;
};

export { parseArgs };
