/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* global info */

/**
 * Minimal adapter for running the AI perftest through xpcshell on Thunderbird
 * builds. Mozilla's mach perftest command currently accepts Firefox and
 * Android build applications only.
 *
 * @param {string} name
 */
function measureIterations(name) {
  let iterations = 0;
  let accumulatedTime = 0;
  let startedAt = 0;
  return {
    start() {
      startedAt = ChromeUtils.now();
    },
    stop() {
      accumulatedTime += Math.max(0, ChromeUtils.now() - startedAt);
      iterations++;
    },
    reportMetrics() {
      const perCallTime = iterations ? accumulatedTime / iterations : 0;
      info(
        `PERF ${name}: iterations=${iterations} accumulatedTime=${accumulatedTime.toFixed(
          3
        )}ms perCallTime=${perCallTime.toFixed(6)}ms`
      );
    },
  };
}
