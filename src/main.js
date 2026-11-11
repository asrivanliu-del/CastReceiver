import { SoundTouch } from 'soundtouchjs';
import './style.css';

const NAMESPACE = 'urn:x-cast:com.mintplayer.cast';
const context = cast.framework.CastReceiverContext.getInstance();
const video = document.querySelector('#video');
const audio = document.querySelector('#audio');
const cover = document.querySelector('#cover');
const lyrics = document.querySelector('#lyrics');
const message = document.querySelector('#message');

const elements = new Map();
let media = null;
let activeElement = null;
let activeSource = 'original';
let audioContext = null;
let gainNode = null;
let pannerNode = null;
let sourceNode = null;
let pitchNode = null;
let soundTouch = null;
let pitchInput = null;
let pitchOutput = null;
let previousTranspose = 0;
let statusTimer = 0;

function sendStatus(senderId, state, error) {
  const data = {
    type: 'STATUS',
    state,
    currentTime: activeElement?.currentTime || 0,
    duration: Number.isFinite(activeElement?.duration) ? activeElement.duration : 0,
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

function ensureAudioGraph(element) {
  audioContext ||= new AudioContext();
  if (!elements.has(element)) {
    const source = audioContext.createMediaElementSource(element);
    const gain = audioContext.createGain();
    const panner = audioContext.createStereoPanner();
    source.connect(gain);
    gain.connect(panner);
    panner.connect(audioContext.destination);
    elements.set(element, { source, gain, panner, pitchNode: null, soundTouch: null });
  }
  const graph = elements.get(element);
  sourceNode = graph.source;
  gainNode = graph.gain;
  pannerNode = graph.panner;
  pitchNode = graph.pitchNode;
  soundTouch = graph.soundTouch;
  return graph;
}

function clearPitchBuffers() {
  soundTouch?.inputBuffer.clear();
  soundTouch?.outputBuffer.clear();
  soundTouch?._intermediateBuffer?.clear();
  soundTouch?.clear();
}

function configureEffects(pan, transpose) {
  if (!activeElement) return;
  const graph = ensureAudioGraph(activeElement);
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
        if (previousTranspose !== 0) clearPitchBuffers();
        previousTranspose = 0;
        leftOut.set(leftIn);
        if (rightOut !== leftOut) rightOut.set(rightIn);
        return;
      }
      previousTranspose = semitones;
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
    pitchNode = processor;
    soundTouch = graph.soundTouch;
  } else if (transpose === 0 && graph.pitchNode) {
    graph.pitchNode.disconnect();
    graph.source.disconnect();
    graph.source.connect(graph.gain);
    graph.pitchNode = null;
    graph.soundTouch = null;
    pitchNode = null;
    soundTouch = null;
  } else if (graph.soundTouch) {
    graph.soundTouch.pitchSemitones = transpose;
  }
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
  return ['accompanimentUrl', 'vocalsUrl', 'coverUrl'].every(key =>
    value[key] === undefined || isSessionAssetUrl(value[key], value.url));
}

function renderLyrics(currentTime) {
  if (!media) return;
  const karaokeLine = Array.isArray(media.karaokeLines)
    ? media.karaokeLines.find(line => line.start <= currentTime && currentTime <= line.end)
    : null;
  if (karaokeLine) {
    lyrics.replaceChildren();
    for (const character of karaokeLine.characters) {
      const span = document.createElement('span');
      span.className = 'word';
      span.textContent = character.text;
      if (currentTime >= character.end) span.classList.add('complete');
      else if (currentTime > character.start && character.end > character.start) {
        span.style.setProperty('--fill', String(Math.min(1, (currentTime - character.start) / (character.end - character.start))));
        span.classList.add('active');
      }
      lyrics.append(span);
    }
    lyrics.hidden = false;
    return;
  }
  const timedLine = Array.isArray(media.lyrics)
    ? [...media.lyrics].reverse().find(line => line.time <= currentTime)
    : null;
  lyrics.textContent = timedLine?.text || '';
  lyrics.hidden = !timedLine;
}

