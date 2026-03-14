const fs = require('node:fs/promises');
const path = require('node:path');

async function ensureDir(directoryPath) {
  await fs.mkdir(directoryPath, { recursive: true });
  return directoryPath;
}

async function listFilesRecursive(rootDirectory) {
  const results = [];

  async function walk(currentDirectory) {
    const entries = await fs.readdir(currentDirectory, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name === '.DS_Store' || entry.name === '__MACOSX') {
        continue;
      }

      const absolutePath = path.join(currentDirectory, entry.name);

      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile()) {
        results.push(absolutePath);
      }
    }
  }

  await walk(rootDirectory);
  results.sort((left, right) => left.localeCompare(right));
  return results;
}

async function sumFileSizes(filePaths) {
  let total = 0;

  for (const filePath of filePaths) {
    const stats = await fs.stat(filePath);
    total += stats.size;
  }

  return total;
}

function slugify(value) {
  return value
    .normalize('NFKD')
    .replace(/[^\w\s.-]/g, '')
    .trim()
    .replace(/[\s.]+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase() || 'file';
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

async function cleanupOldDirectories(rootDirectory, maxAgeMs) {
  await ensureDir(rootDirectory);

  const entries = await fs.readdir(rootDirectory, { withFileTypes: true });
  const now = Date.now();

  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const absolutePath = path.join(rootDirectory, entry.name);
        const stats = await fs.stat(absolutePath);

        if (now - stats.mtimeMs > maxAgeMs) {
          await fs.rm(absolutePath, { recursive: true, force: true });
        }
      }),
  );
}

module.exports = {
  cleanupOldDirectories,
  ensureDir,
  formatBytes,
  listFilesRecursive,
  slugify,
  sumFileSizes,
};
