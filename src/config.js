const os = require('node:os');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const JOBS_DIR = path.join(DATA_DIR, 'jobs');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const PORT = Number(process.env.PORT || 5459);
const JOB_RETENTION_MS = Number(process.env.JOB_RETENTION_MS || 1000 * 60 * 60 * 24);
const MAX_UPLOAD_FILES = Number(process.env.MAX_UPLOAD_FILES || 100);
const MAX_FILE_SIZE_BYTES = Number(process.env.MAX_FILE_SIZE_BYTES || 4 * 1024 * 1024 * 1024);
const MAX_TOTAL_UPLOAD_BYTES = Number(process.env.MAX_TOTAL_UPLOAD_BYTES || 24 * 1024 * 1024 * 1024);
const MAX_EXTRACTED_BYTES = Number(process.env.MAX_EXTRACTED_BYTES || 32 * 1024 * 1024 * 1024);
const MAX_EXTRACTED_FILES = Number(process.env.MAX_EXTRACTED_FILES || 8000);
const DEFAULT_CONVERSION_CONCURRENCY = Math.min(3, Math.max(1, Math.floor((os.availableParallelism?.() || 4) / 2)));
const MAX_CONVERSION_CONCURRENCY = Math.max(
  1,
  Number(process.env.MAX_CONVERSION_CONCURRENCY || DEFAULT_CONVERSION_CONCURRENCY),
);
const CLEANUP_INTERVAL_MS = Number(process.env.CLEANUP_INTERVAL_MS || 1000 * 60 * 30);

module.exports = {
  CLEANUP_INTERVAL_MS,
  ROOT_DIR,
  DATA_DIR,
  JOB_RETENTION_MS,
  JOBS_DIR,
  MAX_CONVERSION_CONCURRENCY,
  MAX_EXTRACTED_BYTES,
  MAX_EXTRACTED_FILES,
  MAX_FILE_SIZE_BYTES,
  MAX_TOTAL_UPLOAD_BYTES,
  MAX_UPLOAD_FILES,
  PUBLIC_DIR,
  PORT,
};
