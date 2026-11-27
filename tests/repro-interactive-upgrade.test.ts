import test from "node:test";
import assert from "node:assert/strict";

test("REPRO-01: Proves that naive !cleanText.includes('echo') fails when TCP splits echo chunk", () => {
  const chunk1 = 'sudo -S npm i -g 9router@latest --prefer-online && echo "';
  const chunk2 = '###NPM_UPGRADE_DONE###" || echo "###NPM_UPGRADE_FAILED###"\r\n';

  const isCommandEchoOld = chunk2.includes("echo");
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
  const echoedCommandLine =
    'minhmice@server:~$ sudo -S npm i -g 9router@latest --prefer-online && echo "###NPM_UPGRADE_DONE###"\r\n';

  const actualExecutionOutput = "\r\n###NPM_UPGRADE_DONE###\r\n";

  const isActualOutput = (buffer: string) => {
    return (
      /(?:^|\r?\n)###NPM_UPGRADE_DONE###(?:\r?\n|$)/.test(buffer) &&
      !/(?:echo|printf)\s+["']?###NPM_UPGRADE_DONE###/.test(buffer)
    );
  };

  assert.equal(
    /(?:^|\r?\n)###NPM_UPGRADE_DONE###(?:\r?\n|$)/.test(echoedCommandLine),
    false,
    "Echoed command must not match standalone line regex",
  );

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
    if (!sudoSent && /(?:\[sudo.*\]\s*)?Password:\s*$/i.test(slidingBuffer.trim())) {
      sudoSent = true;
      sentCount++;
    } else if (chunk.includes("try again") || chunk.includes("Authentication failed")) {
      sudoSent = false;
    }
  };

  let buffer = "";
  const part1 = "[sudo: authenticate] Pass";
  buffer += part1;
  handleChunk(part1, buffer);

  const part2 = "word: ";
  buffer += part2;
  handleChunk(part2, buffer);

  assert.equal(sentCount, 1, "Password prompt must be triggered exactly once across split chunks");

  const npmTick = "\r(reify: timing) idealTree: buildDeps\r";
  buffer = (buffer + npmTick).slice(-2000);
  handleChunk(npmTick, buffer);

  assert.equal(sentCount, 1, "Npm progress ticks must not re-trigger password prompt");
});
