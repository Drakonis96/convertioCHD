const { spawn } = require('node:child_process');

const { createAbortError } = require('./cancellation');

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      options.onStdout?.(text);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      options.onStderr?.(text);
    });

    const finish = (callback) => {
      if (settled) {
        return;
      }

      settled = true;
      options.signal?.removeEventListener('abort', onAbort);
      callback();
    };

    const onAbort = () => {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled) {
          child.kill('SIGKILL');
        }
      }, 2000).unref();

      finish(() => reject(createAbortError()));
    };

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }

      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (error) => {
      finish(() => reject(error));
    });

    child.on('close', (exitCode) => {
      if (options.signal?.aborted) {
        finish(() => reject(createAbortError()));
        return;
      }

      if (exitCode === 0) {
        finish(() => resolve({ stdout, stderr }));
        return;
      }

      const error = new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${exitCode}`);
      error.exitCode = exitCode;
      error.stdout = stdout;
      error.stderr = stderr;
      finish(() => reject(error));
    });
  });
}

module.exports = {
  runCommand,
};
