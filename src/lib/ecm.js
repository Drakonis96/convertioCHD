const fs = require('node:fs');

const { throwIfAborted } = require('./cancellation');

const ECC_FORWARD_LUT = new Uint8Array(256);
const ECC_BACKWARD_LUT = new Uint8Array(256);
const EDC_LUT = new Uint32Array(256);

let lutReady = false;

function initLuts() {
  if (lutReady) {
    return;
  }

  for (let index = 0; index < 256; index += 1) {
    const doubled = (index << 1) ^ (index & 0x80 ? 0x11d : 0);
    ECC_FORWARD_LUT[index] = doubled;
    ECC_BACKWARD_LUT[index ^ doubled] = index;

    let edc = index;
    for (let bit = 0; bit < 8; bit += 1) {
      edc = ((edc >>> 1) ^ (edc & 1 ? 0xd8018001 : 0)) >>> 0;
    }
    EDC_LUT[index] = edc >>> 0;
  }

  lutReady = true;
}

function updateEdc(checksum, buffer, offset = 0, length = buffer.length - offset) {
  initLuts();

  let edc = checksum >>> 0;
  const end = offset + length;

  for (let index = offset; index < end; index += 1) {
    edc = ((edc >>> 8) ^ EDC_LUT[(edc ^ buffer[index]) & 0xff]) >>> 0;
  }

  return edc >>> 0;
}

function writeEdc(buffer, offset, checksum) {
  buffer[offset + 0] = checksum & 0xff;
  buffer[offset + 1] = (checksum >>> 8) & 0xff;
  buffer[offset + 2] = (checksum >>> 16) & 0xff;
  buffer[offset + 3] = (checksum >>> 24) & 0xff;
}

function computeEccBlock(sector, majorCount, minorCount, majorMultiplier, minorIncrement, destinationOffset) {
  const size = majorCount * minorCount;

  for (let major = 0; major < majorCount; major += 1) {
    let index = ((major >>> 1) * majorMultiplier) + (major & 1);
    let eccA = 0;
    let eccB = 0;

    for (let minor = 0; minor < minorCount; minor += 1) {
      const value = sector[0x0c + index];
      index += minorIncrement;
      if (index >= size) {
        index -= size;
      }

      eccA ^= value;
      eccB ^= value;
      eccA = ECC_FORWARD_LUT[eccA];
    }

    eccA = ECC_BACKWARD_LUT[ECC_FORWARD_LUT[eccA] ^ eccB];
    sector[destinationOffset + major] = eccA;
    sector[destinationOffset + major + majorCount] = eccA ^ eccB;
  }
}

function eccGenerate(sector, zeroAddress) {
  const savedAddress = Buffer.allocUnsafe(4);

  if (zeroAddress) {
    sector.copy(savedAddress, 0, 12, 16);
    sector.fill(0, 12, 16);
  }

  computeEccBlock(sector, 86, 24, 2, 86, 0x81c);
  computeEccBlock(sector, 52, 43, 86, 88, 0x8c8);

  if (zeroAddress) {
    savedAddress.copy(sector, 12);
  }
}

function eccEdcGenerate(sector, type) {
  switch (type) {
    case 1:
      writeEdc(sector, 0x810, updateEdc(0, sector, 0x000, 0x810));
      sector.fill(0, 0x814, 0x81c);
      eccGenerate(sector, false);
      break;
    case 2:
      writeEdc(sector, 0x818, updateEdc(0, sector, 0x010, 0x808));
      eccGenerate(sector, true);
      break;
    case 3:
      writeEdc(sector, 0x92c, updateEdc(0, sector, 0x010, 0x91c));
      break;
    default:
      throw new Error(`Unsupported ECC/EDC type: ${type}`);
  }
}

function createReader(fileDescriptor) {
  const oneByte = Buffer.allocUnsafe(1);
  let position = 0;

  function readByte() {
    const bytesRead = fs.readSync(fileDescriptor, oneByte, 0, 1, position);
    if (bytesRead === 0) {
      return -1;
    }

    position += 1;
    return oneByte[0];
  }

  function readExact(length) {
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = fs.readSync(fileDescriptor, buffer, 0, length, position);

    if (bytesRead !== length) {
      const error = new Error('Unexpected EOF!');
      error.code = 'ECM_UNEXPECTED_EOF';
      throw error;
    }

    position += bytesRead;
    return buffer;
  }

  return {
    get position() {
      return position;
    },
    readByte,
    readExact,
  };
}

function createProgressEmitter(totalBytes, onProgress) {
  let lastProgress = -1;

  return (currentBytes) => {
    if (!onProgress || totalBytes <= 0) {
      return;
    }

    const progress = Math.max(1, Math.min(99, Math.floor((currentBytes / totalBytes) * 100)));
    if (progress !== lastProgress) {
      lastProgress = progress;
      onProgress(progress);
    }
  };
}

