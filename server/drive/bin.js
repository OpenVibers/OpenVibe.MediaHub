'use strict';

/**
 * The bin's due purge: a file binned more than 30 days ago is deleted forever — its row soft-deleted and
 * OpenVibe.Media asked to delete the object — in batches of 200.
 *
 * The job is due-based, not a 30-day timer: every hour it asks the drive what is due, so a restart never loses or
 * delays anything past the next tick, and a bin older than 30 days goes on the first run after boot. It is mounted
 * from server/index.js next to the Pics and drops sweeps, and stopped with the process.
 */
const { BIN_DAYS } = require('./rules');

const BATCH = 200;
const EVERY_MS = 3_600_000;

function createBinPurge({ drive, log = console, everyMs = EVERY_MS }) {
    let timer = null;
    let running = null;

    /** One due pass, in batches; answers how many files were purged. Concurrent calls share the run. */
    function run() {
        if (running) return running;
        running = drive.purgeDue({ batch: BATCH })
            .then((n) => {
                if (n) log.log(`[MediaHub] bin: purged ${n} file(s) binned more than ${BIN_DAYS} days ago`);
                return n;
            })
            .catch((err) => {
                log.warn(`[MediaHub] bin purge failed: ${err && err.message}`);
                return 0;
            })
            .finally(() => { running = null; });
        return running;
    }

    return {
        BIN_DAYS, BATCH, run,
        start() {
            if (timer) return;
            run();
            timer = setInterval(run, everyMs);
            if (timer.unref) timer.unref();
        },
        stop() {
            if (timer) clearInterval(timer);
            timer = null;
        },
    };
}

module.exports = { createBinPurge, BIN_DAYS, BATCH, EVERY_MS };
