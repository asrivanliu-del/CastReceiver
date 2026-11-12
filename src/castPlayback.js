export function getSubtitleTime(isVideo, videoTime, activeTime) {
  const time = isVideo ? videoTime : activeTime;
  return Number.isFinite(time) ? Math.max(0, time) : 0;
}

export function getKaraokeCharacterState(currentTime, character) {
  const complete = currentTime >= character.end;
  const active = !complete && currentTime > character.start && character.end > character.start;
  const fill = active
    ? Math.min(1, (currentTime - character.start) / (character.end - character.start))
    : 0;
  return { active, complete, fill };
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
