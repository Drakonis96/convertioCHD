const fs = require('node:fs/promises');
const path = require('node:path');

const { ensureDir, formatBytes } = require('./fs-utils');

const JOB_STATE_FILE_NAME = 'job.json';
const TERMINAL_STATUSES = new Set(['completed', 'completed_with_errors', 'failed', 'cancelled']);
const ACTIVE_STATUSES = new Set(['queued', 'preparing', 'processing', 'cancelling']);

function fallbackTitleFromSources(sourceNames) {
  if (!sourceNames?.length) {
    return 'New batch';
  }

  const firstSource = sourceNames[0].replace(/\.[^.]+$/, '');
  return sourceNames.length === 1 ? firstSource : `${firstSource} +${sourceNames.length - 1} more`;
}

function buildTitle(job) {
  if (job.title) {
    return job.title;
  }

  if (job.groupNames?.length) {
    return job.groupNames.length === 1 ? job.groupNames[0] : `${job.groupNames[0]} +${job.groupNames.length - 1} more`;
  }

  return fallbackTitleFromSources(job.sourceNames);
}

function buildEventFingerprint(job) {
  return [
    job.status || '',
    job.completedGroups || '',
    job.currentGroup || '',
    (job.processingGroups || []).join(','),
    job.totalGroups || '',
    job.progress ?? '',
    job.message || '',
    job.error || '',
  ].join('|');
}

function recordJobEvent(job) {
  const fingerprint = buildEventFingerprint(job);
  const nextEvent = {
    fingerprint,
    completedGroups: job.completedGroups ?? 0,
    status: job.status,
    message: job.message || '',
    processingGroups: job.processingGroups || [],
    progress: typeof job.progress === 'number' ? job.progress : null,
    currentGroup: job.currentGroup ?? null,
    totalGroups: job.totalGroups ?? null,
    error: job.error || null,
    timestamp: job.updatedAt,
  };

  if (!job.events?.length) {
    job.events = [nextEvent];
    return;
  }

  const previousEvent = job.events[job.events.length - 1];
  if (previousEvent.fingerprint === fingerprint) {
    previousEvent.timestamp = nextEvent.timestamp;
    previousEvent.completedGroups = nextEvent.completedGroups;
    previousEvent.progress = nextEvent.progress;
    previousEvent.processingGroups = nextEvent.processingGroups;
    previousEvent.error = nextEvent.error;
    return;
  }

  job.events.push(nextEvent);
  job.events = job.events.slice(-40);
}

function serializeJob(job) {
  return {
    archive: job.archive,
    completedAt: job.completedAt || null,
    completedGroups: job.completedGroups ?? 0,
    conversionConcurrency: job.conversionConcurrency ?? 1,
    conversionOptions: job.conversionOptions || null,
    createdAt: job.createdAt,
    currentGroup: job.currentGroup ?? null,
    detectedGroups: job.detectedGroups ?? null,
    error: job.error || null,
    events: (job.events || []).map((event) => ({
      completedGroups: event.completedGroups,
      currentGroup: event.currentGroup,
      error: event.error,
      fingerprint: event.fingerprint,
      message: event.message,
      processingGroups: event.processingGroups,
      progress: event.progress,
      status: event.status,
      timestamp: event.timestamp,
      totalGroups: event.totalGroups,
    })),
    failures: job.failures || [],
    groupNames: job.groupNames || [],
    groupDiagnostics: job.groupDiagnostics || [],
    id: job.id,
    inputBytes: job.inputBytes || 0,
    inputCount: job.inputCount || 0,
    jobDirectory: job.jobDirectory,
    message: job.message || '',
    progress: typeof job.progress === 'number' ? job.progress : null,
    results: job.results || [],
    sourceNames: job.sourceNames || [],
    startedAt: job.startedAt || null,
    status: job.status,
    title: buildTitle(job),
    totalGroups: job.totalGroups ?? null,
    processingGroups: job.processingGroups || [],
    updatedAt: job.updatedAt,
  };
}

function toPublicJob(job) {
  return {
    archive: job.archive
      ? {
          id: job.archive.id,
          name: job.archive.name,
          size: job.archive.size,
          sizeLabel: job.archive.sizeLabel,
          url: job.archive.url,
        }
      : null,
    completedAt: job.completedAt || null,
    completedGroups: job.completedGroups ?? 0,
    conversionConcurrency: job.conversionConcurrency ?? 1,
    conversionOptions: job.conversionOptions || null,
    createdAt: job.createdAt,
    currentGroup: job.currentGroup ?? null,
    detectedGroups: job.detectedGroups ?? null,
    error: job.error || null,
    events: (job.events || []).map((event) => ({
      completedGroups: event.completedGroups,
      currentGroup: event.currentGroup,
      error: event.error,
      message: event.message,
      processingGroups: event.processingGroups,
      progress: event.progress,
      status: event.status,
      timestamp: event.timestamp,
      totalGroups: event.totalGroups,
    })),
    failures: job.failures || [],
    groupNames: job.groupNames || [],
    groupDiagnostics: job.groupDiagnostics || [],
    id: job.id,
    inputBytes: job.inputBytes || 0,
    inputBytesLabel: formatBytes(job.inputBytes || 0),
    inputCount: job.inputCount || 0,
    message: job.message || '',
    progress: typeof job.progress === 'number' ? job.progress : null,
    results: (job.results || []).map((result) => ({
      id: result.id,
      name: result.name,
      size: result.size,
      sizeLabel: result.sizeLabel,
      url: result.url,
    })),
    sourceNames: job.sourceNames || [],
    startedAt: job.startedAt || null,
    status: job.status,
    title: buildTitle(job),
    totalGroups: job.totalGroups ?? null,
    processingGroups: job.processingGroups || [],
    updatedAt: job.updatedAt,
  };
}

