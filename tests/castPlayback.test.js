import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getKaraokeCharacterState,
  getSubtitleTime,
  waitForMediaMetadata
} from '../src/castPlayback.js';

test('uses video time as the subtitle clock while an alternate audio track is active', () => {
  assert.equal(getSubtitleTime(true, 12.5, 11.9), 12.5);
  assert.equal(getSubtitleTime(false, 12.5, 11.9), 11.9);
  assert.equal(getSubtitleTime(true, Number.NaN, 11.9), 0);
});

test('computes karaoke highlight state at character boundaries', () => {
  const character = { start: 2, end: 4 };
  assert.deepEqual(getKaraokeCharacterState(2, character), { active: false, complete: false, fillPercent: 0 });
  assert.deepEqual(getKaraokeCharacterState(3, character), { active: true, complete: false, fillPercent: 50 });
  assert.deepEqual(getKaraokeCharacterState(4, character), { active: false, complete: true, fillPercent: 0 });
});

test('waits for media metadata before allowing source seeking', async () => {
  const element = new EventTarget();
  element.readyState = 0;
  const ready = waitForMediaMetadata(element, 100);
  element.dispatchEvent(new Event('loadedmetadata'));
  await ready;
});

test('reports audio source load failures instead of silently switching', async () => {
  const element = new EventTarget();
  element.readyState = 0;
  const ready = waitForMediaMetadata(element, 100);
  element.dispatchEvent(new Event('error'));
  await assert.rejects(ready, /Unable to load the selected audio source/);
});
