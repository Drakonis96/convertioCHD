const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const archiver = require('archiver');

const { MAX_CONVERSION_CONCURRENCY, MAX_EXTRACTED_BYTES, MAX_EXTRACTED_FILES } = require('../config');
const { extractArchive, inspectArchive, isArchiveName } = require('./archive');
const { convertAudioToWav } = require('./audio');
const { isAbortError, throwIfAborted } = require('./cancellation');
const { buildDiscGroups, detectTrackMode, normalizeCueReference, rewriteCueText, stripManagedExtension, toCuePath } = require('./disc');
const { decodeEcmFile } = require('./ecm');
const { runCommand } = require('./exec');
const { ensureDir, formatBytes, listFilesRecursive, slugify, sumFileSizes } = require('./fs-utils');
const { getConsoleDefaultOutputProfile, getOutputProfileEntry, normalizeConversionOptions } = require('./output-profile');

const chdmanPackage = require('chdman/package.json');
const chdmanBinPath = path.resolve(path.dirname(require.resolve('chdman/package.json')), chdmanPackage.bin.chdman);
const DVD_SIZE_THRESHOLD_BYTES = 900 * 1024 * 1024;
const MAX_ARCHIVE_NESTING_DEPTH = 3;

function emitUpdate(onUpdate, payload) {
  if (typeof onUpdate === 'function') {
    onUpdate(payload);
  }
}

function clampProgress(value) {
  if (!Number.isFinite(value)) {
    return null;
  }

  return Math.max(0, Math.min(100, Math.round(value)));
}

function averageProgress(values) {
  if (!values.length) {
    return 0;
  }

  return clampProgress(values.reduce((sum, value) => sum + value, 0) / values.length);
}

