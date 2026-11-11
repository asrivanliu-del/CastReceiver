import { copyFileSync } from 'node:fs';

copyFileSync(
  new URL('../node_modules/soundtouchjs/LICENSE', import.meta.url),
  new URL('../dist/SOUNDTOUCH-LICENSE.txt', import.meta.url)
);