function selectAudioSource(source) {
  if (!media) return;
  const position = media.isVideo ? video.currentTime : activeElement?.currentTime || 0;
  activeSource = source;
  if (media.isVideo) {
    if (source === 'original' || (!media.accompanimentUrl && source === 'accompaniment')) {
      audio.pause();
      video.muted = false;
      activeElement = video;
    } else {
      const sourceUrl = source === 'vocals' ? media.vocalsUrl : media.accompanimentUrl;
      if (!sourceUrl) throw new Error(`The ${source} track is unavailable.`);
      video.muted = true;
      audio.crossOrigin = 'anonymous';
      audio.src = sourceUrl;
      audio.currentTime = position;
      activeElement = audio;
    }
  } else if (source === 'vocals' && media.vocalsUrl) {
    audio.crossOrigin = 'anonymous';
    audio.src = media.vocalsUrl;
    audio.currentTime = position;
    activeElement = audio;
  } else if (source === 'accompaniment' && media.accompanimentUrl) {
    audio.crossOrigin = 'anonymous';
    audio.src = media.accompanimentUrl;
    audio.currentTime = position;
    activeElement = audio;
  } else {
    activeElement = audio;
  }
  ensureAudioGraph(activeElement);
  configureEffects(media.pan || 0, media.transpose || 0);
}

async function loadMedia(nextMedia) {
  if (!isValidMediaPayload(nextMedia)) {
    throw new Error('Invalid media description.');
  }
  media = nextMedia;
  activeSource = nextMedia.audioSource || 'original';
  video.pause();
  audio.pause();
  video.removeAttribute('src');
  audio.removeAttribute('src');
  video.load();
  audio.load();
  video.muted = false;
  setMessage('');
  cover.src = nextMedia.coverUrl || '';
  cover.hidden = !nextMedia.coverUrl;
  lyrics.hidden = true;

  if (nextMedia.isVideo) {
    video.crossOrigin = 'anonymous';
    video.src = nextMedia.url;
    video.currentTime = nextMedia.currentTime || 0;
    activeElement = video;
  } else {
    audio.crossOrigin = 'anonymous';
    audio.src = nextMedia.url;
    audio.currentTime = nextMedia.currentTime || 0;
    activeElement = audio;
  }
  ensureAudioGraph(activeElement);
  configureEffects(nextMedia.pan || 0, nextMedia.transpose || 0);
  if (activeSource !== 'original') selectAudioSource(activeSource);
  if (nextMedia.autoplay) {
    await audioContext.resume();
    await activeElement.play();
    if (activeElement !== video && nextMedia.isVideo) await video.play();
  }
  sendStatus(undefined, 'playing');
}

function handleCommand(event) {
  const command = event.data;
  try {
    switch (command?.type) {
      case 'PING':
        sendStatus(event.senderId, 'ready');
        return;
      case 'LOAD':
        void loadMedia(command.media).then(() => sendStatus(event.senderId, activeElement?.paused ? 'paused' : 'playing'))
          .catch(error => {
            setMessage(`Playback error: ${error.message}`);
            sendStatus(event.senderId, 'error', error.message);
          });
        return;
      case 'PLAY':
        void audioContext?.resume();
        if (activeElement?.paused) void activeElement.play().catch(error => sendStatus(event.senderId, 'error', error.message));
        if (media?.isVideo && activeElement !== video && video.paused) void video.play();
        return;
      case 'PAUSE':
        video.pause();
        audio.pause();
        sendStatus(event.senderId, 'paused');
        return;
      case 'SEEK':
        if (typeof command.currentTime === 'number' && Number.isFinite(command.currentTime) && command.currentTime >= 0) {
          video.currentTime = command.currentTime;
          audio.currentTime = command.currentTime;
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
          const currentTime = activeElement?.currentTime || 0;
          const wasPlaying = !!activeElement && !activeElement.paused;
          selectAudioSource(command.source);
          activeElement.currentTime = currentTime;
          if (wasPlaying) void activeElement.play();
          return;
        }
        return;
      case 'STOP':
        video.pause();
        audio.pause();
        video.removeAttribute('src');
        audio.removeAttribute('src');
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

for (const element of [video, audio]) {
  element.addEventListener('timeupdate', () => {
    renderLyrics(element.currentTime);
    if (element === video && media?.isVideo && activeElement === audio &&
        !audio.paused && Math.abs(audio.currentTime - video.currentTime) > 0.18) {
      audio.currentTime = video.currentTime;
    }
  });
  element.addEventListener('play', () => sendStatus(undefined, 'playing'));
  element.addEventListener('pause', () => {
    if (element === activeElement) sendStatus(undefined, 'paused');
  });
  element.addEventListener('ended', () => sendStatus(undefined, 'ended'));
}

statusTimer = window.setInterval(() => {
  if (activeElement && !activeElement.paused) sendStatus(undefined, 'playing');
}, 1000);

context.addEventListener(cast.framework.system.EventType.SENDER_DISCONNECTED, () => {
  if (context.getSenders().length === 0) {
    window.clearInterval(statusTimer);
    video.pause();
    audio.pause();
  }
});
