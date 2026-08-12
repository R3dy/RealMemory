#!/usr/bin/env node
/**
 * Parse the --ui / --port / --no-browser flags from argv. Returns whether the
 * browser UI mode was requested, the resolved port, and whether the
 * side-channel auto-start is defeated. Unknown flags are ignored (the CLI has
 * no general-purpose arg parser — hand-rolled parsing adds zero deps, per
 * ADR-003's minimalism).
 *
 * --ui still wins over --no-browser: the combination starts the standalone
 * browser regardless (a nonsensical combo, tolerated without an error because
 * the CLI has no arg-validation surface).
 */
declare function parseArgs(argv: string[]): {
    ui: boolean;
    port: number;
    noBrowser: boolean;
};

export { parseArgs };
