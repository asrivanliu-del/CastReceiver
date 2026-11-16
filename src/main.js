import { SoundTouch } from 'soundtouchjs';
import {
  getKaraokeCharacterState,
  getKaraokeLinePair,
  getAudioSourceRoute,
  getPlaybackClockElement,
  getStemAudioMuteState,
  hasParallelStemSources,
  getStartupBufferSeconds,
  sortKaraokeLines,
  getSubtitleTime,
  isParallelStemVideo,
  setMediaElementAudioMuted,
  synchronizeAudioElements,
  waitForFirstVideoFrame,
  waitForMediaBuffer,
  waitForMediaMetadata
} from './castPlayback.js';
import './style.css';

const NAMESPACE = 'urn:x-cast:com.mintplayer.cast';
const context = cast.framework.CastReceiverContext.getInstance();
const video = document.querySelector('#video');
const audio = document.querySelector('#audio');
const vocalsAudio = document.querySelector('#vocalsAudio');
const cover = document.querySelector('#cover');
const lyrics = document.querySelector('#lyrics');
const message = document.querySelector('#message');
const stage = document.querySelector('#stage');

const elements = new Map();
let media = null;
let activeElement = null;
let activeSource = 'original';
let mediaLoadController = null;
let playbackIntentId = 0;
let audioContext = null;
let statusTimer = 0;
let audioSourceChangeId = 0;
let lyricsAnimationFrame = 0;
let renderedKaraokeLine = null;
let renderedKaraokeNextLine = null;
let renderedKaraokeLineIsTop = null;
let activeKaraokeRow = null;
let renderedTimedLine = null;
let activeCharacterIndex = -1;
let lastKaraokeTime = 0;
let mirrorPeerConnection = null;
let mirrorStream = null;
let mirrorNegotiationId = 0;
let mirrorReadySent = false;

function sendStatus(senderId, state, error) {
  const clock = getPlaybackClockElement(media?.isVideo, video, activeElement);
  const data = {
    type: 'STATUS',
    state,
    currentTime: clock?.currentTime || 0,
    duration: Number.isFinite(clock?.duration) ? clock.duration : 0,
    ...(error ? { error } : {})
  };
  try {
    context.sendCustomMessage(NAMESPACE, senderId, data);
  } catch (sendError) {
    console.error('Unable to send Cast status', sendError);
  }
}

function setMessage(text) {
  message.textContent = text;
  message.hidden = !text;
}

function setVideoAudioMuted(muted) {
  setMediaElementAudioMuted(video, muted, elements.get(video)?.gain, audioContext?.currentTime || 0);
}

function setElementAudioMuted(element, muted) {
  setMediaElementAudioMuted(element, muted, elements.get(element)?.gain, audioContext?.currentTime || 0);
}

function synchronizeStemAudio(position = video.currentTime) {
  if (!isParallelStemVideo(media) || !Number.isFinite(position)) return;
  synchronizeAudioElements(position, [audio, vocalsAudio]);
}

function pauseMediaElements() {
  video.pause();
  audio.pause();
  vocalsAudio.pause();
}

async function playMediaElements() {
  try {
    if (isParallelStemVideo(media)) {
      await Promise.all([video.play(), audio.play(), vocalsAudio.play()]);
      return;
    }
    if (activeElement) await activeElement.play();
    if (media?.isVideo && activeElement !== video && video.paused) await video.play();
  } catch (error) {
    pauseMediaElements();
    throw error;
  }
}

function waitForIceGatheringComplete(peerConnection) {
  if (peerConnection.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timer);
      peerConnection.removeEventListener('icegatheringstatechange', onStateChange);
    };
    const onStateChange = () => {
      if (peerConnection.iceGatheringState !== 'complete') return;
      cleanup();
      resolve();
    };
    const timer = window.setTimeout(() => {
      cleanup();
      if (/^a=candidate:/m.test(peerConnection.localDescription?.sdp || '')) resolve();
      else reject(new Error('No network candidates were gathered for the Player mirror connection.'));
    }, 5000);
    peerConnection.addEventListener('icegatheringstatechange', onStateChange);
    onStateChange();
  });
}