async function decodeEcmFile(inputPath, outputPath, options = {}) {
  initLuts();
  throwIfAborted(options.signal);

  const totalBytes = fs.statSync(inputPath).size;
  const emitProgress = createProgressEmitter(totalBytes, options.onProgress);
  const inputDescriptor = fs.openSync(inputPath, 'r');
  const outputDescriptor = fs.openSync(outputPath, 'w');
  const sector = Buffer.alloc(2352);

  let checkedc = 0;
  let outputBytes = 0;

  try {
    const reader = createReader(inputDescriptor);
    const signature = reader.readExact(4);

    if (signature[0] !== 0x45 || signature[1] !== 0x43 || signature[2] !== 0x4d || signature[3] !== 0x00) {
      const error = new Error('Corrupt ECM file!');
      error.code = 'ECM_CORRUPT';
      throw error;
    }

    for (;;) {
      throwIfAborted(options.signal);
      let byte = reader.readByte();
      let bits = 5;

      if (byte === -1) {
        const error = new Error('Unexpected EOF!');
        error.code = 'ECM_UNEXPECTED_EOF';
        throw error;
      }

      const type = byte & 0x03;
      let count = ((byte >>> 2) & 0x1f) >>> 0;

      while (byte & 0x80) {
        byte = reader.readByte();
        if (byte === -1) {
          const error = new Error('Unexpected EOF!');
          error.code = 'ECM_UNEXPECTED_EOF';
          throw error;
        }

        count = (count | ((byte & 0x7f) << bits)) >>> 0;
        bits += 7;
      }

      if ((count >>> 0) === 0xffffffff) {
        break;
      }

      count += 1;
      if (count >= 0x80000000) {
        const error = new Error('Corrupt ECM file!');
        error.code = 'ECM_CORRUPT';
        throw error;
      }

      if (type === 0) {
        let remaining = count;

        while (remaining > 0) {
          throwIfAborted(options.signal);
          const chunkLength = Math.min(remaining, 1024 * 1024);
          const chunk = reader.readExact(chunkLength);
          checkedc = updateEdc(checkedc, chunk);
          fs.writeSync(outputDescriptor, chunk);
          outputBytes += chunk.length;
          remaining -= chunk.length;
          emitProgress(reader.position);
        }

        continue;
      }

      while (count > 0) {
        throwIfAborted(options.signal);
        sector.fill(0);
        sector.fill(0xff, 1, 11);

        if (type === 1) {
          sector[0x0f] = 0x01;
          reader.readExact(0x003).copy(sector, 0x00c);
          reader.readExact(0x800).copy(sector, 0x010);
          eccEdcGenerate(sector, 1);
          checkedc = updateEdc(checkedc, sector);
          fs.writeSync(outputDescriptor, sector);
          outputBytes += sector.length;
        } else if (type === 2 || type === 3) {
          sector[0x0f] = 0x02;
          const chunkLength = type === 2 ? 0x804 : 0x918;
          reader.readExact(chunkLength).copy(sector, 0x014);
          sector[0x10] = sector[0x14];
          sector[0x11] = sector[0x15];
          sector[0x12] = sector[0x16];
          sector[0x13] = sector[0x17];
          eccEdcGenerate(sector, type);
          checkedc = updateEdc(checkedc, sector, 0x10, 2336);
          fs.writeSync(outputDescriptor, sector.subarray(0x10, 0x10 + 2336));
          outputBytes += 2336;
        } else {
          const error = new Error('Corrupt ECM file!');
          error.code = 'ECM_CORRUPT';
          throw error;
        }

        emitProgress(reader.position);
        count -= 1;
      }
    }

    const expectedChecksum = reader.readExact(4);
    const actualChecksum = Buffer.from([
      checkedc & 0xff,
      (checkedc >>> 8) & 0xff,
      (checkedc >>> 16) & 0xff,
      (checkedc >>> 24) & 0xff,
    ]);

    if (!expectedChecksum.equals(actualChecksum)) {
      const error = new Error('Corrupt ECM file!');
      error.code = 'ECM_CORRUPT';
      throw error;
    }

    if (options.onProgress) {
      options.onProgress(100);
    }

    return {
      inputBytes: totalBytes,
      outputBytes,
    };
  } catch (error) {
    try {
      fs.closeSync(outputDescriptor);
    } catch {}

    try {
      fs.unlinkSync(outputPath);
    } catch {}

    throw error;
  } finally {
    try {
      fs.closeSync(inputDescriptor);
    } catch {}

    try {
      fs.closeSync(outputDescriptor);
    } catch {}
  }
}

module.exports = {
  decodeEcmFile,
  updateEdc,
};
