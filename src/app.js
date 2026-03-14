const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const express = require('express');
const multer = require('multer');

const {
  CLEANUP_INTERVAL_MS,
  JOB_RETENTION_MS,
  JOBS_DIR,
  MAX_CONVERSION_CONCURRENCY,
  MAX_EXTRACTED_BYTES,
  MAX_EXTRACTED_FILES,
  MAX_FILE_SIZE_BYTES,
  MAX_TOTAL_UPLOAD_BYTES,
  MAX_UPLOAD_FILES,
  PUBLIC_DIR,
} = require('./config');
const { isAbortError } = require('./lib/cancellation');
const { processConversionBatch } = require('./lib/converter');
const {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  applyJobUpdate,
  createJobState,
  loadPersistedJobs,
  persistJobState,
  toPublicJob,
} = require('./lib/job-state');
const { getConversionOptionsPayload, normalizeConversionOptions } = require('./lib/output-profile');
const { cleanupOldDirectories, ensureDir, formatBytes, slugify } = require('./lib/fs-utils');

function getLimitsPayload() {
  return {
    ...getConversionOptionsPayload(),
    maxExtractedBytes: MAX_EXTRACTED_BYTES,
    maxExtractedBytesLabel: formatBytes(MAX_EXTRACTED_BYTES),
    maxExtractedFiles: MAX_EXTRACTED_FILES,
    maxConversionConcurrency: MAX_CONVERSION_CONCURRENCY,
    maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
    maxFileSizeLabel: formatBytes(MAX_FILE_SIZE_BYTES),
    maxTotalUploadBytes: MAX_TOTAL_UPLOAD_BYTES,
    maxTotalUploadBytesLabel: formatBytes(MAX_TOTAL_UPLOAD_BYTES),
    maxUploadFiles: MAX_UPLOAD_FILES,
  };
}

function sortJobs(jobs) {
  return jobs.sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
}