function stopMirrorConnection() {
  mirrorNegotiationId++;
  const peerConnection = mirrorPeerConnection;
  mirrorPeerConnection = null;
  peerConnection?.close();
  const stream = mirrorStream;
  mirrorStream = null;
  mirrorReadySent = false;
  stream?.getTracks().forEach(track => track.stop());
  if (video.srcObject) {
    video.pause();
    video.srcObject = null;
  }
  setVideoAudioMuted(false);
  stage.classList.remove('mirror-mode');
}

async function handleMirrorOffer(sdp, senderId) {
  if (typeof sdp !== 'string' || !sdp.length || sdp.length > 48 * 1024) {
    sendStatus(senderId, 'error', 'Invalid Player mirror offer.');
    return;
  }

  stopMirrorConnection();
  const negotiationId = mirrorNegotiationId;
  let peerConnection;
  try {
    peerConnection = new RTCPeerConnection();
  } catch (error) {
    sendStatus(senderId, 'error', `Unable to create a Player mirror connection: ${error.message || String(error)}`);
    return;
  }
  mirrorPeerConnection = peerConnection;
  mirrorReadySent = false;
  stage.classList.add('mirror-mode');
  setMessage('');
  cover.hidden = true;
  lyrics.hidden = true;
  setVideoAudioMuted(false);
  video.autoplay = true;
  video.playsInline = true;

  peerConnection.ontrack = event => {
    if (negotiationId !== mirrorNegotiationId || mirrorPeerConnection !== peerConnection) return;
    let stream = event.streams[0] || mirrorStream;
    if (!stream) {
      stream = new MediaStream();
    }
    if (mirrorStream !== stream) {
      mirrorStream = stream;
      video.srcObject = stream;
    } else if (!stream.getTracks().includes(event.track)) {
      stream.addTrack(event.track);
    }
    void video.play().then(async () => {
      if (!stream.getVideoTracks().length || mirrorReadySent) return;
      await waitForFirstVideoFrame(video);
      if (negotiationId !== mirrorNegotiationId || mirrorPeerConnection !== peerConnection || mirrorReadySent) return;
      mirrorReadySent = true;
      sendStatus(senderId, 'mirror-ready');
    }).catch(error => {
      if (negotiationId !== mirrorNegotiationId) return;
      const message = `Unable to play the Player mirror stream: ${error.message || String(error)}`;
      console.error(message, error);
      sendStatus(senderId, 'error', message);
    });
  };
  peerConnection.onconnectionstatechange = () => {
    if (negotiationId !== mirrorNegotiationId || mirrorPeerConnection !== peerConnection) return;
    if (peerConnection.connectionState === 'failed') {
      sendStatus(senderId, 'error', 'The Player mirror connection failed.');
    }
  };

  try {
    await peerConnection.setRemoteDescription({ type: 'offer', sdp });
    if (negotiationId !== mirrorNegotiationId) return;
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    await waitForIceGatheringComplete(peerConnection);
    if (negotiationId !== mirrorNegotiationId) return;
    const answerSdp = peerConnection.localDescription?.sdp;
    if (!answerSdp) throw new Error('Chromecast did not create a Player mirror answer.');
    context.sendCustomMessage(NAMESPACE, senderId, { type: 'MIRROR_ANSWER', sdp: answerSdp });
  } catch (error) {
    if (negotiationId !== mirrorNegotiationId) return;
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Unable to negotiate Player mirroring', error);
    sendStatus(senderId, 'error', errorMessage);
    stopMirrorConnection();
  }
}

