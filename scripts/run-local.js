const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const rootDirectory = path.resolve(__dirname, '..');
const requiredPackages = ['express', 'multer', 'archiver', '7zip-bin-full', 'chdman'];

function hasInstalledDependencies() {
  return requiredPackages.every((packageName) =>
    fs.existsSync(path.join(rootDirectory, 'node_modules', packageName, 'package.json')),
  );
}

function runOrExit(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDirectory,
    env: process.env,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function main() {
  if (!hasInstalledDependencies()) {
    console.log('Instalando dependencias...');
    runOrExit(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install']);
  }

  runOrExit(process.execPath, ['server.js']);
}

main();