function createSsePacket(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

async function removeDirectory(directoryPath) {
  if (!directoryPath) {
    return;
  }

  await fs.rm(directoryPath, { force: true, recursive: true });
}

async function createApp(options = {}) {
  const jobsDirectory = options.jobsDirectory || JOBS_DIR;
  const runBatch = options.processConversionBatch || processConversionBatch;
  const jobs = new Map();
  const streamClients = new Set();

  await ensureDir(jobsDirectory);
  await cleanupOldDirectories(jobsDirectory, JOB_RETENTION_MS);

  const persistedJobs = await loadPersistedJobs(jobsDirectory);
  for (const job of persistedJobs) {
    if (ACTIVE_STATUSES.has(job.status)) {
      applyJobUpdate(job, {
        error: null,
        message: 'The app restarted before this batch finished.',
        progress: null,
        status: 'failed',
      });
      await persistJobState(job);
    }

    jobs.set(job.id, job);
  }

  const storage = multer.diskStorage({
    destination(request, _file, callback) {
      callback(null, request.inputDirectory);
    },
    filename(_request, file, callback) {
      callback(null, `${Date.now()}-${randomUUID()}-${slugify(file.originalname)}`);
    },
  });

  const upload = multer({
    storage,
    limits: {
      fileSize: MAX_FILE_SIZE_BYTES,
      files: MAX_UPLOAD_FILES,
    },
  });

  const app = express();

  function listJobsPayload() {
    return {
      jobs: sortJobs(Array.from(jobs.values())).map((job) => toPublicJob(job)),
      limits: getLimitsPayload(),
    };
  }

  function broadcast(event, payload) {
    const packet = createSsePacket(event, payload);

    for (const response of streamClients) {
      response.write(packet);
    }
  }

  function syncJob(job, payload) {
    applyJobUpdate(job, payload);
    persistJobState(job).catch((error) => {
      console.error(`Could not persist job ${job.id}:`, error);
    });
    broadcast('job', toPublicJob(job));
  }

  async function pruneExpiredJobs() {
    await cleanupOldDirectories(jobsDirectory, JOB_RETENTION_MS);
    const cutoff = Date.now() - JOB_RETENTION_MS;

    for (const [jobId, job] of jobs) {
      const timestamp = new Date(job.updatedAt || job.createdAt).getTime();
      if (Number.isFinite(timestamp) && timestamp < cutoff) {
        jobs.delete(jobId);
        broadcast('remove', { jobId });
      }
    }
  }

  if (CLEANUP_INTERVAL_MS > 0) {
    const cleanupTimer = setInterval(() => {
      pruneExpiredJobs().catch((error) => {
        console.error('Could not prune expired jobs:', error);
      });
    }, CLEANUP_INTERVAL_MS);
    cleanupTimer.unref();
  }

  app.use(express.static(PUBLIC_DIR));

  app.get('/api/health', (_request, response) => {
    response.json({ limits: getLimitsPayload(), ok: true });
  });

  app.get('/api/jobs', (_request, response) => {
    response.json(listJobsPayload());
  });

  app.get('/api/events', (request, response) => {
    response.writeHead(200, {
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream',
    });
    response.flushHeaders?.();
    response.write(createSsePacket('snapshot', listJobsPayload()));

    streamClients.add(response);

    const heartbeat = setInterval(() => {
      response.write(': keep-alive\n\n');
    }, 15000);
    heartbeat.unref();

    request.on('close', () => {
      clearInterval(heartbeat);
      streamClients.delete(response);
    });
  });

  app.post(
    '/api/jobs',
    async (request, _response, next) => {
      request.jobId = randomUUID();
      request.jobDirectory = path.join(jobsDirectory, request.jobId);
      request.inputDirectory = path.join(request.jobDirectory, 'input');

      try {
        await ensureDir(request.inputDirectory);
        next();
      } catch (error) {
        next(error);
      }
    },
    upload.any(),
    async (request, response, next) => {
      try {
        if (!request.files || request.files.length === 0) {
          await removeDirectory(request.jobDirectory);
          response.status(400).json({ error: 'No files were received.' });
          return;
        }

        const totalUploadBytes = request.files.reduce((sum, file) => sum + (file.size || 0), 0);
        if (totalUploadBytes > MAX_TOTAL_UPLOAD_BYTES) {
          await removeDirectory(request.jobDirectory);
          response.status(413).json({
            error: `The batch exceeds the upload limit (${formatBytes(MAX_TOTAL_UPLOAD_BYTES)}).`,
          });
          return;
        }

        const abortController = new AbortController();
        const conversionOptions = normalizeConversionOptions({
          consoleId: request.body.consoleId,
          manualOutputProfile: request.body.manualOutputProfile,
          selectionMode: request.body.selectionMode,
        });
        const job = createJobState({
          conversionOptions,
          id: request.jobId,
          inputBytes: totalUploadBytes,
          inputCount: request.files.length,
          jobDirectory: request.jobDirectory,
          sourceNames: request.files.map((file) => file.originalname),
        });
        job.abortController = abortController;

        jobs.set(job.id, job);
        await persistJobState(job);
        broadcast('job', toPublicJob(job));

        const inputFiles = request.files.map((file) => ({
          absolutePath: file.path,
          originalName: file.originalname,
          size: file.size,
        }));

        runBatch({
          conversionOptions,
          jobId: job.id,
          jobDirectory: request.jobDirectory,
          inputFiles,
          signal: abortController.signal,
          onUpdate(payload) {
            syncJob(job, payload);
          },
        })
          .then((summary) => {
            syncJob(job, {
              archive: summary.archiveFile
                ? {
                    id: summary.archiveFile.id,
                    name: summary.archiveFile.name,
                    size: summary.archiveFile.size,
                    sizeLabel: formatBytes(summary.archiveFile.size),
                    url: `/api/jobs/${job.id}/files/${summary.archiveFile.id}`,
                    absolutePath: summary.archiveFile.absolutePath,
                  }
                : null,
              completedGroups: job.totalGroups || summary.convertedFiles.length + summary.failedGroups.length,
              conversionConcurrency: summary.conversionConcurrency || job.conversionConcurrency,
              conversionOptions: summary.conversionOptions || job.conversionOptions,
              error: null,
              failures: summary.failedGroups,
              groupDiagnostics: summary.groupDiagnostics || job.groupDiagnostics,
              message: summary.failedGroups.length > 0 ? 'Conversion finished with warnings.' : 'Conversion completed.',
              processingGroups: [],
              progress: 100,
              results: summary.convertedFiles.map((file) => ({
                id: file.id,
                name: file.name,
                size: file.size,
                sizeLabel: formatBytes(file.size),
                url: `/api/jobs/${job.id}/files/${file.id}`,
                absolutePath: file.absolutePath,
              })),
              status: summary.failedGroups.length > 0 ? 'completed_with_errors' : 'completed',
            });
          })
          .catch((error) => {
            if (isAbortError(error)) {
              syncJob(job, {
                error: null,
                message: 'The job was stopped.',
                progress: null,
                status: 'cancelled',
              });
              return;
            }

            syncJob(job, {
              error: error.message,
              message: 'The conversion failed.',
              progress: null,
              status: 'failed',
            });
          });

        response.status(202).json({
          job: toPublicJob(job),
          jobId: job.id,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  app.get('/api/jobs/:jobId', (request, response) => {
    const job = jobs.get(request.params.jobId);
    if (!job) {
      response.status(404).json({ error: 'Job not found.' });
      return;
    }

    response.json(toPublicJob(job));
  });

  app.post('/api/jobs/:jobId/cancel', (request, response) => {
    const job = jobs.get(request.params.jobId);
    if (!job) {
      response.status(404).json({ error: 'Job not found.' });
      return;
    }

    if (TERMINAL_STATUSES.has(job.status)) {
      response.json({ message: job.message, status: job.status });
      return;
    }

    syncJob(job, {
      message: 'Stopping the job...',
      progress: null,
      status: 'cancelling',
    });
    job.abortController?.abort();

    response.status(202).json({
      message: job.message,
      status: job.status,
    });
  });

  app.delete('/api/jobs/:jobId', async (request, response, next) => {
    const job = jobs.get(request.params.jobId);
    if (!job) {
      response.status(404).json({ error: 'Job not found.' });
      return;
    }

    if (ACTIVE_STATUSES.has(job.status)) {
      response.status(409).json({ error: 'Stop the batch before removing it from history.' });
      return;
    }

    try {
      jobs.delete(job.id);
      await removeDirectory(job.jobDirectory);
      broadcast('remove', { jobId: job.id });
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/jobs/:jobId/files/:fileId', async (request, response) => {
    const job = jobs.get(request.params.jobId);
    if (!job) {
      response.status(404).json({ error: 'Job not found.' });
      return;
    }

    const file =
      job.results.find((result) => result.id === request.params.fileId) ||
      (job.archive && job.archive.id === request.params.fileId ? job.archive : null);

    if (!file) {
      response.status(404).json({ error: 'File not found.' });
      return;
    }

    try {
      await fs.access(file.absolutePath);
    } catch {
      response.status(404).json({ error: 'The generated file is no longer available.' });
      return;
    }

    response.download(file.absolutePath, file.name);
  });

  app.use(async (error, request, response, _next) => {
    if (request.jobDirectory && request.jobId && !jobs.has(request.jobId)) {
      await removeDirectory(request.jobDirectory);
    }

    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        response.status(413).json({
          error: `A file exceeds the per-file upload limit (${formatBytes(MAX_FILE_SIZE_BYTES)}).`,
        });
        return;
      }

      if (error.code === 'LIMIT_FILE_COUNT') {
        response.status(413).json({
          error: `The batch exceeds the file count limit (${MAX_UPLOAD_FILES} files).`,
        });
        return;
      }
    }

    response.status(500).json({
      error: error.message || 'Internal server error.',
    });
  });

  return app;
}

module.exports = {
  createApp,
};