async function runWithConcurrency(items, concurrency, worker) {
  if (!items.length) {
    return;
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  let nextIndex = 0;

  async function runWorker() {
    for (;;) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= items.length) {
        return;
      }

      await worker(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
}

async function runChdman(args, options = {}) {
  return runCommand(process.execPath, [chdmanBinPath, ...args], options);
}

async function expandInputFiles(inputFiles, extractionRoot, options = {}) {
  const collectedFiles = [];
  let totalExpandedBytes = 0;
  let totalExpandedFiles = 0;

  async function collectExpandedFile(sourcePath, relativePath, source) {
    const stats = await fs.stat(sourcePath);
    collectedFiles.push({
      absolutePath: sourcePath,
      displayName: path.basename(sourcePath),
      relativePath,
      size: stats.size,
      source,
    });
  }

  async function expandArchiveFile(archivePath, archiveName, archiveRelativePath, depth, labelPrefix) {
    if (depth > MAX_ARCHIVE_NESTING_DEPTH) {
      throw new Error(`Nested archives exceed the supported depth (${MAX_ARCHIVE_NESTING_DEPTH}).`);
    }

    emitUpdate(options.onUpdate, {
      message: `Inspecting archive ${archiveName}`,
    });

    const archiveStats = await inspectArchive(archivePath, {
      signal: options.signal,
    });

    totalExpandedBytes += archiveStats.totalBytes;
    totalExpandedFiles += archiveStats.entries;

    if (totalExpandedBytes > (options.maxExtractedBytes || MAX_EXTRACTED_BYTES)) {
      throw new Error(
        `Archive contents exceed the extraction limit (${formatBytes(options.maxExtractedBytes || MAX_EXTRACTED_BYTES)}).`,
      );
    }

    if (totalExpandedFiles > (options.maxExtractedFiles || MAX_EXTRACTED_FILES)) {
      throw new Error(
        `Archive contents exceed the extracted file limit (${options.maxExtractedFiles || MAX_EXTRACTED_FILES} files).`,
      );
    }

    const extractionDirectory = path.join(
      extractionRoot,
      `${labelPrefix}-${depth}-${slugify(stripManagedExtension(archiveName))}`,
    );
    emitUpdate(options.onUpdate, {
      message: `Extracting ${archiveName}`,
    });

    const extractedFiles = await extractArchive(archivePath, extractionDirectory, {
      signal: options.signal,
    });
    const extractedBytes = await sumFileSizes(extractedFiles);

    if (extractedBytes > archiveStats.totalBytes) {
      totalExpandedBytes += extractedBytes - archiveStats.totalBytes;
    }

    if (totalExpandedBytes > (options.maxExtractedBytes || MAX_EXTRACTED_BYTES)) {
      throw new Error(
        `Extracted data exceed the extraction limit (${formatBytes(options.maxExtractedBytes || MAX_EXTRACTED_BYTES)}).`,
      );
    }

    for (const extractedFile of extractedFiles) {
      throwIfAborted(options.signal);
      const nestedRelativePath = path.join(path.dirname(archiveRelativePath), path.relative(extractionDirectory, extractedFile));
      const nestedName = path.basename(extractedFile);

      if (isArchiveName(nestedName)) {
        await expandArchiveFile(extractedFile, nestedName, nestedRelativePath, depth + 1, labelPrefix);
        continue;
      }

      await collectExpandedFile(extractedFile, nestedRelativePath, 'archive');
    }
  }

  for (let index = 0; index < inputFiles.length; index += 1) {
    throwIfAborted(options.signal);
    const inputFile = inputFiles[index];
    const originalName = path.basename(inputFile.originalName);

    if (isArchiveName(originalName)) {
      await expandArchiveFile(
        inputFile.absolutePath,
        originalName,
        originalName,
        1,
        String(index + 1).padStart(2, '0'),
      );
      continue;
    }

    await collectExpandedFile(inputFile.absolutePath, originalName, 'upload');
  }

  return {
    expandedBytes: totalExpandedBytes,
    expandedFiles: totalExpandedFiles,
    files: collectedFiles,
  };
}

async function linkOrCopyFile(sourcePath, destinationPath) {
  await ensureDir(path.dirname(destinationPath));

  try {
    await fs.link(sourcePath, destinationPath);
  } catch (error) {
    if (error.code === 'EEXIST') {
      return destinationPath;
    }

    await fs.copyFile(sourcePath, destinationPath);
  }

  return destinationPath;
}

function cueFileTypeForName(fileName) {
  const extension = path.extname(fileName || '').toLowerCase();

  if (extension === '.wav') {
    return 'WAVE';
  }

  if (extension === '.aiff') {
    return 'AIFF';
  }

  if (extension === '.flac' || extension === '.ape') {
    return 'WAVE';
  }

  if (extension === '.mp3') {
    return 'MP3';
  }

  return 'BINARY';
}

function buildPreparedFileMappings(group, preparedFiles) {
  const fileMappings = new Map();

  for (const referenceMatch of group.referenceMatches) {
    if (!referenceMatch.sourceFile) {
      continue;
    }

    fileMappings.set(
      normalizeCueReference(referenceMatch.cueReference),
      preparedFiles.get(referenceMatch.sourceFile.absolutePath),
    );
  }

  return fileMappings;
}

async function prepareReferencedFiles(group, groupDirectory, onUpdate, options = {}) {
  const preparedFiles = new Map();

  for (const sourceFile of group.referencedFiles) {
    throwIfAborted(options.signal);
    let preparedPath = sourceFile.absolutePath;

    if (sourceFile.isEcm) {
      const decodedFileName = sourceFile.displayName.replace(/\.ecm$/i, '');
      const decodedAbsolutePath = path.join(groupDirectory, decodedFileName);

      emitUpdate(onUpdate, {
        message: `Decoding ECM: ${sourceFile.displayName}`,
      });

      await decodeEcmFile(sourceFile.absolutePath, decodedAbsolutePath, {
        signal: options.signal,
        onProgress(progress) {
          emitUpdate(onUpdate, {
            message: `Decoding ECM: ${sourceFile.displayName}`,
            progress,
          });
        },
      });

      preparedPath = decodedAbsolutePath;
    }

    if (sourceFile.isAudioAsset && path.extname(preparedPath).toLowerCase() !== '.wav') {
      const wavAbsolutePath = path.join(groupDirectory, `${stripManagedExtension(sourceFile.displayName)}.wav`);
      emitUpdate(onUpdate, {
        message: `Converting audio track: ${sourceFile.displayName}`,
      });

      await convertAudioToWav(preparedPath, wavAbsolutePath, {
        signal: options.signal,
      });

      preparedFiles.set(sourceFile.absolutePath, wavAbsolutePath);
      continue;
    }

    preparedFiles.set(sourceFile.absolutePath, preparedPath);
  }

  return preparedFiles;
}

async function stageDescriptorFiles(group, groupDirectory, onUpdate, options = {}) {
  const stagedFiles = new Map();

  for (const sourceFile of group.sourceFiles) {
    throwIfAborted(options.signal);
    const stagedRelativePath = sourceFile.relativePath || sourceFile.displayName;
    const stagedPath = path.join(groupDirectory, stagedRelativePath);

    if (sourceFile.isEcm) {
      const decodedPath = stagedPath.replace(/\.ecm$/i, '');
      emitUpdate(onUpdate, {
        message: `Decoding ECM: ${sourceFile.displayName}`,
      });

      await decodeEcmFile(sourceFile.absolutePath, decodedPath, {
        signal: options.signal,
        onProgress(progress) {
          emitUpdate(onUpdate, {
            message: `Decoding ECM: ${sourceFile.displayName}`,
            progress,
          });
        },
      });
      stagedFiles.set(sourceFile.absolutePath, decodedPath);
      continue;
    }

    await linkOrCopyFile(sourceFile.absolutePath, stagedPath);
    stagedFiles.set(sourceFile.absolutePath, stagedPath);
  }

  return stagedFiles;
}

async function prepareDirectImageInput(sourceFile, groupDirectory, onUpdate, options = {}) {
  throwIfAborted(options.signal);

  if (!sourceFile.isEcm) {
    return sourceFile.absolutePath;
  }

  const decodedFileName = sourceFile.displayName.replace(/\.ecm$/i, '');
  const decodedAbsolutePath = path.join(groupDirectory, decodedFileName);

  emitUpdate(onUpdate, {
    message: `Decoding ECM: ${sourceFile.displayName}`,
  });

  await decodeEcmFile(sourceFile.absolutePath, decodedAbsolutePath, {
    signal: options.signal,
    onProgress(progress) {
      emitUpdate(onUpdate, {
        message: `Decoding ECM: ${sourceFile.displayName}`,
        progress,
      });
    },
  });

  return decodedAbsolutePath;
}

async function createCueForStandaloneImage(group, preparedImagePath, cueOutputPath) {
  const trackMode = await detectTrackMode(preparedImagePath);
  const relativePath = toCuePath(path.relative(path.dirname(cueOutputPath), preparedImagePath));
  const cueText = [
    `FILE "${relativePath}" BINARY`,
    `  TRACK 01 ${trackMode}`,
    '    INDEX 01 00:00:00',
    '',
  ].join('\n');

  await fs.writeFile(cueOutputPath, cueText, 'utf8');
}

async function createCueFromTracks(group, preparedFiles, cueOutputPath) {
  if (group.missingReferences.length > 0) {
    throw new Error(`Missing files referenced by the descriptor: ${group.missingReferences.join(', ')}`);
  }

  const fileMappings = buildPreparedFileMappings(group, preparedFiles);
  const cueLines = [];
  let currentFilePath = null;

  for (const track of group.parsedDescriptor.tracks || []) {
    const preparedPath = fileMappings.get(normalizeCueReference(track.fileName));
    if (!preparedPath) {
      throw new Error(`Could not stage the referenced track file ${track.fileName}.`);
    }

    if (preparedPath !== currentFilePath) {
      currentFilePath = preparedPath;
      cueLines.push(
        `FILE "${toCuePath(path.relative(path.dirname(cueOutputPath), preparedPath))}" ${cueFileTypeForName(track.fileName)}`,
      );
    }

    const trackMode = track.trackMode === 'AUDIO' ? 'AUDIO' : await detectTrackMode(preparedPath);
    cueLines.push(`  TRACK ${String(track.number || cueLines.length + 1).padStart(2, '0')} ${trackMode}`);
    cueLines.push('    INDEX 01 00:00:00');
  }

  cueLines.push('');
  await fs.writeFile(cueOutputPath, cueLines.join('\n'), 'utf8');
}

async function createCueForDescriptorGroup(group, preparedFiles, cueOutputPath) {
  if (group.missingReferences.length > 0) {
    throw new Error(`Missing files referenced by the descriptor: ${group.missingReferences.join(', ')}`);
  }

  if (group.descriptorType === 'cue_sheet') {
    const fileMappings = buildPreparedFileMappings(group, preparedFiles);
    let singleTrackMode = null;

    if (group.parsedDescriptor.fileReferences.length === 1 && group.parsedDescriptor.trackModes.length === 1) {
      const singleSource = group.referenceMatches[0]?.sourceFile || group.referencedFiles[0];
      if (singleSource) {
        singleTrackMode = await detectTrackMode(preparedFiles.get(singleSource.absolutePath));
      }
    }

    const cueText = rewriteCueText(group.descriptorText, fileMappings, path.dirname(cueOutputPath), {
      fileTypeResolver(_originalFileName, mappedPath) {
        return cueFileTypeForName(mappedPath);
      },
      singleTrackMode,
    });
    await fs.writeFile(cueOutputPath, cueText, 'utf8');
    return;
  }

  await createCueFromTracks(group, preparedFiles, cueOutputPath);
}

async function createZipArchive(archivePath, files) {
  await ensureDir(path.dirname(archivePath));

  await new Promise((resolve, reject) => {
    const output = require('node:fs').createWriteStream(archivePath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);

    for (const file of files) {
      archive.file(file.absolutePath, { name: file.name });
    }

    archive.finalize();
  });
}

async function resolveGroupOutputProfile(group, conversionOptions = {}) {
  const normalizedOptions = normalizeConversionOptions(conversionOptions);
  const supportedProfiles = group.supportedOutputProfiles?.length ? group.supportedOutputProfiles : ['cd'];

  if (normalizedOptions.selectionMode === 'manual') {
    if (!supportedProfiles.includes(normalizedOptions.manualOutputProfile)) {
      const supportedLabels = supportedProfiles.map((profileId) => getOutputProfileEntry(profileId).label).join(', ');
      throw new Error(
        `${group.outputBaseName || group.name} cannot be converted as ${normalizedOptions.manualOutputProfileLabel}. Supported output: ${supportedLabels}.`,
      );
    }

    const outputProfileEntry = getOutputProfileEntry(normalizedOptions.manualOutputProfile);
    return {
      id: outputProfileEntry.id,
      label: outputProfileEntry.label,
      reason: 'manual',
    };
  }

  if (group.suggestedOutputProfile && supportedProfiles.includes(group.suggestedOutputProfile)) {
    const outputProfileEntry = getOutputProfileEntry(group.suggestedOutputProfile);
    return {
      id: outputProfileEntry.id,
      label: outputProfileEntry.label,
      reason: 'format',
    };
  }

  const consoleDefaultOutputProfile = getConsoleDefaultOutputProfile(normalizedOptions.consoleId);
  if (consoleDefaultOutputProfile !== 'auto' && supportedProfiles.includes(consoleDefaultOutputProfile)) {
    const outputProfileEntry = getOutputProfileEntry(consoleDefaultOutputProfile);
    return {
      id: outputProfileEntry.id,
      label: outputProfileEntry.label,
      reason: 'console',
    };
  }

  if (supportedProfiles.length === 1) {
    const outputProfileEntry = getOutputProfileEntry(supportedProfiles[0]);
    return {
      id: outputProfileEntry.id,
      label: outputProfileEntry.label,
      reason: 'format',
    };
  }

  const primarySource = group.referencedFiles?.[0] || group.sourceFiles?.[0] || null;
  if (primarySource?.imageExtension === 'iso') {
    const fileStats = await fs.stat(primarySource.absolutePath);
    const inferredProfile = fileStats.size > DVD_SIZE_THRESHOLD_BYTES ? 'dvd' : 'cd';
    const outputProfileEntry = getOutputProfileEntry(inferredProfile);
    return {
      id: outputProfileEntry.id,
      label: outputProfileEntry.label,
      reason: 'size',
    };
  }

  const outputProfileEntry = getOutputProfileEntry(supportedProfiles[0]);
  return {
    id: outputProfileEntry.id,
    label: outputProfileEntry.label,
    reason: 'fallback',
  };
}

async function convertGroup(group, directories, onUpdate, options = {}) {
  throwIfAborted(options.signal);
  const groupDirectory = path.join(
    directories.workRoot,
    `${String(options.groupIndex + 1).padStart(2, '0')}-${slugify(group.outputBaseName)}`,
  );
  await ensureDir(groupDirectory);

  const resolvedOutputProfile = await resolveGroupOutputProfile(group, options.conversionOptions);
  const outputProfileEntry = getOutputProfileEntry(resolvedOutputProfile.id);

  const emitGroupUpdate = (localProgress, message) =>
    emitUpdate(onUpdate, {
      message,
      outputProfile: resolvedOutputProfile.id,
      outputProfileLabel: outputProfileEntry.label,
      progress: clampProgress(localProgress),
    });

  emitGroupUpdate(2, `Preparing ${group.outputBaseName}`);

  let chdInputPath = null;
  const usesDirectIsoInput =
    resolvedOutputProfile.id === 'dvd' &&
    group.standalone &&
    group.referencedFiles?.[0]?.imageExtension === 'iso';

  if (usesDirectIsoInput) {
    chdInputPath = await prepareDirectImageInput(
      group.referencedFiles[0],
      groupDirectory,
      (payload) => {
        const localProgress = typeof payload.progress === 'number' ? 5 + payload.progress * 0.2 : 10;
        emitGroupUpdate(localProgress, payload.message);
      },
      { signal: options.signal },
    );
  } else if (group.strategy === 'direct_descriptor') {
    if (group.missingReferences.length > 0) {
      throw new Error(`Missing files referenced by the descriptor: ${group.missingReferences.join(', ')}`);
    }

    const stagedFiles = await stageDescriptorFiles(
      group,
      groupDirectory,
      (payload) => {
        const localProgress = typeof payload.progress === 'number' ? 5 + payload.progress * 0.15 : 10;
        emitGroupUpdate(localProgress, payload.message);
      },
      {
        signal: options.signal,
      },
    );

    const descriptorSource = group.descriptorFile || group.sourceFiles[0];
    chdInputPath = stagedFiles.get(descriptorSource.absolutePath);
  } else {
    const preparedFiles = await prepareReferencedFiles(
      group,
      groupDirectory,
      (payload) => {
        const localProgress = typeof payload.progress === 'number' ? 5 + payload.progress * 0.2 : 8;
        emitGroupUpdate(localProgress, payload.message);
      },
      {
        signal: options.signal,
      },
    );
    const cueOutputPath = path.join(groupDirectory, `${group.outputBaseName}.cue`);

    if (group.standalone) {
      const preparedImagePath = preparedFiles.get(group.referencedFiles[0].absolutePath);
      emitGroupUpdate(20, `Building descriptor for ${group.outputBaseName}`);
      await createCueForStandaloneImage(group, preparedImagePath, cueOutputPath);
    } else {
      emitGroupUpdate(20, `Normalizing descriptor for ${group.outputBaseName}`);
      await createCueForDescriptorGroup(group, preparedFiles, cueOutputPath);
    }

    chdInputPath = cueOutputPath;
  }

  const chdOutputPath = path.join(directories.outputRoot, `${group.outputBaseName}.chd`);
  let chdmanTail = '';
  const handleChdmanOutput = (text) => {
    chdmanTail = `${chdmanTail}${text}`.slice(-96);
    const matches = [...chdmanTail.matchAll(/(\d{1,3})(?:\.\d+)?%/g)];
    if (!matches.length) {
      return;
    }

    const latestPercent = Number(matches[matches.length - 1][1]);
    emitGroupUpdate(30 + latestPercent * 0.7, `Converting ${group.outputBaseName} to ${outputProfileEntry.label}`);
  };

  emitGroupUpdate(30, `Converting ${group.outputBaseName} to ${outputProfileEntry.label}`);

  await runChdman([outputProfileEntry.command, '-f', '-i', chdInputPath, '-o', chdOutputPath], {
    cwd: groupDirectory,
    onStderr: handleChdmanOutput,
    onStdout: handleChdmanOutput,
    signal: options.signal,
  });

  const chdStats = await fs.stat(chdOutputPath);
  emitGroupUpdate(100, `CHD created: ${path.basename(chdOutputPath)}`);

  return {
    id: randomUUID(),
    name: path.basename(chdOutputPath),
    absolutePath: chdOutputPath,
    outputProfile: resolvedOutputProfile.id,
    outputProfileLabel: outputProfileEntry.label,
    size: chdStats.size,
    sourceName: group.outputBaseName,
  };
}

function buildDetectionMessage(groups) {
  const reviewCount = groups.filter((group) => group.diagnostic.confidence !== 'high').length;
  let message = groups.length === 1 ? 'Detected 1 game.' : `Detected ${groups.length} games.`;

  if (reviewCount > 0) {
    message += ` ${reviewCount} ${reviewCount === 1 ? 'group needs' : 'groups need'} review before conversion.`;
  } else {
    message += ' Starting conversion.';
  }

  return message;
}

async function processConversionBatch({
  conversionConcurrency = MAX_CONVERSION_CONCURRENCY,
  conversionOptions = {},
  jobId,
  jobDirectory,
  inputFiles,
  onUpdate,
  signal,
}) {
  const extractionRoot = path.join(jobDirectory, 'extracted');
  const workRoot = path.join(jobDirectory, 'work');
  const outputRoot = path.join(jobDirectory, 'output');
  const normalizedConversionOptions = normalizeConversionOptions(conversionOptions);

  await ensureDir(extractionRoot);
  await ensureDir(workRoot);
  await ensureDir(outputRoot);

  emitUpdate(onUpdate, {
    conversionOptions: normalizedConversionOptions,
    status: 'preparing',
    message: 'Analyzing uploaded files',
  });

  const expandedSummary = await expandInputFiles(inputFiles, extractionRoot, {
    maxExtractedBytes: MAX_EXTRACTED_BYTES,
    maxExtractedFiles: MAX_EXTRACTED_FILES,
    onUpdate(payload) {
      emitUpdate(onUpdate, {
        conversionOptions: normalizedConversionOptions,
        status: 'preparing',
        progress: 2,
        ...payload,
      });
    },
    signal,
  });
  const validFiles = expandedSummary.files.filter((sourceFile) => !sourceFile.displayName.startsWith('.'));

  if (validFiles.length === 0) {
    throw new Error('No valid files were found to convert.');
  }

  const groups = buildDiscGroups(validFiles);
  if (groups.length === 0) {
    throw new Error(
      'No compatible disc images were detected (.bin, .img, .iso, .cue, .gdi, .toc, .ccd, .mds, .cdi, .nrg, or .ecm).',
    );
  }

  const actualConversionConcurrency = Math.max(
    1,
    Math.min(Number(conversionConcurrency) || MAX_CONVERSION_CONCURRENCY, groups.length),
  );
  const groupDiagnostics = groups.map((group) => group.diagnostic);
  const groupNames = groups.map((group) => group.outputBaseName);

  emitUpdate(onUpdate, {
    completedGroups: 0,
    conversionConcurrency: actualConversionConcurrency,
    conversionOptions: normalizedConversionOptions,
    detectedGroups: groups.length,
    groupDiagnostics,
    groupNames,
    message: buildDetectionMessage(groups),
    processingGroups: [],
    progress: 5,
    status: 'preparing',
    title: groups.length === 1 ? groups[0].outputBaseName : `${groups[0].outputBaseName} +${groups.length - 1} more`,
    totalGroups: groups.length,
  });

  const convertedEntries = [];
  const failedEntries = [];
  const groupStates = groups.map(() => ({
    progress: 0,
    status: 'pending',
  }));

  function emitBatchProgress(message, status = 'processing') {
    const completedGroups = groupStates.filter((groupState) => ['completed', 'failed'].includes(groupState.status)).length;
    const processingGroups = groupStates
      .map((groupState, index) => (groupState.status === 'processing' ? groups[index].outputBaseName : null))
      .filter(Boolean);
    const currentGroup = processingGroups.length > 0 ? Math.min(groups.length, completedGroups + 1) : completedGroups || null;

    emitUpdate(onUpdate, {
      completedGroups,
      conversionConcurrency: actualConversionConcurrency,
      conversionOptions: normalizedConversionOptions,
      currentGroup,
      detectedGroups: groups.length,
      groupDiagnostics,
      groupNames,
      message,
      processingGroups,
      progress: averageProgress(groupStates.map((groupState) => groupState.progress)),
      status,
      totalGroups: groups.length,
    });
  }

  await runWithConcurrency(groups, actualConversionConcurrency, async (group, index) => {
    throwIfAborted(signal);
    groupStates[index].status = 'processing';
    emitBatchProgress(`Queued ${group.outputBaseName} for conversion`);

    try {
      const convertedFile = await convertGroup(
        group,
        { extractionRoot, outputRoot, workRoot },
        (payload) => {
          groupStates[index].status = 'processing';
          groupStates[index].progress = typeof payload.progress === 'number' ? payload.progress : groupStates[index].progress;
          emitBatchProgress(payload.message);
        },
        { conversionOptions: normalizedConversionOptions, groupIndex: index, signal },
      );

      convertedEntries.push({
        file: convertedFile,
        index,
      });
      groupStates[index].progress = 100;
      groupStates[index].status = 'completed';
      emitBatchProgress(`CHD created: ${convertedFile.name}`);
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }

      failedEntries.push({
        error: error.message,
        index,
        name: group.outputBaseName,
      });
      groupStates[index].progress = 100;
      groupStates[index].status = 'failed';
      emitBatchProgress(`Skipped ${group.outputBaseName} after an error.`);
    }
  });

  const convertedFiles = convertedEntries
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.file);
  const failedGroups = failedEntries
    .sort((left, right) => left.index - right.index)
    .map((entry) => ({
      error: entry.error,
      name: entry.name,
    }));

  if (convertedFiles.length === 0) {
    const firstError = failedGroups[0]?.error || 'The conversion did not produce any CHD files.';
    throw new Error(firstError);
  }

  let archiveFile = null;
  if (convertedFiles.length > 1) {
    emitUpdate(onUpdate, {
      completedGroups: groups.length,
      conversionConcurrency: actualConversionConcurrency,
      conversionOptions: normalizedConversionOptions,
      currentGroup: groups.length,
      detectedGroups: groups.length,
      groupDiagnostics,
      groupNames,
      message: 'Packaging completed conversions',
      processingGroups: [],
      progress: 100,
      status: 'processing',
      totalGroups: groups.length,
    });
    archiveFile = {
      id: randomUUID(),
      name: `${jobId}-chd.zip`,
      absolutePath: path.join(outputRoot, `${jobId}-chd.zip`),
    };

    await createZipArchive(archiveFile.absolutePath, convertedFiles);
    const archiveStats = await fs.stat(archiveFile.absolutePath);
    archiveFile.size = archiveStats.size;
  }

  return {
    archiveFile,
    conversionConcurrency: actualConversionConcurrency,
    conversionOptions: normalizedConversionOptions,
    convertedFiles,
    expandedBytes: expandedSummary.expandedBytes,
    expandedFiles: expandedSummary.expandedFiles,
    extractedFiles: await listFilesRecursive(outputRoot),
    failedGroups,
    groupDiagnostics,
  };
}

module.exports = {
  processConversionBatch,
  resolveGroupOutputProfile,
  runWithConcurrency,
};