function createJobState({ conversionOptions, id, inputBytes, inputCount, jobDirectory, sourceNames }) {
  const now = new Date().toISOString();
  const job = {
    abortController: null,
    archive: null,
    completedAt: null,
    completedGroups: 0,
    conversionConcurrency: 1,
    conversionOptions: conversionOptions || null,
    createdAt: now,
    currentGroup: null,
    detectedGroups: null,
    error: null,
    events: [],
    failures: [],
    groupNames: [],
    groupDiagnostics: [],
    id,
    inputBytes: inputBytes || 0,
    inputCount: inputCount || 0,
    jobDirectory,
    message: 'Upload complete. Waiting to start.',
    persistChain: Promise.resolve(),
    progress: null,
    results: [],
    sourceNames: sourceNames || [],
    startedAt: null,
    status: 'queued',
    title: fallbackTitleFromSources(sourceNames),
    totalGroups: null,
    processingGroups: [],
    updatedAt: now,
  };

  recordJobEvent(job);
  return job;
}

function applyJobUpdate(job, payload) {
  Object.assign(job, payload);
  job.updatedAt = new Date().toISOString();

  if (!job.startedAt && ACTIVE_STATUSES.has(job.status)) {
    job.startedAt = job.updatedAt;
  }

  if (TERMINAL_STATUSES.has(job.status) && !job.completedAt) {
    job.completedAt = job.updatedAt;
  }

  job.title = buildTitle(job);
  recordJobEvent(job);
  return job;
}

async function persistJobState(job) {
  if (!job.jobDirectory) {
    return;
  }

  const destinationPath = path.join(job.jobDirectory, JOB_STATE_FILE_NAME);
  const serializedJob = JSON.stringify(serializeJob(job), null, 2);

  job.persistChain = (job.persistChain || Promise.resolve()).then(async () => {
    await ensureDir(job.jobDirectory);
    await fs.writeFile(destinationPath, serializedJob, 'utf8');
  });

  await job.persistChain;
}

function hydratePersistedJob(summary) {
  return {
    ...summary,
    abortController: null,
    archive: summary.archive || null,
    completedAt: summary.completedAt || null,
    completedGroups: summary.completedGroups ?? 0,
    conversionConcurrency: summary.conversionConcurrency ?? 1,
    conversionOptions: summary.conversionOptions || null,
    currentGroup: summary.currentGroup ?? null,
    detectedGroups: summary.detectedGroups ?? null,
    error: summary.error || null,
    events: summary.events || [],
    failures: summary.failures || [],
    groupNames: summary.groupNames || [],
    groupDiagnostics: summary.groupDiagnostics || [],
    inputBytes: summary.inputBytes || 0,
    inputCount: summary.inputCount || 0,
    persistChain: Promise.resolve(),
    progress: typeof summary.progress === 'number' ? summary.progress : null,
    results: summary.results || [],
    sourceNames: summary.sourceNames || [],
    startedAt: summary.startedAt || null,
    title: summary.title || fallbackTitleFromSources(summary.sourceNames),
    totalGroups: summary.totalGroups ?? null,
    processingGroups: summary.processingGroups || [],
    updatedAt: summary.updatedAt || summary.createdAt,
  };
}

async function loadPersistedJobs(jobsDirectory) {
  await ensureDir(jobsDirectory);
  const entries = await fs.readdir(jobsDirectory, { withFileTypes: true });
  const jobs = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const jobDirectory = path.join(jobsDirectory, entry.name);
    const stateFilePath = path.join(jobDirectory, JOB_STATE_FILE_NAME);

    try {
      const rawState = await fs.readFile(stateFilePath, 'utf8');
      jobs.push(hydratePersistedJob(JSON.parse(rawState)));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  jobs.sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
  return jobs;
}

module.exports = {
  ACTIVE_STATUSES,
  JOB_STATE_FILE_NAME,
  TERMINAL_STATUSES,
  applyJobUpdate,
  createJobState,
  loadPersistedJobs,
  persistJobState,
  toPublicJob,
};
