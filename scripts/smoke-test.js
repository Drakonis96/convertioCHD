const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { processConversionBatch } = require('../src/lib/converter');
const { DATA_DIR } = require('../src/config');

async function runFixture(label, inputFiles) {
  const jobId = `${label}-${randomUUID().slice(0, 8)}`;
  const jobDirectory = path.join(DATA_DIR, 'smoke', jobId);

  const summary = await processConversionBatch({
    jobId,
    jobDirectory,
    inputFiles,
    onUpdate(update) {
      if (update.message) {
        console.log(`[${label}] ${update.message}`);
      }
    },
  });

  console.log(`[${label}] ${summary.convertedFiles.length} CHD file(s) generated`);
  if (summary.failedGroups.length > 0) {
    console.log(`[${label}] Failures: ${summary.failedGroups.map((entry) => `${entry.name}: ${entry.error}`).join(' | ')}`);
  }
}

async function main() {
  const rootDirectory = path.resolve(__dirname, '..');
  const crashPath = path.join(rootDirectory, 'test-files', 'bin_cue_separados');
  const residentEvilPath = path.join(rootDirectory, 'test-files', 'bin.ecm comprimidos ', 'Resident Evil 3 - Nemesis (E) [SLES-02529].bin.ecm');

  await fs.mkdir(path.join(DATA_DIR, 'smoke'), { recursive: true });

  await runFixture('crash', [
    {
      absolutePath: path.join(crashPath, 'Crash Bandicoot (Europe) (EDC).cue'),
      originalName: 'Crash Bandicoot (Europe) (EDC).cue',
    },
    {
      absolutePath: path.join(crashPath, 'Crash Bandicoot (Europe) (EDC).bin'),
      originalName: 'Crash Bandicoot (Europe) (EDC).bin',
    },
  ]);

  await runFixture('resident-evil', [
    {
      absolutePath: residentEvilPath,
      originalName: path.basename(residentEvilPath),
    },
  ]);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
