const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { buildDiscGroups, detectTrackMode, rewriteCueText } = require('../src/lib/disc');
const { decodeEcmFile, updateEdc } = require('../src/lib/ecm');

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

describe('disc grouping', () => {
  test('groups cue and bin.ecm together when the cue references the bin name', async () => {
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'convertiochd-group-'));
    const cuePath = path.join(tempDirectory, 'Resident Evil.cue');
    const binPath = path.join(tempDirectory, 'Resident Evil.bin.ecm');

    await fs.writeFile(cuePath, 'FILE "Resident Evil.bin" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n');
    await fs.writeFile(binPath, 'dummy');

    const groups = buildDiscGroups([
      {
        absolutePath: cuePath,
        displayName: 'Resident Evil.cue',
        relativePath: 'Resident Evil.cue',
      },
      {
        absolutePath: binPath,
        displayName: 'Resident Evil.bin.ecm',
        relativePath: 'Resident Evil.bin.ecm',
      },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].referencedFiles).toHaveLength(1);
    expect(groups[0].referencedFiles[0].displayName).toBe('Resident Evil.bin.ecm');
    expect(groups[0].diagnostic.confidence).toBe('review');
    expect(groups[0].diagnostic.references[0].matchedFile).toBe('Resident Evil.bin.ecm');
  });

  test('rewrites cue paths to generated relative targets', () => {
    const cueText = 'FILE "Game.bin" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n';
    const output = rewriteCueText(
      cueText,
      new Map([['game.bin', '/tmp/work/decoded/Game.bin']]),
      '/tmp/work',
      { singleTrackMode: 'MODE2/2336' },
    );

    expect(output).toContain('FILE "decoded/Game.bin" BINARY');
    expect(output).toContain('TRACK 01 MODE2/2336');
  });

  test('captures missing references in the diagnostic payload', async () => {
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'convertiochd-diagnostic-'));
    const cuePath = path.join(tempDirectory, 'Game.cue');
    const binPath = path.join(tempDirectory, 'Game Track 01.bin');

    await fs.writeFile(
      cuePath,
      'FILE "Game Track 01.bin" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\nFILE "Game Track 02.bin" BINARY\n  TRACK 02 AUDIO\n    INDEX 01 00:00:00\n',
    );
    await fs.writeFile(binPath, 'dummy');

    const groups = buildDiscGroups([
      {
        absolutePath: cuePath,
        displayName: 'Game.cue',
        relativePath: 'Game.cue',
      },
      {
        absolutePath: binPath,
        displayName: 'Game Track 01.bin',
        relativePath: 'Game Track 01.bin',
      },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].missingReferences).toEqual(['Game Track 02.bin']);
    expect(groups[0].diagnostic.confidence).toBe('warning');
    expect(groups[0].diagnostic.missingReferences).toEqual(['Game Track 02.bin']);
    expect(groups[0].diagnostic.warnings[0]).toContain('missing');
  });

  test('groups GDI descriptors with their referenced track files', async () => {
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'convertiochd-gdi-'));
    const gdiPath = path.join(tempDirectory, 'Dreamcast.gdi');
    const trackPath = path.join(tempDirectory, 'track01.bin');

    await fs.writeFile(gdiPath, '1\n1 0 4 2352 track01.bin 0\n');
    await fs.writeFile(trackPath, Buffer.alloc(2352, 0));

    const groups = buildDiscGroups([
      {
        absolutePath: gdiPath,
        displayName: 'Dreamcast.gdi',
        relativePath: 'Dreamcast.gdi',
      },
      {
        absolutePath: trackPath,
        displayName: 'track01.bin',
        relativePath: 'track01.bin',
      },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].diagnostic.type).toBe('gdi_sheet');
    expect(groups[0].diagnostic.descriptorLabel).toContain('GDI');
    expect(groups[0].diagnostic.files).toEqual(['Dreamcast.gdi', 'track01.bin']);
  });

  test('groups TOC descriptors with their referenced track files', async () => {
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'convertiochd-toc-'));
    const tocPath = path.join(tempDirectory, 'Game.toc');
    const trackPath = path.join(tempDirectory, 'track01.bin');

    await fs.writeFile(tocPath, 'CD_ROM\nTRACK MODE1_RAW\nFILE "track01.bin" 0\n');
    await fs.writeFile(trackPath, Buffer.alloc(2352, 0));

    const groups = buildDiscGroups([
      {
        absolutePath: tocPath,
        displayName: 'Game.toc',
        relativePath: 'Game.toc',
      },
      {
        absolutePath: trackPath,
        displayName: 'track01.bin',
        relativePath: 'track01.bin',
      },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].diagnostic.type).toBe('toc_sheet');
    expect(groups[0].diagnostic.references[0].matchedFile).toBe('track01.bin');
  });

  test('groups CloneCD, MDS, CDI, and NRG inputs without user intervention', async () => {
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'convertiochd-direct-'));
    const fixtureNames = ['Alpha.ccd', 'Alpha.img', 'Alpha.sub', 'Beta.mds', 'Beta.mdf', 'Gamma.cdi', 'Delta.nrg'];

    await Promise.all(
      fixtureNames.map((fileName) => fs.writeFile(path.join(tempDirectory, fileName), Buffer.from('fixture'))),
    );

    const groups = buildDiscGroups(
      fixtureNames.map((fileName) => ({
        absolutePath: path.join(tempDirectory, fileName),
        displayName: fileName,
        relativePath: fileName,
      })),
    );

    expect(groups.map((group) => group.diagnostic.type)).toEqual([
      'clonecd',
      'mds_descriptor',
      'disc_container',
      'disc_container',
    ]);
    expect(groups[0].strategy).toBe('direct_descriptor');
    expect(groups[1].strategy).toBe('direct_descriptor');
    expect(groups[2].diagnostic.files).toEqual(['Gamma.cdi']);
    expect(groups[3].diagnostic.files).toEqual(['Delta.nrg']);
  });

  test('groups loose track files without a cue when track numbers are present in the names', async () => {
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'convertiochd-loose-tracks-'));
    const track1Path = path.join(tempDirectory, 'MediEvil (Track 1).bin.ecm');
    const track2Path = path.join(tempDirectory, 'MediEvil (Track 2).ape');

    await fs.writeFile(track1Path, 'dummy');
    await fs.writeFile(track2Path, 'dummy');

    const groups = buildDiscGroups([
      {
        absolutePath: track1Path,
        displayName: 'MediEvil (Track 1).bin.ecm',
        relativePath: 'MediEvil (Track 1).bin.ecm',
      },
      {
        absolutePath: track2Path,
        displayName: 'MediEvil (Track 2).ape',
        relativePath: 'MediEvil (Track 2).ape',
      },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].diagnostic.type).toBe('generated_tracks');
    expect(groups[0].referencedFiles).toHaveLength(2);
    expect(groups[0].parsedDescriptor.tracks.map((track) => track.number)).toEqual([1, 2]);
  });
});