function ensureAudioGraph(element) {
  audioContext ||= new AudioContext();
  if (!elements.has(element)) {
    const source = audioContext.createMediaElementSource(element);
    const gain = audioContext.createGain();
    const panner = audioContext.createStereoPanner();
    source.connect(gain);
    gain.connect(panner);
    panner.connect(audioContext.destination);
    elements.set(element, { source, gain, panner, pitchNode: null, soundTouch: null, previousTranspose: 0 });
  }
  return elements.get(element);
}

function clearPitchBuffers(soundTouch) {
  soundTouch?.inputBuffer.clear();
  soundTouch?.outputBuffer.clear();
  soundTouch?._intermediateBuffer?.clear();
  soundTouch?.clear();
}

function configureEffectsForElement(element, pan, transpose) {
  const graph = ensureAudioGraph(element);
  graph.panner.pan.value = pan;
  if (transpose !== 0 && !graph.pitchNode) {
    graph.soundTouch = new SoundTouch();
    graph.soundTouch.pitchSemitones = transpose;
    graph.soundTouch.tempo = 1;
    graph.soundTouch.rate = 1;
    graph.soundTouch._soundtouch?.stretch?.setParameters(audioContext.sampleRate, 0, 0, 8);
    const processor = audioContext.createScriptProcessor(1024, 2, 2);
    const inputSamples = new Float32Array(2048);
    const outputSamples = new Float32Array(2048);
    processor.onaudioprocess = event => {
      const input = event.inputBuffer;
      const output = event.outputBuffer;
      const leftIn = input.getChannelData(0);
      const rightIn = input.numberOfChannels > 1 ? input.getChannelData(1) : leftIn;
      const leftOut = output.getChannelData(0);
      const rightOut = output.numberOfChannels > 1 ? output.getChannelData(1) : leftOut;
      const semitones = media?.transpose || 0;
      if (semitones === 0) {
        if (graph.previousTranspose !== 0) clearPitchBuffers(graph.soundTouch);
        graph.previousTranspose = 0;
        leftOut.set(leftIn);
        if (rightOut !== leftOut) rightOut.set(rightIn);
        return;
      }
      graph.previousTranspose = semitones;
      graph.soundTouch.pitchSemitones = semitones;
      inputSamples.fill(0);
      for (let frame = 0; frame < leftIn.length; frame++) {
        inputSamples[frame * 2] = leftIn[frame];
        inputSamples[frame * 2 + 1] = rightIn[frame];
      }
      graph.soundTouch.inputBuffer.putSamples(inputSamples, 0, leftIn.length);
      graph.soundTouch.process();
      outputSamples.fill(0);
      const framesAvailable = Math.min(leftIn.length, graph.soundTouch.outputBuffer.frameCount);
      if (framesAvailable > 0) graph.soundTouch.outputBuffer.receiveSamples(outputSamples, framesAvailable);
      for (let frame = 0; frame < leftOut.length; frame++) {
        leftOut[frame] = frame < framesAvailable ? outputSamples[frame * 2] : 0;
        if (rightOut !== leftOut) rightOut[frame] = frame < framesAvailable ? outputSamples[frame * 2 + 1] : 0;
      }
    };
    graph.source.disconnect();
    graph.source.connect(processor);
    processor.connect(graph.gain);
    graph.pitchNode = processor;
    graph.soundTouch.pitchSemitones = transpose;
  } else if (transpose === 0 && graph.pitchNode) {
    graph.pitchNode.disconnect();
    graph.source.disconnect();
    graph.source.connect(graph.gain);
    graph.pitchNode = null;
    graph.soundTouch = null;
    graph.previousTranspose = 0;
  } else if (graph.soundTouch) {
    graph.soundTouch.pitchSemitones = transpose;
  }
}

function configureEffects(pan, transpose) {
  if (!media) return;
  const targets = isParallelStemVideo(media) ? [audio, vocalsAudio] : activeElement ? [activeElement] : [];
  for (const element of targets) configureEffectsForElement(element, pan, transpose);
  media.pan = pan;
  media.transpose = transpose;
}

