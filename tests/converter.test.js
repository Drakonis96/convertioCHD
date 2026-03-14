const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const archiver = require('archiver');
const ffmpegStatic = require('ffmpeg-static');
const { path7z } = require('7zip-bin-full');

const { processConversionBatch, resolveGroupOutputProfile, runWithConcurrency } = require('../src/lib/converter');
const { buildDiscGroups } = require('../src/lib/disc');
const { updateEdc } = require('../src/lib/ecm');

const execFileAsync = promisify(execFile);

function encodeChunkHeader(type, count) {
  let value = count - 1;
  const bytes = [];
  let firstByte = ((value & 0x1f) << 2) | type;
  value >>>= 5;

  if (value > 0) {
    firstByte |= 0x80;
  }

  bytes.push(firstByte);

  while (value > 0) {
    let nextByte = value & 0x7f;
    value >>>= 7;
    if (value > 0) {
      nextByte |= 0x80;
    }
    bytes.push(nextByte);
  }

  return Buffer.from(bytes);
}

function encodeRawControlValue(type, rawValue) {
  let value = rawValue >>> 0;
  const bytes = [];
  let firstByte = ((value & 0x1f) << 2) | type;
  value >>>= 5;

  if (value > 0) {
    firstByte |= 0x80;
  }

  bytes.push(firstByte);

  while (value > 0) {
    let nextByte = value & 0x7f;
    value >>>= 7;
    if (value > 0) {
      nextByte |= 0x80;
    }
    bytes.push(nextByte);
  }

  return Buffer.from(bytes);
}