describe('track mode detection', () => {
  test('detects MODE1/2352 from a raw sector header', async () => {
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'convertiochd-mode-'));
    const imagePath = path.join(tempDirectory, 'mode1.bin');
    const sector = Buffer.alloc(2352, 0);

    sector[0] = 0x00;
    sector.fill(0xff, 1, 11);
    sector[11] = 0x00;
    sector[15] = 0x01;

    await fs.writeFile(imagePath, sector);

    await expect(detectTrackMode(imagePath)).resolves.toBe('MODE1/2352');
  });

  test('detects MODE1/2048 from file size when there is no raw sync header', async () => {
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'convertiochd-mode-'));
    const imagePath = path.join(tempDirectory, 'mode1.iso');

    await fs.writeFile(imagePath, Buffer.alloc(2048, 0));

    await expect(detectTrackMode(imagePath)).resolves.toBe('MODE1/2048');
  });
});

describe('ecm decoding', () => {
  test('decodes a minimal ECM stream containing only raw bytes', async () => {
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'convertiochd-ecm-'));
    const ecmPath = path.join(tempDirectory, 'sample.bin.ecm');
    const outputPath = path.join(tempDirectory, 'sample.bin');
    const payload = Buffer.from('HELLO CHD');
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

    await fs.writeFile(ecmPath, ecmBuffer);

    await decodeEcmFile(ecmPath, outputPath);
    await expect(fs.readFile(outputPath)).resolves.toEqual(payload);
  });
});