function isSessionAssetUrl(value, baseUrl) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    const base = new URL(baseUrl);
    const octets = url.hostname.split('.').map(Number);
    const privateAddress = octets.length === 4 && (
      octets[0] === 10 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168)
    );
    return url.protocol === 'http:' &&
      privateAddress &&
      url.origin === base.origin &&
      url.pathname.startsWith(base.pathname.slice(0, base.pathname.lastIndexOf('/') + 1)) &&
      /^\/cast\/[a-f0-9]{64}\/[a-zA-Z0-9_-]{1,80}$/.test(url.pathname);
  } catch {
    return false;
  }
}

function isValidMediaPayload(value) {
  if (!value || typeof value !== 'object' ||
      !isSessionAssetUrl(value.url, value.url) ||
      typeof value.mimeType !== 'string' ||
      typeof value.title !== 'string' ||
      value.title.length > 500 ||
      typeof value.isVideo !== 'boolean' ||
      typeof value.autoplay !== 'boolean' ||
      !Number.isFinite(value.currentTime) ||
      value.currentTime < 0 ||
      !Number.isFinite(value.pan) ||
      value.pan < -1 ||
      value.pan > 1 ||
      !Number.isInteger(value.transpose) ||
      value.transpose < -12 ||
      value.transpose > 12) return false;
  if (value.audioSource !== undefined &&
      !['original', 'accompaniment', 'vocals'].includes(value.audioSource)) return false;
  return ['accompanimentUrl', 'vocalsUrl', 'coverUrl', 'lyricsUrl', 'karaokeUrl'].every(key =>
    value[key] === undefined || isSessionAssetUrl(value[key], value.url)) &&
    hasParallelStemSources(value);
}

