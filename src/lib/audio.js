const fs = require('node:fs');
const path = require('node:path');

const ffmpegStatic = require('ffmpeg-static');

const { runCommand } = require('./exec');

function resolveFfmpegBinary() {
  if (process.env.FFMPEG_BIN) {
    return process.env.FFMPEG_BIN;
  }

  if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
    return ffmpegStatic;
  }

  return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}

async function convertAudioToWav(inputPath, outputPath, options = {}) {
  const ffmpegBinary = resolveFfmpegBinary();

  await runCommand(
    ffmpegBinary,
    [
      '-y',
      '-i',
      inputPath,
      '-vn',
      '-acodec',
      'pcm_s16le',
      '-ar',
      '44100',
      '-ac',
      '2',
      outputPath,
    ],
    {
      onStderr: options.onStderr,
      onStdout: options.onStdout,
      signal: options.signal,
    },
  );

  return path.resolve(outputPath);
}

module.exports = {
  convertAudioToWav,
  resolveFfmpegBinary,
};
