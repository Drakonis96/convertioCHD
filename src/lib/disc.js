const fs = require('node:fs');
const path = require('node:path');

const STRIPPABLE_EXTENSIONS = [
  '.bin.ecm',
  '.img.ecm',
  '.iso.ecm',
  '.cue',
  '.gdi',
  '.toc',
  '.ccd',
  '.mds',
  '.cdi',
  '.nrg',
  '.bin',
  '.img',
  '.iso',
  '.ecm',
  '.mdf',
  '.raw',
  '.sub',
  '.wav',
  '.flac',
  '.ape',
  '.mp3',
  '.aiff',
];

function stripManagedExtension(fileName) {
  const lowerName = fileName.toLowerCase();
  const matchedExtension = STRIPPABLE_EXTENSIONS.find((extension) => lowerName.endsWith(extension));
  return matchedExtension ? fileName.slice(0, -matchedExtension.length) : fileName;
}

function normalizeKey(fileName) {
  return stripManagedExtension(path.basename(fileName))
    .normalize('NFKD')
    .replace(/[^\w\s()[\].-]/g, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeCueReference(value) {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').trim().toLowerCase();
}

function stripTrackSuffix(fileName) {
  return stripManagedExtension(path.basename(fileName))
    .replace(/\s*[\[(]track\s*0*\d+[\])]/gi, '')
    .replace(/\s+\btrack\s*0*\d+\b/gi, '')
    .replace(/\s+\btrk\s*0*\d+\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function extractTrackNumber(fileName) {
  const match = stripManagedExtension(path.basename(fileName)).match(/(?:^|\s|[\[(])(?:track|trk)\s*0*(\d+)(?:$|\s|[\])])/i);
  return match ? Number(match[1]) : null;
}

function tokenizeDescriptorLine(line) {
  const tokens = [];
  const tokenPattern = /"([^"]+)"|(\S+)/g;
  let match = tokenPattern.exec(line);

  while (match) {
    tokens.push(match[1] || match[2]);
    match = tokenPattern.exec(line);
  }

  return tokens;
}

function classifySourceFile(sourceFile) {
  const lowerName = sourceFile.displayName.toLowerCase();
  const lowerRelativePath = sourceFile.relativePath.toLowerCase();
  const nameWithoutEcm = lowerName.replace(/\.ecm$/i, '');
  const inferredImageExtension = lowerName.endsWith('.bin.ecm')
    ? 'bin'
    : lowerName.endsWith('.img.ecm')
      ? 'img'
      : lowerName.endsWith('.iso.ecm')
        ? 'iso'
        : path.extname(nameWithoutEcm).replace('.', '') || 'bin';

  const descriptorKind = lowerName.endsWith('.cue')
    ? 'cue'
    : lowerName.endsWith('.gdi')
      ? 'gdi'
      : lowerName.endsWith('.toc')
        ? 'toc'
        : lowerName.endsWith('.ccd')
          ? 'ccd'
          : lowerName.endsWith('.mds')
            ? 'mds'
            : lowerName.endsWith('.cdi')
              ? 'cdi'
              : lowerName.endsWith('.nrg')
                ? 'nrg'
                : null;

  const isEcm = lowerName.endsWith('.ecm');
  const isImage = /\.(bin|img|iso)(\.ecm)?$/i.test(lowerName) || lowerName.endsWith('.ecm');
  const isCloneCdAsset = /\.(sub)$/i.test(lowerName);
  const isAudioAsset = /\.(wav|flac|ape|mp3|aiff)$/i.test(lowerName);
  const isGdiAsset = /\.(raw)$/i.test(lowerName);
  const isMdsAsset = /\.(mdf)$/i.test(lowerName);

  return {
    ...sourceFile,
    descriptorKind,
    imageExtension: inferredImageExtension,
    isAudioAsset,
    isCloneCdAsset,
    isCue: descriptorKind === 'cue',
    isDescriptor: Boolean(descriptorKind),
    isEcm,
    isGdiAsset,
    isImage,
    isMdsAsset,
    kind: descriptorKind || (isImage ? 'image' : 'asset'),
    looseTrackKey: normalizeKey(stripTrackSuffix(sourceFile.displayName)),
    matchKey: normalizeKey(lowerRelativePath),
    normalizedName: normalizeCueReference(sourceFile.displayName),
    normalizedRelativePath: normalizeCueReference(sourceFile.relativePath),
    trackNumber: extractTrackNumber(sourceFile.displayName),
  };
}

function parseCueFileLine(line) {
  const quotedMatch = line.match(/^(\s*FILE\s+)"([^"]+)"(\s+.+)$/i);
  if (quotedMatch) {
    return {
      fileName: quotedMatch[2],
      prefix: quotedMatch[1],
      suffix: quotedMatch[3],
    };
  }

  const bareMatch = line.match(/^(\s*FILE\s+)(.+?)(\s+(?:BINARY|MOTOROLA|WAVE|AIFF|MP3).*)$/i);
  if (bareMatch) {
    return {
      fileName: bareMatch[2].trim(),
      prefix: bareMatch[1],
      suffix: bareMatch[3],
    };
  }

  return null;
}

function parseCueText(cueText) {
  const fileReferences = [];
  const trackModes = [];
  const tracks = [];
  let currentFileName = null;

  for (const line of cueText.split(/\r?\n/)) {
    const fileLine = parseCueFileLine(line);
    if (fileLine) {
      currentFileName = fileLine.fileName;
      fileReferences.push(fileLine.fileName);
      continue;
    }

    const trackMatch = line.match(/^\s*TRACK\s+(\d+)\s+(\S+)/i);
    if (trackMatch) {
      const trackMode = trackMatch[2].toUpperCase();
      trackModes.push(trackMode);
      tracks.push({
        fileName: currentFileName,
        number: Number(trackMatch[1]),
        trackMode,
      });
    }
  }

  return {
    fileReferences,
    trackModes,
    tracks,
  };
}

function parseGdiText(gdiText) {
  const fileReferences = [];
  const trackModes = [];
  const tracks = [];
  const lines = gdiText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  for (const line of lines.slice(1)) {
    const tokens = tokenizeDescriptorLine(line);
    if (tokens.length < 6) {
      continue;
    }

    const offset = tokens[tokens.length - 1];
    const fileName = tokens.slice(4, -1).join(' ');
    const trackNumber = Number(tokens[0]);
    const control = Number(tokens[2]);
    const sectorSize = Number(tokens[3]);
    const trackMode = inferGdiTrackMode({ control, fileName, offset, sectorSize });

    fileReferences.push(fileName);
    trackModes.push(trackMode);
    tracks.push({
      control,
      fileName,
      number: Number.isFinite(trackNumber) ? trackNumber : tracks.length + 1,
      offset,
      sectorSize,
      trackMode,
    });
  }

  return {
    fileReferences,
    trackModes,
    tracks,
  };
}

function inferGdiTrackMode({ control, fileName, sectorSize }) {
  const audioLike = /\.(wav|flac|ape|mp3|aiff)$/i.test(fileName) || control === 0;
  if (audioLike) {
    return 'AUDIO';
  }

  if (sectorSize === 2048) {
    return 'MODE1/2048';
  }

  if (sectorSize === 2336) {
    return 'MODE2/2336';
  }

  if (sectorSize === 2324) {
    return 'MODE2/2324';
  }

  return 'MODE1/2352';
}

function parseTocText(tocText) {
  const fileReferences = [];
  const trackModes = [];
  const tracks = [];
  let currentTrackMode = null;

  for (const line of tocText.split(/\r?\n/)) {
    const trackMatch = line.match(/^\s*TRACK\s+(\S+)/i);
    if (trackMatch) {
      currentTrackMode = mapTocTrackMode(trackMatch[1]);
      continue;
    }

    const tokens = tokenizeDescriptorLine(line);
    if (tokens[0]?.toUpperCase() !== 'FILE' || tokens.length < 2 || !currentTrackMode) {
      continue;
    }

    const fileName = tokens[1];
    fileReferences.push(fileName);
    trackModes.push(currentTrackMode);
    tracks.push({
      fileName,
      number: tracks.length + 1,
      trackMode: currentTrackMode,
    });
  }

  return {
    fileReferences,
    trackModes,
    tracks,
  };
}

function mapTocTrackMode(rawMode) {
  const upperMode = String(rawMode || '').toUpperCase();
  if (upperMode.includes('AUDIO')) {
    return 'AUDIO';
  }

  if (upperMode.includes('MODE1_RAW')) {
    return 'MODE1/2352';
  }

  if (upperMode.includes('MODE2_RAW')) {
    return 'MODE2/2352';
  }

  if (upperMode.includes('MODE2') && upperMode.includes('2336')) {
    return 'MODE2/2336';
  }

  if (upperMode.includes('MODE2') && upperMode.includes('2324')) {
    return 'MODE2/2324';
  }

  if (upperMode.includes('MODE2')) {
    return 'MODE2/2352';
  }

  if (upperMode.includes('MODE1')) {
    return 'MODE1/2048';
  }

  return 'MODE1/2352';
}

function rankSourceAgainstCueRef(sourceFile, cueReference) {
  const normalizedReference = normalizeCueReference(cueReference);
  const referenceBaseName = normalizeCueReference(path.posix.basename(normalizedReference));
  const referenceWithEcm = normalizedReference.endsWith('.ecm') ? normalizedReference : `${normalizedReference}.ecm`;
  const referenceBaseNameWithEcm = referenceBaseName.endsWith('.ecm') ? referenceBaseName : `${referenceBaseName}.ecm`;

  if (sourceFile.normalizedRelativePath === normalizedReference) {
    return { score: 100, strategy: 'exact_relative_path' };
  }

  if (sourceFile.normalizedRelativePath.endsWith(`/${normalizedReference}`)) {
    return { score: 90, strategy: 'nested_relative_path' };
  }

  if (sourceFile.normalizedName === referenceBaseName) {
    return { score: 80, strategy: 'exact_basename' };
  }

  if (sourceFile.normalizedRelativePath === referenceWithEcm) {
    return { score: 75, strategy: 'exact_relative_path_with_ecm' };
  }

  if (sourceFile.normalizedRelativePath.endsWith(`/${referenceWithEcm}`)) {
    return { score: 70, strategy: 'nested_relative_path_with_ecm' };
  }

  if (sourceFile.normalizedName === referenceBaseNameWithEcm) {
    return { score: 60, strategy: 'exact_basename_with_ecm' };
  }

  if (normalizeKey(sourceFile.displayName) === normalizeKey(referenceBaseName)) {
    return { score: 40, strategy: 'normalized_name_guess' };
  }

  return { score: -1, strategy: 'unmatched' };
}

function describeConfidence(score, strategy) {
  if (strategy === 'fallback_name_match') {
    return 'review';
  }

  if (score >= 90) {
    return 'high';
  }

  if (score >= 60) {
    return 'medium';
  }

  return 'review';
}

function findSourceMatchForCueRef(sourceFiles, cueReference) {
  const rankedMatches = sourceFiles
    .map((sourceFile) => {
      const { score, strategy } = rankSourceAgainstCueRef(sourceFile, cueReference);
      return {
        confidence: describeConfidence(score, strategy),
        cueReference,
        score,
        sourceFile,
        strategy,
      };
    })
    .filter((entry) => entry.score >= 0)
    .sort((left, right) => right.score - left.score || left.sourceFile.relativePath.length - right.sourceFile.relativePath.length);

  return rankedMatches[0] || {
    confidence: 'warning',
    cueReference,
    score: -1,
    sourceFile: null,
    strategy: 'missing',
  };
}

function dedupeByPath(sourceFiles) {
  const seenPaths = new Set();
  return sourceFiles.filter((sourceFile) => {
    if (!sourceFile || seenPaths.has(sourceFile.absolutePath)) {
      return false;
    }

    seenPaths.add(sourceFile.absolutePath);
    return true;
  });
}

function descriptorLabelForType(type) {
  switch (type) {
    case 'cue_sheet':
      return 'Cue sheet';
    case 'gdi_sheet':
      return 'GDI descriptor';
    case 'toc_sheet':
      return 'TOC descriptor';
    case 'clonecd':
      return 'CloneCD descriptor';
    case 'mds_descriptor':
      return 'MDS descriptor';
    case 'disc_container':
      return 'Single-file disc container';
    case 'generated_tracks':
      return 'Generated track set';
    default:
      return 'Standalone image';
  }
}

function buildDescriptorDiagnostic({
  confidence,
  descriptorFile,
  files,
  missingReferences,
  name,
  references,
  type,
  warnings,
}) {
  return {
    confidence,
    cueFile: type === 'cue_sheet' ? descriptorFile : null,
    descriptorFile,
    descriptorLabel: descriptorLabelForType(type),
    files,
    missingReferences,
    name,
    references,
    type,
    warnings,
  };
}

function buildTextDescriptorDiagnostic({
  descriptorFile,
  missingReferences,
  name,
  parsedDescriptor,
  referenceMatches,
  referencedFiles,
  type,
}) {
  const warnings = [];

  if (missingReferences.length > 0) {
    warnings.push(
      missingReferences.length === 1
        ? '1 referenced file is missing from the batch.'
        : `${missingReferences.length} referenced files are missing from the batch.`,
    );
  }

  if (referenceMatches.some((entry) => entry.sourceFile && entry.confidence !== 'high')) {
    warnings.push('One or more file references were matched heuristically and should be reviewed.');
  }

  if (!parsedDescriptor.fileReferences.length) {
    warnings.push('The descriptor does not declare any file entries.');
  }

  return buildDescriptorDiagnostic({
    confidence:
      missingReferences.length > 0
        ? 'warning'
        : referenceMatches.some((entry) => entry.sourceFile && entry.confidence !== 'high')
          ? 'review'
          : 'high',
    descriptorFile: descriptorFile.displayName,
    files: dedupeByPath([descriptorFile, ...referencedFiles]).map((sourceFile) => sourceFile.displayName),
    missingReferences,
    name,
    references: parsedDescriptor.fileReferences.map((cueReference) => {
      const match = referenceMatches.find((entry) => entry.cueReference === cueReference);

      return {
        confidence: match?.confidence || 'warning',
        matchedFile: match?.sourceFile?.displayName || null,
        reference: cueReference,
        score: match?.score ?? -1,
        strategy: match?.strategy || 'missing',
      };
    }),
    type,
    warnings,
  });
}

function buildStructuredDescriptorDiagnostic({
  descriptorFile,
  files,
  missingReferences,
  name,
  references,
  type,
  warnings,
}) {
  const confidence = missingReferences.length > 0 ? 'warning' : warnings.length > 0 ? 'review' : 'high';

  return buildDescriptorDiagnostic({
    confidence,
    descriptorFile: descriptorFile.displayName,
    files: dedupeByPath([descriptorFile, ...files]).map((sourceFile) => sourceFile.displayName),
    missingReferences,
    name,
    references,
    type,
    warnings,
  });
}

function buildStandaloneDiagnostic(imageFile) {
  return {
    confidence: 'high',
    cueFile: null,
    descriptorFile: null,
    descriptorLabel: 'Standalone image',
    files: [imageFile.displayName],
    missingReferences: [],
    name: stripManagedExtension(imageFile.displayName),
    references: [],
    type: 'standalone_image',
    warnings: ['No descriptor file was supplied. A temporary single-track CUE will be generated automatically.'],
  };
}

function buildContainerDiagnostic(containerFile) {
  return buildDescriptorDiagnostic({
    confidence: 'high',
    descriptorFile: containerFile.displayName,
    files: [containerFile.displayName],
    missingReferences: [],
    name: stripManagedExtension(containerFile.displayName),
    references: [],
    type: 'disc_container',
    warnings: ['The container will be sent to chdman directly.'],
  });
}

function buildLooseTrackDiagnostic({ files, name, warnings = [] }) {
  return buildDescriptorDiagnostic({
    confidence: warnings.length ? 'review' : 'high',
    descriptorFile: null,
    files: dedupeByPath(files).map((sourceFile) => sourceFile.displayName),
    missingReferences: [],
    name,
    references: files.map((sourceFile) => ({
      confidence: 'high',
      matchedFile: sourceFile.displayName,
      reference: sourceFile.displayName,
      score: 100,
      strategy: 'track_name_grouping',
    })),
    type: 'generated_tracks',
    warnings: warnings.length ? warnings : ['No descriptor file was supplied. A cue sheet will be generated from the detected track names.'],
  });
}

function assignUniqueOutputNames(groups) {
  const seenNames = new Map();

  return groups.map((group) => {
    const baseName = stripManagedExtension(group.name || 'file');
    const count = seenNames.get(baseName) || 0;
    seenNames.set(baseName, count + 1);
    const outputBaseName = count === 0 ? baseName : `${baseName} (${count + 1})`;

    return {
      ...group,
      diagnostic: {
        ...group.diagnostic,
        name: outputBaseName,
      },
      outputBaseName,
    };
  });
}

function buildTextDescriptorGroup({
  descriptorFile,
  descriptorText,
  parsedDescriptor,
  sourceCandidates,
  usedPaths,
  type,
}) {
  let referenceMatches = parsedDescriptor.fileReferences.map((cueReference) =>
    findSourceMatchForCueRef(sourceCandidates, cueReference),
  );

  if (!referenceMatches.some((entry) => entry.sourceFile) && parsedDescriptor.fileReferences.length === 1) {
    const fallbackImage = sourceCandidates.find(
      (sourceFile) => !usedPaths.has(sourceFile.absolutePath) && sourceFile.matchKey === descriptorFile.matchKey && sourceFile.isImage,
    );

    if (fallbackImage) {
      referenceMatches = [
        {
          confidence: 'review',
          cueReference: parsedDescriptor.fileReferences[0],
          score: 35,
          sourceFile: fallbackImage,
          strategy: 'fallback_name_match',
        },
      ];
    }
  }

  const referencedFiles = dedupeByPath(referenceMatches.map((entry) => entry.sourceFile).filter(Boolean));
  const missingReferences = referenceMatches.filter((entry) => !entry.sourceFile).map((entry) => entry.cueReference);

  usedPaths.add(descriptorFile.absolutePath);
  referencedFiles.forEach((sourceFile) => usedPaths.add(sourceFile.absolutePath));

  return {
    descriptorFile,
    descriptorText,
    descriptorType: type,
    diagnostic: buildTextDescriptorDiagnostic({
      descriptorFile,
      missingReferences,
      name: stripManagedExtension(descriptorFile.displayName),
      parsedDescriptor,
      referenceMatches,
      referencedFiles,
      type,
    }),
    missingReferences,
    name: stripManagedExtension(descriptorFile.displayName),
    parsedDescriptor,
    referenceMatches,
    referencedFiles,
    sourceFiles: dedupeByPath([descriptorFile, ...referencedFiles]),
    standalone: false,
    strategy: 'generated_cue',
    suggestedOutputProfile: 'cd',
    supportedOutputProfiles: ['cd'],
  };
}

function buildCloneDescriptorGroup({ classifiedFiles, descriptorFile, requiredExtensions, type, usedPaths, warnings = [] }) {
  const files = [];
  const missingReferences = [];
  const references = [];

  usedPaths.add(descriptorFile.absolutePath);

  for (const requirement of requiredExtensions) {
    const sourceFile = classifiedFiles.find(
      (candidate) =>
        !usedPaths.has(candidate.absolutePath) &&
        candidate.matchKey === descriptorFile.matchKey &&
        candidate.displayName.toLowerCase().endsWith(requirement.extension),
    );

    if (sourceFile) {
      files.push(sourceFile);
      usedPaths.add(sourceFile.absolutePath);
    } else if (requirement.required) {
      missingReferences.push(`${stripManagedExtension(descriptorFile.displayName)}${requirement.extension}`);
    } else if (requirement.warning) {
      warnings.push(requirement.warning);
    }

    references.push({
      confidence: sourceFile ? 'high' : requirement.required ? 'warning' : 'review',
      matchedFile: sourceFile?.displayName || null,
      reference: `${stripManagedExtension(descriptorFile.displayName)}${requirement.extension}`,
      score: sourceFile ? 100 : -1,
      strategy: sourceFile ? 'match_key_asset' : 'missing',
    });
  }

  return {
    descriptorFile,
    descriptorText: null,
    descriptorType: type,
    diagnostic: buildStructuredDescriptorDiagnostic({
      descriptorFile,
      files,
      missingReferences,
      name: stripManagedExtension(descriptorFile.displayName),
      references,
      type,
      warnings,
    }),
    missingReferences,
    name: stripManagedExtension(descriptorFile.displayName),
    parsedDescriptor: null,
    referenceMatches: references.map((reference) => ({
      confidence: reference.confidence,
      cueReference: reference.reference,
      score: reference.score,
      sourceFile: files.find((sourceFile) => sourceFile.displayName === reference.matchedFile) || null,
      strategy: reference.strategy,
    })),
    referencedFiles: files,
    sourceFiles: dedupeByPath([descriptorFile, ...files]),
    standalone: false,
    strategy: 'direct_descriptor',
    suggestedOutputProfile: 'cd',
    supportedOutputProfiles: ['cd'],
  };
}

function buildContainerGroup(containerFile, usedPaths) {
  usedPaths.add(containerFile.absolutePath);

  return {
    descriptorFile: containerFile,
    descriptorText: null,
    descriptorType: 'container',
    diagnostic: buildContainerDiagnostic(containerFile),
    missingReferences: [],
    name: stripManagedExtension(containerFile.displayName),
    parsedDescriptor: null,
    referenceMatches: [],
    referencedFiles: [],
    sourceFiles: [containerFile],
    standalone: false,
    strategy: 'direct_descriptor',
    suggestedOutputProfile: 'cd',
    supportedOutputProfiles: ['cd'],
  };
}

function buildLooseTrackGroup(sourceFiles, usedPaths) {
  const candidateFiles = sourceFiles
    .filter((sourceFile) => !usedPaths.has(sourceFile.absolutePath))
    .filter((sourceFile) => sourceFile.isImage || sourceFile.isAudioAsset)
    .filter((sourceFile) => Number.isFinite(sourceFile.trackNumber))
    .sort((left, right) => left.trackNumber - right.trackNumber || left.displayName.localeCompare(right.displayName));

  const groupsByKey = new Map();
  for (const sourceFile of candidateFiles) {
    const key = sourceFile.looseTrackKey;
    if (!key) {
      continue;
    }

    const group = groupsByKey.get(key) || [];
    group.push(sourceFile);
    groupsByKey.set(key, group);
  }

  const groups = [];
  for (const files of groupsByKey.values()) {
    const hasDataTrack = files.some((sourceFile) => sourceFile.isImage);
    const hasMultipleTracks = files.length > 1;

    if (!hasDataTrack || !hasMultipleTracks) {
      continue;
    }

    files.forEach((sourceFile) => usedPaths.add(sourceFile.absolutePath));
    const outputName = stripTrackSuffix(files[0].displayName);
    const warnings = files.some((sourceFile) => sourceFile.isAudioAsset)
      ? ['Audio tracks will be converted to WAV automatically before CHD creation.']
      : [];

    groups.push({
      descriptorFile: null,
      descriptorText: null,
      descriptorType: 'generated_tracks',
      diagnostic: buildLooseTrackDiagnostic({
        files,
        name: outputName,
        warnings,
      }),
      missingReferences: [],
      name: outputName,
      parsedDescriptor: {
        fileReferences: files.map((sourceFile) => sourceFile.displayName),
        trackModes: files.map((sourceFile) => (sourceFile.isAudioAsset ? 'AUDIO' : null)),
        tracks: files.map((sourceFile, index) => ({
          fileName: sourceFile.displayName,
          number: sourceFile.trackNumber || index + 1,
          trackMode: sourceFile.isAudioAsset ? 'AUDIO' : null,
        })),
      },
      referenceMatches: files.map((sourceFile) => ({
        confidence: 'high',
        cueReference: sourceFile.displayName,
        score: 100,
        sourceFile,
        strategy: 'track_name_grouping',
      })),
      referencedFiles: files,
      sourceFiles: files,
      standalone: false,
      strategy: 'generated_cue',
      suggestedOutputProfile: 'cd',
      supportedOutputProfiles: ['cd'],
    });
  }

  return groups;
}

function buildDiscGroups(sourceFiles) {
  const classifiedFiles = sourceFiles.map(classifySourceFile);
  const usedPaths = new Set();
  const groups = [];

  const cueFiles = classifiedFiles.filter((sourceFile) => sourceFile.kind === 'cue');
  const gdiFiles = classifiedFiles.filter((sourceFile) => sourceFile.kind === 'gdi');
  const tocFiles = classifiedFiles.filter((sourceFile) => sourceFile.kind === 'toc');
  const ccdFiles = classifiedFiles.filter((sourceFile) => sourceFile.kind === 'ccd');
  const mdsFiles = classifiedFiles.filter((sourceFile) => sourceFile.kind === 'mds');
  const containerFiles = classifiedFiles.filter((sourceFile) => ['cdi', 'nrg'].includes(sourceFile.kind));
  const imageFiles = classifiedFiles.filter((sourceFile) => sourceFile.kind === 'image');
  const sourceCandidates = classifiedFiles.filter((sourceFile) => !sourceFile.isDescriptor);

  for (const cueFile of cueFiles) {
    const cueText = fs.readFileSync(cueFile.absolutePath, 'utf8');
    groups.push(
      buildTextDescriptorGroup({
        descriptorFile: cueFile,
        descriptorText: cueText,
        parsedDescriptor: parseCueText(cueText),
        sourceCandidates,
        type: 'cue_sheet',
        usedPaths,
      }),
    );
  }

  for (const gdiFile of gdiFiles) {
    const gdiText = fs.readFileSync(gdiFile.absolutePath, 'utf8');
    groups.push(
      buildTextDescriptorGroup({
        descriptorFile: gdiFile,
        descriptorText: gdiText,
        parsedDescriptor: parseGdiText(gdiText),
        sourceCandidates,
        type: 'gdi_sheet',
        usedPaths,
      }),
    );
  }

  for (const tocFile of tocFiles) {
    const tocText = fs.readFileSync(tocFile.absolutePath, 'utf8');
    groups.push(
      buildTextDescriptorGroup({
        descriptorFile: tocFile,
        descriptorText: tocText,
        parsedDescriptor: parseTocText(tocText),
        sourceCandidates,
        type: 'toc_sheet',
        usedPaths,
      }),
    );
  }

  for (const ccdFile of ccdFiles) {
    groups.push(
      buildCloneDescriptorGroup({
        classifiedFiles,
        descriptorFile: ccdFile,
        requiredExtensions: [
          { extension: '.img', required: true },
          { extension: '.sub', required: false, warning: 'No SUB file was supplied. Subchannel data cannot be preserved.' },
        ],
        type: 'clonecd',
        usedPaths,
      }),
    );
  }

  for (const mdsFile of mdsFiles) {
    groups.push(
      buildCloneDescriptorGroup({
        classifiedFiles,
        descriptorFile: mdsFile,
        requiredExtensions: [{ extension: '.mdf', required: true }],
        type: 'mds_descriptor',
        usedPaths,
      }),
    );
  }

  for (const containerFile of containerFiles) {
    groups.push(buildContainerGroup(containerFile, usedPaths));
  }

  groups.push(...buildLooseTrackGroup(classifiedFiles, usedPaths));

  for (const imageFile of imageFiles) {
    if (usedPaths.has(imageFile.absolutePath)) {
      continue;
    }

    usedPaths.add(imageFile.absolutePath);
    groups.push({
      descriptorFile: null,
      descriptorText: null,
      descriptorType: 'standalone_image',
      diagnostic: buildStandaloneDiagnostic(imageFile),
      missingReferences: [],
      name: stripManagedExtension(imageFile.displayName),
      parsedDescriptor: null,
      referenceMatches: [],
      referencedFiles: [imageFile],
      sourceFiles: [imageFile],
      standalone: true,
      strategy: 'generated_cue',
      suggestedOutputProfile: imageFile.imageExtension === 'iso' ? null : 'cd',
      supportedOutputProfiles: imageFile.imageExtension === 'iso' ? ['cd', 'dvd'] : ['cd'],
    });
  }

  return assignUniqueOutputNames(groups);
}

function toCuePath(targetPath) {
  return targetPath.split(path.sep).join('/');
}

function rewriteCueText(cueText, fileMappings, cueOutputDirectory, options = {}) {
  let trackModeWasRewritten = false;

  return cueText
    .split(/\r?\n/)
    .map((line) => {
      const fileLine = parseCueFileLine(line);
      if (fileLine) {
        const mappedPath = fileMappings.get(normalizeCueReference(fileLine.fileName));
        if (!mappedPath) {
          return line;
        }

        const relativePath = toCuePath(path.relative(cueOutputDirectory, mappedPath));
        const overrideFileType = options.fileTypeResolver?.(fileLine.fileName, mappedPath);
        const suffix = overrideFileType ? fileLine.suffix.replace(/\s+\S+(\s.*)?$/i, ` ${overrideFileType}$1`) : fileLine.suffix;
        return `${fileLine.prefix}"${relativePath}"${suffix}`;
      }

      if (options.singleTrackMode && !trackModeWasRewritten) {
        const trackMatch = line.match(/^(\s*TRACK\s+\d+\s+)(\S+)(.*)$/i);
        if (trackMatch) {
          trackModeWasRewritten = true;
          return `${trackMatch[1]}${options.singleTrackMode}${trackMatch[3]}`;
        }
      }

      return line;
    })
    .join('\n');
}

async function detectTrackMode(filePath) {
  const fileStats = await fs.promises.stat(filePath);
  const fileHandle = await fs.promises.open(filePath, 'r');
  const header = Buffer.alloc(16);

  try {
    await fileHandle.read(header, 0, 16, 0);
  } finally {
    await fileHandle.close();
  }

  const isRaw2352 =
    header[0] === 0x00 &&
    header[11] === 0x00 &&
    header.subarray(1, 11).every((value) => value === 0xff);

  if (fileStats.size % 2352 === 0) {
    if (isRaw2352 && header[15] === 0x01) {
      return 'MODE1/2352';
    }

    if (isRaw2352 && header[15] === 0x02) {
      return 'MODE2/2352';
    }

    return 'MODE2/2352';
  }

  if (fileStats.size % 2336 === 0) {
    return 'MODE2/2336';
  }

  if (fileStats.size % 2324 === 0) {
    return 'MODE2/2324';
  }

  if (fileStats.size % 2048 === 0) {
    return 'MODE1/2048';
  }

  return 'MODE2/2352';
}

module.exports = {
  buildDiscGroups,
  classifySourceFile,
  detectTrackMode,
  normalizeCueReference,
  parseCueText,
  parseGdiText,
  parseTocText,
  rewriteCueText,
  stripManagedExtension,
  toCuePath,
};
