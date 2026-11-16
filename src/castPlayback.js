export function getSubtitleTime(isVideo, videoTime, activeTime) {
  const time = isVideo ? videoTime : activeTime;
  return Number.isFinite(time) ? Math.max(0, time) : 0;
}

export function getKaraokeLinePair(lines, currentTime) {
  if (!Array.isArray(lines) || !Number.isFinite(currentTime)) return null;
  let currentIndex = -1;
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].start <= currentTime) currentIndex = index;
  }
  if (currentIndex < 0) return null;

  const currentLine = lines[currentIndex];
  const nextLine = lines[currentIndex + 1] || null;
  if (currentTime > currentLine.end && !nextLine) return null;
  return {
    currentLine,
    nextLine,
    currentLineIsTop: currentIndex % 2 === 0
  };
}

export function getPlaybackClockElement(isVideo, videoElement, activeElement) {
  return isVideo ? videoElement : activeElement;
}

export function isParallelStemVideo(media) {
  return media?.isVideo === true && media.audioSource !== undefined;
}

export function hasParallelStemSources(media) {
  return !isParallelStemVideo(media) ||
    (typeof media.accompanimentUrl === 'string' && typeof media.vocalsUrl === 'string');
}

export function getStemAudioMuteState(source) {
  return {
    accompanimentMuted: source === 'vocals',
    vocalsMuted: source === 'accompaniment'
  };
}

export function synchronizeAudioElements(masterTime, elements, threshold = 0.18) {
  if (!Number.isFinite(masterTime)) return;
  for (const element of elements) {
    if (Number.isFinite(element.currentTime) && Math.abs(element.currentTime - masterTime) > threshold) {
      element.currentTime = masterTime;
    }
  }
}

export function setMediaElementAudioMuted(element, muted, gainNode, currentTime = 0) {
  element.muted = muted;
  if (!gainNode) return;
  const gain = muted ? 0 : 1;
  if (typeof gainNode.gain.setValueAtTime === 'function') {
    gainNode.gain.setValueAtTime(gain, currentTime);
  } else {
    gainNode.gain.value = gain;
  }
}

export function getAudioSourceRoute(media, source, activeSource = media.audioSource) {
  const url = source === 'original'
    ? media.url
    : source === 'vocals'
      ? media.vocalsUrl || (!media.isVideo && activeSource === source ? media.url : undefined)
      : media.accompanimentUrl || (!media.isVideo && activeSource === source ? media.url : undefined);
  return {
    url,
    muteVideo: media.isVideo,
    useVideoElement: false
  };
}

export function getStartupBufferSeconds(isVideo) {
  return isVideo ? 8 : 5;
}

export function getKaraokeCharacterState(currentTime, character) {
  const complete = currentTime >= character.end;
  const active = !complete && currentTime > character.start && character.end > character.start;
  const fillPercent = active
    ? Math.min(100, ((currentTime - character.start) / (character.end - character.start)) * 100)
    : 0;
  return { active, complete, fillPercent };
}

export function waitForMediaMetadata(element, timeoutMs = 15000) {
  if (element.readyState >= 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      element.removeEventListener('loadedmetadata', onLoaded);
      element.removeEventListener('error', onError);
    };
    const onLoaded = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('Unable to load the selected audio source.'));
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for the selected audio source.'));
    }, timeoutMs);
    element.addEventListener('loadedmetadata', onLoaded, { once: true });
    element.addEventListener('error', onError, { once: true });
  });
}

export function getBufferedSecondsAhead(element, currentTime) {
  if (!Number.isFinite(currentTime) || !element.buffered) return 0;
  for (let index = 0; index < element.buffered.length; index++) {
    const start = element.buffered.start(index);
    const end = element.buffered.end(index);
    if (start <= currentTime + 0.05 && end >= currentTime) return Math.max(0, end - currentTime);
  }
  return 0;
}

export function waitForMediaBuffer(element, currentTime, targetSeconds = 3, timeoutMs = 20000, signal) {
  const remaining = Number.isFinite(element.duration) && element.duration > currentTime
    ? element.duration - currentTime
    : targetSeconds;
  const requiredSeconds = Math.min(targetSeconds, remaining);
  if (requiredSeconds <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let timer;
    let pollTimer;
    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(pollTimer);
      ['progress', 'loadedmetadata', 'canplay', 'seeked'].forEach(event =>
        element.removeEventListener(event, check));
      element.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (error) => {
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      if (element.readyState >= 3 &&
          getBufferedSecondsAhead(element, currentTime) >= requiredSeconds) finish();
    };
    const onError = () => finish(new Error('Unable to buffer the selected media.'));
    const onAbort = () => finish(new Error('Media buffering was cancelled.'));

    if (signal?.aborted) {
      onAbort();
      return;
    }
    if (element.error) {
      onError();
      return;
    }
    if (element.readyState >= 3 &&
        getBufferedSecondsAhead(element, currentTime) >= requiredSeconds) {
      resolve();
      return;
    }

    ['progress', 'loadedmetadata', 'canplay', 'seeked'].forEach(event =>
      element.addEventListener(event, check));
    element.addEventListener('error', onError, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(
      () => finish(new Error(`Timed out waiting for ${requiredSeconds.toFixed(1)} seconds of media buffer.`)),
      timeoutMs
    );
    pollTimer = setInterval(check, 200);
  });
}

export function waitForFirstVideoFrame(video, timeoutMs = 10000) {
  if (video.readyState >= 2 && video.videoWidth > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer;
    let callbackId;
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener('loadeddata', onLoadedData);
      video.removeEventListener('error', onError);
      if (callbackId !== undefined && typeof video.cancelVideoFrameCallback === 'function') {
        video.cancelVideoFrameCallback(callbackId);
      }
    };
    const onLoadedData = () => {
      if (video.readyState < 2 || !video.videoWidth) return;
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('Unable to decode the first mirrored video frame.'));
    };

    video.addEventListener('loadeddata', onLoadedData);
    video.addEventListener('error', onError, { once: true });
    timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for the first mirrored video frame.'));
    }, timeoutMs);
    if (typeof video.requestVideoFrameCallback === 'function') {
      callbackId = video.requestVideoFrameCallback(() => {
        cleanup();
        resolve();
      });
    }
    onLoadedData();
  });
}