async function loadJsonAsset(url, label) {
  if (!url) return [];
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Unable to load ${label} (${response.status}).`);
  const value = await response.json();
  if (!Array.isArray(value)) throw new Error(`Invalid ${label} data.`);
  return value;
}

function renderLyrics() {
  if (!media) return;
  const currentTime = getSubtitleTime(media.isVideo, video.currentTime, activeElement?.currentTime);
  const karaokePair = getKaraokeLinePair(media.karaokeLines, currentTime);
  if (karaokePair) {
    const { currentLine, nextLine, currentLineIsTop } = karaokePair;
    const characters = currentLine.characters;
    const lineChanged = renderedKaraokeLine !== currentLine;
    const pairChanged = lineChanged ||
      renderedKaraokeNextLine !== nextLine ||
      renderedKaraokeLineIsTop !== currentLineIsTop;
    if (pairChanged) {
      lyrics.replaceChildren();
      const createRow = (line, isCurrent, alignment) => {
        const row = document.createElement('div');
        row.className = `karaoke-subtitle-line karaoke-subtitle-${alignment} ${isCurrent ? 'karaoke-current-line' : 'karaoke-next-line'}`;
        if (isCurrent) {
          for (const character of line.characters) {
            const span = document.createElement('span');
            span.className = 'karaoke-character';
            span.textContent = character.text;
            row.append(span);
          }
        } else {
          row.textContent = line.text;
        }
        return row;
      };
      const topLine = currentLineIsTop ? currentLine : nextLine;
      const bottomLine = currentLineIsTop ? nextLine : currentLine;
      activeKaraokeRow = null;
      if (topLine) {
        const topRow = createRow(topLine, currentLineIsTop, 'top-line');
        lyrics.append(topRow);
        if (currentLineIsTop) activeKaraokeRow = topRow;
      }
      if (bottomLine) {
        const bottomRow = createRow(bottomLine, !currentLineIsTop, 'bottom-line');
        lyrics.append(bottomRow);
        if (!currentLineIsTop) activeKaraokeRow = bottomRow;
      }
      renderedKaraokeLine = currentLine;
      renderedKaraokeNextLine = nextLine;
      renderedKaraokeLineIsTop = currentLineIsTop;
      renderedTimedLine = null;
      activeCharacterIndex = -1;
    }
    const rewound = currentTime < lastKaraokeTime;
    if (rewound) activeCharacterIndex = -1;
    const nextCharacterIndex = characters.findIndex(character => currentTime < character.end);
    const firstChangedIndex = lineChanged || rewound || activeCharacterIndex < 0
      ? 0
      : Math.min(activeCharacterIndex, nextCharacterIndex < 0 ? characters.length - 1 : nextCharacterIndex);
    const lastChangedIndex = lineChanged || rewound || activeCharacterIndex < 0
      ? characters.length - 1
      : Math.max(activeCharacterIndex, nextCharacterIndex);
    for (let index = firstChangedIndex; index <= lastChangedIndex; index++) {
      const character = characters[index];
      const span = activeKaraokeRow.children[index];
      span.classList.remove('active', 'complete');
      span.style.removeProperty('--fill');
      const state = getKaraokeCharacterState(currentTime, character);
      if (state.complete) span.classList.add('complete');
      else if (state.active) {
        span.style.setProperty('--fill', `${state.fillPercent}%`);
        span.classList.add('active');
      }
    }
    activeCharacterIndex = nextCharacterIndex < 0 ? characters.length - 1 : nextCharacterIndex;
    lastKaraokeTime = currentTime;
    lyrics.hidden = false;
    return;
  }
  const timedLine = Array.isArray(media.lyrics)
    ? [...media.lyrics].reverse().find(line => line.time <= currentTime)
    : null;
  if (renderedKaraokeLine) lyrics.replaceChildren();
  renderedKaraokeLine = null;
  renderedKaraokeNextLine = null;
  renderedKaraokeLineIsTop = null;
  activeKaraokeRow = null;
  activeCharacterIndex = -1;
  lastKaraokeTime = currentTime;
  if (renderedTimedLine !== timedLine) lyrics.textContent = timedLine?.text || '';
  renderedTimedLine = timedLine;
  lyrics.hidden = !timedLine;
}

async function selectAudioSource(source, position, changeId) {
  if (!media) return false;
  const mediaForChange = media;
  const currentTime = Number.isFinite(position) ? Math.max(0, position) : 0;
  if (isParallelStemVideo(mediaForChange)) {
    if (!['original', 'accompaniment', 'vocals'].includes(source)) {
      throw new Error(`The ${source} track is unavailable.`);
    }
    const muteState = getStemAudioMuteState(source);
    setVideoAudioMuted(true);
    setElementAudioMuted(audio, muteState.accompanimentMuted);
    setElementAudioMuted(vocalsAudio, muteState.vocalsMuted);
    activeElement = video;
    activeSource = source;
    synchronizeStemAudio(currentTime);
    configureEffects(mediaForChange.pan || 0, mediaForChange.transpose || 0);
    return true;
  }
  const route = getAudioSourceRoute(mediaForChange, source, activeSource);
  if (!route.url) throw new Error(`The ${source} track is unavailable.`);
  if (route.useVideoElement) {
    audio.pause();
    activeElement = video;
    activeSource = source;
    setVideoAudioMuted(false);
    ensureAudioGraph(video);
    configureEffects(mediaForChange.pan || 0, mediaForChange.transpose || 0);
    return true;
  }
  if (mediaForChange.isVideo) {
    ensureAudioGraph(video);
    setVideoAudioMuted(route.muteVideo);
  }
  audio.crossOrigin = 'anonymous';
  const resolvedSourceUrl = new URL(route.url, document.baseURI).href;
  if (audio.src !== resolvedSourceUrl) {
    audio.src = resolvedSourceUrl;
    audio.load();
  }
  await waitForMediaMetadata(audio);
  if (changeId !== audioSourceChangeId || media !== mediaForChange) return false;
  const sourceTime = getSubtitleTime(mediaForChange.isVideo, video.currentTime, currentTime);
  audio.currentTime = sourceTime;
  activeElement = audio;
  activeSource = source;
  ensureAudioGraph(activeElement);
  configureEffects(mediaForChange.pan || 0, mediaForChange.transpose || 0);
  return true;
}

function updateLyricsFrame() {
  lyricsAnimationFrame = 0;
  renderLyrics();
  const clock = getPlaybackClockElement(media?.isVideo, video, activeElement);
  if (clock && !clock.paused && media?.karaokeLines?.length) {
    lyricsAnimationFrame = window.requestAnimationFrame(updateLyricsFrame);
  }
}

function startLyricsAnimation() {
  if (!lyricsAnimationFrame) {
    lyricsAnimationFrame = window.requestAnimationFrame(updateLyricsFrame);
  }
}

function stopLyricsAnimation() {
  if (lyricsAnimationFrame) window.cancelAnimationFrame(lyricsAnimationFrame);
  lyricsAnimationFrame = 0;
  renderLyrics();
}

async function changeAudioSource(source, senderId) {
  const changeId = ++audioSourceChangeId;
  const mediaForChange = media;
  const clock = getPlaybackClockElement(mediaForChange?.isVideo, video, activeElement);
  const position = getSubtitleTime(mediaForChange?.isVideo, video.currentTime, activeElement?.currentTime);
  const wasPlaying = !!clock && !clock.paused;
  const intentId = playbackIntentId;
  const changed = await selectAudioSource(source, position, changeId);
  if (!changed || changeId !== audioSourceChangeId) return;
  if (audioContext?.state === 'suspended') await audioContext.resume();
  if (wasPlaying && intentId === playbackIntentId && activeElement) {
    await activeElement.play();
    if (mediaForChange?.isVideo && video.paused) await video.play();
  }
  const playbackClock = getPlaybackClockElement(media?.isVideo, video, activeElement);
  if (playbackClock) {
    sendStatus(senderId, playbackClock.paused ? 'paused' : 'playing');
  }
}

async function loadMedia(nextMedia, senderId) {
  stopMirrorConnection();
  if (!isValidMediaPayload(nextMedia)) {
    throw new Error('Invalid media description.');
  }
  playbackIntentId++;
  mediaLoadController?.abort();
  const loadController = new AbortController();
  mediaLoadController = loadController;
  const loadId = ++audioSourceChangeId;
  sendStatus(senderId, 'buffering');
  const [timedLyrics, karaokeLines] = await Promise.all([
    loadJsonAsset(nextMedia.lyricsUrl, 'lyrics'),
    loadJsonAsset(nextMedia.karaokeUrl, 'karaoke lyrics')
  ]);
  if (loadId !== audioSourceChangeId) return;
  media = { ...nextMedia, lyrics: timedLyrics, karaokeLines: sortKaraokeLines(karaokeLines) };
  renderedKaraokeLine = null;
  renderedKaraokeNextLine = null;
  renderedKaraokeLineIsTop = null;
  activeKaraokeRow = null;
  renderedTimedLine = null;
  activeCharacterIndex = -1;
  lastKaraokeTime = 0;
  activeSource = nextMedia.audioSource || 'original';
  activeElement = null;
  pauseMediaElements();
  video.removeAttribute('src');
  audio.removeAttribute('src');
  vocalsAudio.removeAttribute('src');
  video.load();
  audio.load();
  vocalsAudio.load();
  setVideoAudioMuted(nextMedia.isVideo);
  setMessage('');
  cover.src = nextMedia.coverUrl || '';
  cover.hidden = !nextMedia.coverUrl;
  lyrics.hidden = true;

  if (nextMedia.isVideo) {
    video.crossOrigin = 'anonymous';
    video.preload = 'auto';
    video.src = nextMedia.url;
    const metadataTargets = [video];
    if (isParallelStemVideo(nextMedia)) {
      audio.crossOrigin = 'anonymous';
      audio.preload = 'auto';
      audio.src = nextMedia.accompanimentUrl;
      vocalsAudio.crossOrigin = 'anonymous';
      vocalsAudio.preload = 'auto';
      vocalsAudio.src = nextMedia.vocalsUrl;
      metadataTargets.push(audio, vocalsAudio);
    }
    await Promise.all(metadataTargets.map(element => waitForMediaMetadata(element)));
    if (loadId !== audioSourceChangeId) return;
    video.currentTime = nextMedia.currentTime || 0;
    if (isParallelStemVideo(nextMedia)) {
      audio.currentTime = nextMedia.currentTime || 0;
      vocalsAudio.currentTime = nextMedia.currentTime || 0;
    }
    activeElement = video;
  } else {
    audio.crossOrigin = 'anonymous';
    audio.preload = 'auto';
    audio.src = nextMedia.url;
    await waitForMediaMetadata(audio);
    if (loadId !== audioSourceChangeId) return;
    audio.currentTime = nextMedia.currentTime || 0;
    activeElement = audio;
  }
  ensureAudioGraph(activeElement);
  configureEffects(nextMedia.pan || 0, nextMedia.transpose || 0);
  if (isParallelStemVideo(nextMedia)) {
    ensureAudioGraph(audio);
    ensureAudioGraph(vocalsAudio);
    await selectAudioSource(activeSource, nextMedia.currentTime, loadId);
    if (loadId !== audioSourceChangeId) return;
  } else if (nextMedia.isVideo || activeSource !== 'original') {
    await selectAudioSource(activeSource, nextMedia.currentTime, loadId);
    if (loadId !== audioSourceChangeId) return;
  }
  const bufferTargets = new Set([activeElement]);
  if (isParallelStemVideo(nextMedia)) {
    bufferTargets.add(audio);
    bufferTargets.add(vocalsAudio);
  } else if (nextMedia.isVideo && activeElement !== video) {
    bufferTargets.add(video);
  }
  try {
    await Promise.all([...bufferTargets].map(element =>
      waitForMediaBuffer(
        element,
        nextMedia.currentTime || 0,
        getStartupBufferSeconds(element === video),
        20000,
        loadController.signal
      )));
  } catch (error) {
    if (loadId !== audioSourceChangeId) return;
    throw error;
  }
  if (loadId !== audioSourceChangeId) return;
  if (nextMedia.autoplay) {
    await audioContext.resume();
    try {
      await playMediaElements();
    } catch (error) {
      pauseMediaElements();
      throw error;
    }
  }
  sendStatus(senderId, activeElement.paused ? 'paused' : 'playing');
}

function handleCommand(event) {
  const command = event.data;
  try {
    switch (command?.type) {
      case 'PING':
        sendStatus(event.senderId, 'ready');
        return;
      case 'LOAD':
        void loadMedia(command.media, event.senderId)
          .catch(error => {
            setMessage(`Playback error: ${error.message}`);
            sendStatus(event.senderId, 'error', error.message);
          });
        return;
      case 'MIRROR_OFFER':
        void handleMirrorOffer(command.sdp, event.senderId);
        return;
      case 'MIRROR_STOP':
        stopMirrorConnection();
        return;
      case 'PLAY':
        playbackIntentId++;
        void audioContext?.resume();
        if (isParallelStemVideo(media) || activeElement?.paused) {
          void playMediaElements().catch(error => sendStatus(event.senderId, 'error', error.message));
        } else if (media?.isVideo && activeElement !== video && video.paused) {
          void video.play().catch(error => sendStatus(event.senderId, 'error', error.message));
        }
        return;
      case 'PAUSE':
        playbackIntentId++;
        pauseMediaElements();
        sendStatus(event.senderId, 'paused');
        return;
      case 'SEEK':
        if (typeof command.currentTime === 'number' && Number.isFinite(command.currentTime) && command.currentTime >= 0) {
          for (const element of [video, audio, vocalsAudio]) {
            if (element.readyState > 0) element.currentTime = command.currentTime;
          }
          sendStatus(event.senderId, 'paused');
        }
        return;
      case 'EFFECTS':
        if (Number.isFinite(command.pan) && Number.isInteger(command.transpose)) {
          configureEffects(Math.max(-1, Math.min(1, command.pan)), Math.max(-12, Math.min(12, command.transpose)));
        }
        return;
      case 'AUDIO_SOURCE':
        if (['original', 'accompaniment', 'vocals'].includes(command.source)) {
          void changeAudioSource(command.source, event.senderId).catch(error => {
            const message = error instanceof Error ? error.message : String(error);
            console.error('Unable to switch Chromecast audio source', error);
            sendStatus(event.senderId, 'error', message);
          });
          return;
        }
        return;
      case 'STOP':
        playbackIntentId++;
        audioSourceChangeId++;
        mediaLoadController?.abort();
        mediaLoadController = null;
        stopMirrorConnection();
        pauseMediaElements();
        video.removeAttribute('src');
        audio.removeAttribute('src');
        vocalsAudio.removeAttribute('src');
        setVideoAudioMuted(false);
        setElementAudioMuted(audio, false);
        setElementAudioMuted(vocalsAudio, false);
        media = null;
        activeElement = null;
        setMessage('Waiting for MintPlayer…');
        return;
      default:
        console.warn('Ignored unsupported Cast command');
    }
  } catch (error) {
    console.error('Unable to process Cast command', error);
    sendStatus(event.senderId, 'error', error instanceof Error ? error.message : String(error));
  }
}

context.addCustomMessageListener(NAMESPACE, handleCommand);
context.start();

for (const element of [video, audio, vocalsAudio]) {
  element.addEventListener('timeupdate', () => {
    renderLyrics();
    if (element === video && isParallelStemVideo(media)) synchronizeStemAudio();
    else if (element === video && media?.isVideo && activeElement === audio &&
        !audio.paused && Math.abs(audio.currentTime - video.currentTime) > 0.18) audio.currentTime = video.currentTime;
  });
  element.addEventListener('play', () => {
    const clock = getPlaybackClockElement(media?.isVideo, video, activeElement);
    if (element === clock) {
      startLyricsAnimation();
      sendStatus(undefined, 'playing');
    }
  });
  element.addEventListener('pause', () => {
    const clock = getPlaybackClockElement(media?.isVideo, video, activeElement);
    if (element === clock) {
      stopLyricsAnimation();
      sendStatus(undefined, 'paused');
    }
  });
  element.addEventListener('seeked', () => {
    if (element === video && isParallelStemVideo(media)) synchronizeStemAudio();
    renderLyrics();
  });
  element.addEventListener('ended', () => {
    if (element === getPlaybackClockElement(media?.isVideo, video, activeElement)) {
      sendStatus(undefined, 'ended');
    }
  });
  element.addEventListener('error', () => {
    const requiredStem = isParallelStemVideo(media) && (element === audio || element === vocalsAudio);
    if (element !== activeElement && !requiredStem) return;
    const mediaError = element.error;
    const mediaType = element === video ? 'video' : 'audio';
    const error = `Unable to load ${mediaType} for "${media?.title || 'media'}" (media error ${mediaError?.code || 'unknown'}).`;
    console.error(error, mediaError);
    setMessage(`Playback error: ${error}`);
    sendStatus(undefined, 'error', error);
  });
}

statusTimer = window.setInterval(() => {
  if (activeElement && !activeElement.paused) sendStatus(undefined, 'playing');
}, 1000);

context.addEventListener(cast.framework.system.EventType.SENDER_DISCONNECTED, () => {
  if (context.getSenders().length === 0) {
    window.clearInterval(statusTimer);
    stopMirrorConnection();
    pauseMediaElements();
  }
});
