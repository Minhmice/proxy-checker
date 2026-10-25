import test from "node:test";
import assert from "node:assert/strict";

test("REPRO-01: Proves that naive !cleanText.includes('echo') fails when TCP splits echo chunk", () => {
  // Simulate TCP chunk splitting of the command echo:
  const chunk1 = 'sudo -S npm i -g 9router@latest --prefer-online && echo "';
  const chunk2 = '###NPM_UPGRADE_DONE###" || echo "###NPM_UPGRADE_FAILED###"\r\n';

  // Vulnerable logic in current server-interactive-updater.ts:175-180:
  const isCommandEchoOld = chunk2.includes("echo"); // chunk2 has 'echo' later, but what if split right after echo:
  const splitChunkA = 'echo "';
  const splitChunkB = '###NPM_UPGRADE_DONE###"\r\n';

  const vulnerableMatch =
    splitChunkB.includes("###NPM_UPGRADE_DONE###") && !splitChunkB.includes("echo");
  assert.equal(
    vulnerableMatch,
    true,
    "PROBE CONFIRMED: Naive chunk check triggers falsely on split echo",
  );
});

test("REPRO-02: Structural line-anchored regex distinguishes actual command output from echoed command", () => {
  // Echoed command line in terminal PTY:
  const echoedCommandLine =
    'minhmice@server:~$ sudo -S npm i -g 9router@latest --prefer-online && echo "###NPM_UPGRADE_DONE###"\r\n';

  // Actual output printed by bash when echo executes:
  const actualExecutionOutput = "\r\n###NPM_UPGRADE_DONE###\r\n";

  // Robust structural pattern: must appear as isolated line (not preceded by echo ")
  const isActualOutput = (buffer: string) => {
    return (
      /(?:^|\r?\n)###NPM_UPGRADE_DONE###(?:\r?\n|$)/.test(buffer) &&
      !/(?:echo|printf)\s+["']?###NPM_UPGRADE_DONE###/.test(buffer)
    );
  };

  // On echoed command: must NOT match
  assert.equal(
    /(?:^|\r?\n)###NPM_UPGRADE_DONE###(?:\r?\n|$)/.test(echoedCommandLine),
    false,
    "Echoed command must not match standalone line regex",
  );

  // On actual output: MUST match
  assert.equal(
    /(?:^|\r?\n)###NPM_UPGRADE_DONE###(?:\r?\n|$)/.test(actualExecutionOutput),
    true,
    "Actual bash output matches standalone line regex",
  );
});

test("REPRO-03: Sudo password prompt parsing across chunk boundaries", () => {
  let sudoSent = false;
  let sentCount = 0;

  const handleChunk = (chunk: string, slidingBuffer: string) => {
    // If prompt is detected in current sliding buffer and not yet sent
    if (!sudoSent && /(?:\[sudo.*\]\s*)?Password:\s*$/i.test(slidingBuffer.trim())) {
      sudoSent = true;
      sentCount++;
    } else if (chunk.includes("try again") || chunk.includes("Authentication failed")) {
      sudoSent = false;
    }
  };

  // Simulate prompt arriving in 2 chunks:
  let buffer = "";
  const part1 = "[sudo: authenticate] Pass";
  buffer += part1;
  handleChunk(part1, buffer);

  const part2 = "word: ";
  buffer += part2;
  handleChunk(part2, buffer);

  assert.equal(sentCount, 1, "Password prompt must be triggered exactly once across split chunks");

  // Subsequent npm output ticks should NOT re-trigger password prompt:
  const npmTick = "\r(reify: timing) idealTree: buildDeps\r";
  buffer = (buffer + npmTick).slice(-2000);
  handleChunk(npmTick, buffer);

  assert.equal(sentCount, 1, "Npm progress ticks must not re-trigger password prompt");
});
