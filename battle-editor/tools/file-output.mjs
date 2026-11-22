import { lstatSync, mkdirSync, mkdtempSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function lstatIfPresent(file) {
  try {
    return lstatSync(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return null;
  }
}

export function stageOutput(file) {
  mkdirSync(dirname(file), { recursive: true });
  const dir = mkdtempSync(join(dirname(file), '.dr-write-'));
  const temp = join(dir, basename(file));
  return {
    temp,
    publish: () => renameSync(temp, file),
    close() {
      if (lstatIfPresent(temp)) unlinkSync(temp);
      rmdirSync(dir);
    },
  };
}

export function writeOutput(file, data) {
  const output = stageOutput(file);
  try {
    writeFileSync(output.temp, data);
    output.publish();
  } finally {
    output.close();
  }
}
