import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getBufferedSecondsAhead,
  getAudioSourceRoute,
  getKaraokeCharacterState,
  getPlaybackClockElement,
  getStartupBufferSeconds,
  getSubtitleTime,
  setMediaElementAudioMuted,
  waitForFirstVideoFrame,
  waitForMediaBuffer,
  waitForMediaMetadata
} from '../src/castPlayback.js';

test('uses video time as the subtitle clock while an alternate audio track is active', () => {
  assert.equal(getSubtitleTime(true, 12.5, 11.9), 12.5);
  assert.equal(getSubtitleTime(false, 12.5, 11.9), 11.9);
  assert.equal(getSubtitleTime(true, Number.NaN, 11.9), 0);
});

test('keeps video as the playback clock while alternate audio sources switch', () => {
  const video = { currentTime: 12.5, paused: false };
  const accompaniment = { currentTime: 12.4, paused: true };
  assert.equal(getPlaybackClockElement(true, video, accompaniment), video);
  assert.equal(getPlaybackClockElement(false, video, accompaniment), accompaniment);
});

test('mutes the video element and its Web Audio route for alternate audio', () => {
  const video = { muted: false };
  const scheduledGains = [];
  const gainNode = { gain: { setValueAtTime: (value, time) => scheduledGains.push([value, time]) } };

  setMediaElementAudioMuted(video, true, gainNode, 4.5);
  assert.equal(video.muted, true);
  assert.deepEqual(scheduledGains, [[0, 4.5]]);

  setMediaElementAudioMuted(video, false, gainNode, 5);
  assert.equal(video.muted, false);
  assert.deepEqual(scheduledGains, [[0, 4.5], [1, 5]]);
});

test('updates the video gain value when precise AudioParam scheduling is unavailable', () => {
  const video = { muted: false };
  const gainNode = { gain: { value: 1 } };

  setMediaElementAudioMuted(video, true, gainNode);
  assert.equal(video.muted, true);
  assert.equal(gainNode.gain.value, 0);
});

test('routes Video original audio through the video and alternate audio through the dedicated audio element', () => {
  const media = {
    url: 'https://receiver.example/cast/video',
    isVideo: true,
    accompanimentUrl: 'https://receiver.example/cast/accompaniment',
    vocalsUrl: 'https://receiver.example/cast/vocals'
  };

  assert.deepEqual(getAudioSourceRoute(media, 'accompaniment'), {
    url: media.accompanimentUrl,
    muteVideo: true,
    useVideoElement: false
  });
  assert.deepEqual(getAudioSourceRoute(media, 'original'), {
    url: media.url,
    muteVideo: false,
    useVideoElement: true
  });
});

test('keeps audio-only Karaoke source fallback behavior', () => {
  const media = {
    url: 'https://receiver.example/cast/accompaniment',
    isVideo: false
  };

  assert.deepEqual(getAudioSourceRoute(media, 'accompaniment', 'accompaniment'), {
    url: media.url,
    muteVideo: false,
    useVideoElement: false
  });
});

test('buffers video longer than audio before playback starts', () => {
  assert.ok(getStartupBufferSeconds(true) >= 8);
  assert.ok(getStartupBufferSeconds(false) >= 5);
  assert.ok(getStartupBufferSeconds(true) > getStartupBufferSeconds(false));
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

test('waits for the requested amount of contiguous buffered media', async () => {
  const element = new EventTarget();
  element.readyState = 0;
  element.duration = 20;
  element.buffered = {
    length: 1,
    start: () => 0,
    end: () => 3
  };
  assert.equal(getBufferedSecondsAhead(element, 1), 2);
  assert.equal(getBufferedSecondsAhead(element, 4), 0);

  const ready = waitForMediaBuffer(element, 0, 3, 500);
  element.readyState = 3;
  element.dispatchEvent(new Event('progress'));
  await ready;
});

test('uses the remaining duration for short media and rejects a buffer timeout', async () => {
  const shortElement = new EventTarget();
  shortElement.readyState = 3;
  shortElement.duration = 1.5;
  shortElement.buffered = { length: 1, start: () => 0, end: () => 1.5 };
  await waitForMediaBuffer(shortElement, 0, 3);

  const emptyElement = new EventTarget();
  emptyElement.readyState = 0;
  emptyElement.duration = 20;
  emptyElement.buffered = { length: 0 };
  await assert.rejects(waitForMediaBuffer(emptyElement, 0, 3, 5), /Timed out waiting for 3.0 seconds/);
});

test('waits for the first decoded mirror video frame', async () => {
  const video = new EventTarget();
  video.readyState = 0;
  video.videoWidth = 0;
  const ready = waitForFirstVideoFrame(video, 500);
  video.readyState = 2;
  video.videoWidth = 1920;
  video.dispatchEvent(new Event('loadeddata'));
  await ready;
});
