const path = require('node:path');

const { path7z } = require('7zip-bin-full');

const { runCommand } = require('./exec');
const { ensureDir, listFilesRecursive } = require('./fs-utils');

const ARCHIVE_EXTENSIONS = [
  '.zip',
  '.7z',
  '.rar',
  '.tar',
  '.tgz',
  '.tbz',
  '.tbz2',
  '.txz',
  '.gz',
  '.bz2',
  '.xz',
];

function isArchiveName(fileName) {
  const lowerName = fileName.toLowerCase();
  return ARCHIVE_EXTENSIONS.some((extension) => lowerName.endsWith(extension));
}

function parseArchiveListing(output) {
  const entries = [];
  const lines = output.split(/\r?\n/);
  let currentEntry = null;
  let insideEntries = false;

  for (const line of lines) {
    if (line.trim() === '----------') {
      insideEntries = true;
      continue;
    }

    if (!insideEntries || !line.includes(' = ')) {
      continue;
    }

    const separatorIndex = line.indexOf(' = ');
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 3).trim();

    if (key === 'Path' && currentEntry && Object.keys(currentEntry).length > 0) {
      entries.push(currentEntry);
      currentEntry = {};
    }

    if (!currentEntry) {
      currentEntry = {};
    }

    currentEntry[key] = value;
  }

  if (insideEntries && currentEntry && Object.keys(currentEntry).length > 0) {
    entries.push(currentEntry);
  }

  return entries;
}

async function inspectArchive(archivePath, options = {}) {
  const { stdout } = await runCommand(path7z, ['l', '-slt', archivePath], {
    signal: options.signal,
  });

  const entries = parseArchiveListing(stdout).filter((entry) => entry.Path && entry.Path !== archivePath);
  const files = entries.filter((entry) => entry.Folder !== '+');
  const totalBytes = files.reduce((sum, entry) => sum + Number(entry.Size || 0), 0);

  return {
    entries: files.length,
    totalBytes,
  };
}

async function extractArchive(archivePath, destinationDirectory, options = {}) {
  await ensureDir(destinationDirectory);

  await runCommand(path7z, ['x', archivePath, `-o${destinationDirectory}`, '-y', '-bb0', '-bd'], {
    signal: options.signal,
  });

  return listFilesRecursive(destinationDirectory);
}

module.exports = {
  extractArchive,
  inspectArchive,
  isArchiveName,
};
