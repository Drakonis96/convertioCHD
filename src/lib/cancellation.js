function createAbortError(message = 'The operation was cancelled.') {
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

function throwIfAborted(signal, message) {
  if (signal?.aborted) {
    throw createAbortError(message);
  }
}

module.exports = {
  createAbortError,
  isAbortError,
  throwIfAborted,
};
