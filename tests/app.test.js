const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const request = require('supertest');

const { createApp } = require('../src/app');
const { createAbortError } = require('../src/lib/cancellation');
const { applyJobUpdate, createJobState, persistJobState } = require('../src/lib/job-state');

async function waitFor(expectation, timeoutMs = 1500) {
  const startTime = Date.now();

  for (;;) {
    const result = await expectation();
    if (result) {
      return result;
    }

    if (Date.now() - startTime > timeoutMs) {
      throw new Error('Timed out while waiting for the condition.');
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('app job lifecycle', () => {
  test('rejects empty uploads', async () => {
    const jobsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'convertiochd-empty-'));
    const app = await createApp({
      jobsDirectory,
      processConversionBatch() {
        throw new Error('This mock should not run for empty uploads.');
      },
    });

    const response = await request(app).post('/api/jobs');
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('No files');
  });

  test('cancels an in-flight job', async () => {
    const jobsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'convertiochd-app-'));
    const app = await createApp({
      jobsDirectory,
      processConversionBatch({ signal }) {
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(createAbortError()), { once: true });
          setTimeout(() => resolve({ archiveFile: null, convertedFiles: [], failedGroups: [] }), 1000);
        });
      },
    });

    const createResponse = await request(app)
      .post('/api/jobs')
      .attach('files', Buffer.from('test-image'), 'game.bin');

    expect(createResponse.status).toBe(202);
    expect(createResponse.body.jobId).toBeTruthy();

    const cancelResponse = await request(app).post(`/api/jobs/${createResponse.body.jobId}/cancel`);
    expect(cancelResponse.status).toBe(202);

    await waitFor(async () => {
      const statusResponse = await request(app).get(`/api/jobs/${createResponse.body.jobId}`);
      return statusResponse.body.status === 'cancelled';
    });
  });

  test('passes normalized conversion options to the batch processor and exposes them publicly', async () => {
    const jobsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'convertiochd-options-'));
    const seenCalls = [];
    const app = await createApp({
      jobsDirectory,
      async processConversionBatch(payload) {
        seenCalls.push(payload);
        return {
          archiveFile: null,
          conversionConcurrency: 1,
          conversionOptions: payload.conversionOptions,
          convertedFiles: [
            {
              absolutePath: path.join(payload.jobDirectory, 'output', 'Game.chd'),
              id: 'result-1',
              name: 'Game.chd',
              size: 10,
            },
          ],
          failedGroups: [],
          groupDiagnostics: [],
        };
      },
    });

    const createResponse = await request(app)
      .post('/api/jobs')
      .field('selectionMode', 'manual')
      .field('manualOutputProfile', 'dvd')
      .attach('files', Buffer.from('iso payload'), 'game.iso');

    expect(createResponse.status).toBe(202);
    expect(seenCalls).toHaveLength(1);
    expect(seenCalls[0].conversionOptions).toMatchObject({
      manualOutputProfile: 'dvd',
      selectionMode: 'manual',
    });
    expect(createResponse.body.job.conversionOptions).toMatchObject({
      manualOutputProfile: 'dvd',
      selectionMode: 'manual',
    });

    const listResponse = await request(app).get('/api/jobs');
    expect(listResponse.body.limits.consoleOptions.length).toBeGreaterThan(0);
    expect(listResponse.body.limits.manualOutputProfiles.length).toBeGreaterThan(0);
  });

  test('loads persisted jobs and keeps them in history after restart', async () => {
    const jobsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'convertiochd-history-'));
    const jobDirectory = path.join(jobsDirectory, 'persisted-job');
    await fs.mkdir(jobDirectory, { recursive: true });

    const persistedJob = createJobState({
      id: 'persisted-job',
      inputBytes: 1024,
      inputCount: 2,
      jobDirectory,
      sourceNames: ['Game.bin', 'Game.cue'],
    });

    applyJobUpdate(persistedJob, {
      detectedGroups: 1,
      groupNames: ['Game'],
      message: 'Still processing when the process stopped.',
      status: 'processing',
      title: 'Game',
      totalGroups: 1,
    });
    await persistJobState(persistedJob);

    const app = await createApp({
      jobsDirectory,
      processConversionBatch() {
        throw new Error('This mock should not run during boot.');
      },
    });

    const response = await request(app).get('/api/jobs');
    expect(response.status).toBe(200);
    expect(response.body.jobs).toHaveLength(1);
    expect(response.body.jobs[0].id).toBe('persisted-job');
    expect(response.body.jobs[0].status).toBe('failed');
    expect(response.body.jobs[0].message).toContain('restarted');
    expect(response.body.limits.maxUploadFiles).toBeGreaterThan(0);
  });

  test('streams an initial snapshot over SSE', async () => {
    const jobsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'convertiochd-sse-'));
    const app = await createApp({
      jobsDirectory,
      processConversionBatch() {
        throw new Error('This mock should not run during the SSE bootstrap test.');
      },
    });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));

    try {
      const port = server.address().port;
      const chunk = await new Promise((resolve, reject) => {
        const requestSse = http.get(`http://127.0.0.1:${port}/api/events`, (response) => {
          response.setEncoding('utf8');
          let data = '';

          response.on('data', (part) => {
            data += part;
            if (data.includes('\n\n')) {
              resolve(data.split('\n\n')[0]);
              requestSse.destroy();
            }
          });
          response.on('error', reject);
        });

        requestSse.on('error', reject);
      });

      expect(chunk).toContain('event: snapshot');
      expect(chunk).toContain('"maxConversionConcurrency"');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('downloads generated files and removes finished jobs from history', async () => {
    const jobsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'convertiochd-download-'));
    const app = await createApp({
      jobsDirectory,
      async processConversionBatch({ jobDirectory }) {
        const outputDirectory = path.join(jobDirectory, 'output');
        await fs.mkdir(outputDirectory, { recursive: true });
        const filePath = path.join(outputDirectory, 'Game.chd');
        await fs.writeFile(filePath, 'fake chd payload');

        return {
          archiveFile: null,
          conversionConcurrency: 1,
          convertedFiles: [
            {
              absolutePath: filePath,
              id: 'file-game',
              name: 'Game.chd',
              size: 16,
            },
          ],
          failedGroups: [],
          groupDiagnostics: [],
        };
      },
    });

    const createResponse = await request(app)
      .post('/api/jobs')
      .attach('files', Buffer.from('iso'), 'game.iso');

    expect(createResponse.status).toBe(202);

    const job = await waitFor(async () => {
      const statusResponse = await request(app).get(`/api/jobs/${createResponse.body.jobId}`);
      if (statusResponse.body.status === 'completed') {
        return statusResponse.body;
      }

      return null;
    });

    expect(job.results).toHaveLength(1);

    const downloadResponse = await request(app).get(job.results[0].url);
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.body.toString('utf8')).toBe('fake chd payload');

    const deleteResponse = await request(app).delete(`/api/jobs/${createResponse.body.jobId}`);
    expect(deleteResponse.status).toBe(204);

    const listResponse = await request(app).get('/api/jobs');
    expect(listResponse.body.jobs).toHaveLength(0);
  });

  test('does not allow deleting an active job', async () => {
    const jobsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'convertiochd-active-delete-'));
    const app = await createApp({
      jobsDirectory,
      processConversionBatch() {
        return new Promise(() => {});
      },
    });

    const createResponse = await request(app)
      .post('/api/jobs')
      .attach('files', Buffer.from('test-image'), 'active.bin');

    expect(createResponse.status).toBe(202);

    const deleteResponse = await request(app).delete(`/api/jobs/${createResponse.body.jobId}`);
    expect(deleteResponse.status).toBe(409);
    expect(deleteResponse.body.error).toContain('Stop the batch');
  });
});