async function createZipArchive(destinationPath, filePath, fileName) {
  await new Promise((resolve, reject) => {
    const output = require('node:fs').createWriteStream(destinationPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.file(filePath, { name: fileName });
    archive.finalize();
  });
}

async function create7zArchive(destinationPath, filePaths, cwd) {
  await execFileAsync(path7z, ['a', destinationPath, ...filePaths], {
    cwd,
  });
}

async function createFlacFile(destinationPath) {
  const sourceWavPath = `${destinationPath}.source.wav`;
  await execFileAsync(ffmpegStatic, [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=44100:cl=stereo',
    '-t',
    '1',
    sourceWavPath,
  ]);
  await execFileAsync(ffmpegStatic, ['-y', '-i', sourceWavPath, destinationPath]);
  await fs.rm(sourceWavPath, { force: true });
}

async function createRawEcmFile(destinationPath, payload) {
  const checksum = updateEdc(0, payload);
  const ecmBuffer = Buffer.concat([
    Buffer.from('ECM\0', 'binary'),
    encodeChunkHeader(0, payload.length),
    payload,
    encodeRawControlValue(0, 0xffffffff),
    Buffer.from([
      checksum & 0xff,
      (checksum >>> 8) & 0xff,
      (checksum >>> 16) & 0xff,
      (checksum >>> 24) & 0xff,
    ]),
  ]);

  await fs.writeFile(destinationPath, ecmBuffer);
}

describe('conversion concurrency', () => {
  test('does not exceed the configured worker count', async () => {
    const workItems = [1, 2, 3, 4, 5, 6];
    let activeWorkers = 0;
    let peakWorkers = 0;

    await runWithConcurrency(workItems, 2, async () => {
      activeWorkers += 1;
      peakWorkers = Math.max(peakWorkers, activeWorkers);
      await new Promise((resolve) => setTimeout(resolve, 15));
      activeWorkers -= 1;
    });

    expect(peakWorkers).toBeLessThanOrEqual(2);
  });
});

describe('real conversion pipeline', () => {
  test('converts a standalone ISO into a CHD', async () => {
    const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'convertiochd-convert-'));
    const isoPath = path.join(rootDirectory, 'Sample.iso');
    await fs.writeFile(isoPath, Buffer.alloc(2048, 0));

    const summary = await processConversionBatch({
      inputFiles: [
        {
          absolutePath: isoPath,
          originalName: 'Sample.iso',
        },
      ],
      jobDirectory: path.join(rootDirectory, 'job'),
      jobId: 'single-iso',
    });

    expect(summary.convertedFiles).toHaveLength(1);
    expect(summary.archiveFile).toBeNull();
    expect(summary.groupDiagnostics).toHaveLength(1);
    expect(summary.groupDiagnostics[0].type).toBe('standalone_image');
    await expect(fs.stat(summary.convertedFiles[0].absolutePath)).resolves.toBeTruthy();
  });

  test('extracts a zip and converts its ISO payload', async () => {
    const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'convertiochd-archive-'));
    const isoPath = path.join(rootDirectory, 'Inside.iso');
    const zipPath = path.join(rootDirectory, 'inside.zip');
    await fs.writeFile(isoPath, Buffer.alloc(2048, 1));
    await createZipArchive(zipPath, isoPath, 'Inside.iso');

    const summary = await processConversionBatch({
      inputFiles: [
        {
          absolutePath: zipPath,
          originalName: 'inside.zip',
        },
      ],
      jobDirectory: path.join(rootDirectory, 'job'),
      jobId: 'zip-iso',
    });

    expect(summary.convertedFiles).toHaveLength(1);
    expect(summary.expandedBytes).toBe(2048);
    expect(summary.expandedFiles).toBe(1);
    expect(summary.groupDiagnostics[0].files).toContain('Inside.iso');
  });

  test('extracts nested archives before converting the payload', async () => {
    const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'convertiochd-nested-archive-'));
    const isoPath = path.join(rootDirectory, 'Nested.iso');
    const sevenZipPath = path.join(rootDirectory, 'nested.7z');
    const outerZipPath = path.join(rootDirectory, 'outer.zip');

    await fs.writeFile(isoPath, Buffer.alloc(2048, 4));
    await create7zArchive(sevenZipPath, ['Nested.iso'], rootDirectory);
    await createZipArchive(outerZipPath, sevenZipPath, 'Nested.iso.7z');

    const summary = await processConversionBatch({
      inputFiles: [
        {
          absolutePath: outerZipPath,
          originalName: 'outer.zip',
        },
      ],
      jobDirectory: path.join(rootDirectory, 'job'),
      jobId: 'nested-archive',
    });

    expect(summary.convertedFiles).toHaveLength(1);
    expect(summary.groupDiagnostics[0].files.some((fileName) => fileName.endsWith('.iso'))).toBe(true);
  });

  test('builds a CHD from loose track files without a cue sheet', async () => {
    const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'convertiochd-loose-track-convert-'));
    const track1Path = path.join(rootDirectory, 'MediEvil (Track 1).bin.ecm');
    const track2Path = path.join(rootDirectory, 'MediEvil (Track 2).flac');

    await createRawEcmFile(track1Path, Buffer.alloc(2048, 0));
    await createFlacFile(track2Path);

    const summary = await processConversionBatch({
      inputFiles: [
        {
          absolutePath: track1Path,
          originalName: 'MediEvil (Track 1).bin.ecm',
        },
        {
          absolutePath: track2Path,
          originalName: 'MediEvil (Track 2).flac',
        },
      ],
      jobDirectory: path.join(rootDirectory, 'job'),
      jobId: 'loose-track-batch',
    });

    expect(summary.convertedFiles).toHaveLength(1);
    expect(summary.groupDiagnostics[0].type).toBe('generated_tracks');
  });

  test('converts a minimal GDI set into a CHD', async () => {
    const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'convertiochd-gdi-convert-'));
    const gdiPath = path.join(rootDirectory, 'Game.gdi');
    const trackPath = path.join(rootDirectory, 'track01.bin');
    await fs.writeFile(trackPath, Buffer.alloc(2352, 0));
    await fs.writeFile(gdiPath, '1\n1 0 4 2352 track01.bin 0\n');

    const summary = await processConversionBatch({
      inputFiles: [
        {
          absolutePath: gdiPath,
          originalName: 'Game.gdi',
        },
        {
          absolutePath: trackPath,
          originalName: 'track01.bin',
        },
      ],
      jobDirectory: path.join(rootDirectory, 'job'),
      jobId: 'gdi-batch',
    });

    expect(summary.convertedFiles).toHaveLength(1);
    expect(summary.groupDiagnostics[0].type).toBe('gdi_sheet');
  });

  test('converts a minimal TOC set into a CHD', async () => {
    const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'convertiochd-toc-convert-'));
    const tocPath = path.join(rootDirectory, 'Game.toc');
    const trackPath = path.join(rootDirectory, 'track01.bin');
    await fs.writeFile(trackPath, Buffer.alloc(2352, 0));
    await fs.writeFile(tocPath, 'CD_ROM\nTRACK MODE1_RAW\nFILE "track01.bin" 0\n');

    const summary = await processConversionBatch({
      inputFiles: [
        {
          absolutePath: tocPath,
          originalName: 'Game.toc',
        },
        {
          absolutePath: trackPath,
          originalName: 'track01.bin',
        },
      ],
      jobDirectory: path.join(rootDirectory, 'job'),
      jobId: 'toc-batch',
    });

    expect(summary.convertedFiles).toHaveLength(1);
    expect(summary.groupDiagnostics[0].type).toBe('toc_sheet');
  });

  test('uses the requested concurrency and creates a bundle for multiple outputs', async () => {
    const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'convertiochd-parallel-'));
    const firstIsoPath = path.join(rootDirectory, 'A.iso');
    const secondIsoPath = path.join(rootDirectory, 'B.iso');
    await fs.writeFile(firstIsoPath, Buffer.alloc(2048, 2));
    await fs.writeFile(secondIsoPath, Buffer.alloc(2048, 3));

    const summary = await processConversionBatch({
      conversionConcurrency: 2,
      inputFiles: [
        {
          absolutePath: firstIsoPath,
          originalName: 'A.iso',
        },
        {
          absolutePath: secondIsoPath,
          originalName: 'B.iso',
        },
      ],
      jobDirectory: path.join(rootDirectory, 'job'),
      jobId: 'parallel-batch',
    });

    expect(summary.convertedFiles).toHaveLength(2);
    expect(summary.archiveFile).toBeTruthy();
    expect(summary.conversionConcurrency).toBe(2);
    await expect(fs.stat(summary.archiveFile.absolutePath)).resolves.toBeTruthy();
  });

  test('resolves automatic and manual output profiles correctly', async () => {
    const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'convertiochd-profile-'));
    const isoPath = path.join(rootDirectory, 'Disc.iso');
    const cuePath = path.join(rootDirectory, 'Disc.cue');
    const binPath = path.join(rootDirectory, 'Disc.bin');

    await fs.writeFile(isoPath, Buffer.alloc(2048, 0));
    await fs.writeFile(cuePath, 'FILE "Disc.bin" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n');
    await fs.writeFile(binPath, Buffer.alloc(2352, 0));

    const [isoGroup] = buildDiscGroups([
      {
        absolutePath: isoPath,
        displayName: 'Disc.iso',
        relativePath: 'Disc.iso',
      },
    ]);
    const [cueGroup] = buildDiscGroups([
      {
        absolutePath: cuePath,
        displayName: 'Disc.cue',
        relativePath: 'Disc.cue',
      },
      {
        absolutePath: binPath,
        displayName: 'Disc.bin',
        relativePath: 'Disc.bin',
      },
    ]);

    await expect(
      resolveGroupOutputProfile(isoGroup, {
        manualOutputProfile: 'dvd',
        selectionMode: 'manual',
      }),
    ).resolves.toMatchObject({ id: 'dvd' });

    await expect(
      resolveGroupOutputProfile(isoGroup, {
        consoleId: 'ps2',
        selectionMode: 'automatic',
      }),
    ).resolves.toMatchObject({ id: 'dvd' });

    await expect(
      resolveGroupOutputProfile(cueGroup, {
        manualOutputProfile: 'dvd',
        selectionMode: 'manual',
      }),
    ).rejects.toThrow(/cannot be converted as DVD CHD/i);
  });
});
