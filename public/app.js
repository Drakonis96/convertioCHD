const announcer = document.querySelector('#announcer');
const alertAnnouncer = document.querySelector('#alert-announcer');
const dropzone = document.querySelector('#dropzone');
const fileInput = document.querySelector('#file-input');
const modeSummary = document.querySelector('#mode-summary');
const automaticSettings = document.querySelector('#automatic-settings');
const manualSettings = document.querySelector('#manual-settings');
const consoleSelect = document.querySelector('#console-select');
const manualOutputProfileSelect = document.querySelector('#manual-output-profile-select');
const selectionModeButtons = Array.from(document.querySelectorAll('[data-selection-mode]'));
const clearFinishedButton = document.querySelector('#clear-finished-button');
const streamState = document.querySelector('#stream-state');
const sessionSummary = document.querySelector('#session-summary');
const limitsSummary = document.querySelector('#limits-summary');
const uploadsList = document.querySelector('#uploads-list');
const summaryGrid = document.querySelector('#summary-grid');
const jobsList = document.querySelector('#jobs-list');
const jobsEmpty = document.querySelector('#jobs-empty');

const ACTIVE_STATUSES = new Set(['queued', 'preparing', 'processing', 'cancelling']);
const SETTLED_STATUSES = new Set(['completed', 'completed_with_errors', 'failed', 'cancelled']);
const COMPLETED_STATUSES = new Set(['completed', 'completed_with_errors']);

const state = {
  conversionOptions: {
    consoleId: 'auto',
    consoleLabel: 'Auto detect',
    manualOutputProfile: 'cd',
    manualOutputProfileLabel: 'CD CHD',
    selectionMode: 'automatic',
    selectionModeLabel: 'Automatic',
  },
  deliveredJobs: new Set(),
  jobs: new Map(),
  limits: null,
  seededSettledJobs: new Set(),
  streamStatus: 'connecting',
  uploads: new Map(),
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function announce(message, priority = 'polite') {
  const target = priority === 'assertive' ? alertAnnouncer : announcer;
  if (!target || !message) {
    return;
  }

  target.textContent = '';
  window.requestAnimationFrame(() => {
    target.textContent = message;
  });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 1000) {
    return '0s';
  }

  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  }

  return `${seconds}s`;
}

function formatTimestamp(value) {
  if (!value) {
    return 'Just now';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Just now';
  }

  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getConsoleOptions() {
  return state.limits?.consoleOptions || [];
}

function getManualOutputProfiles() {
  return state.limits?.manualOutputProfiles || [];
}

function normalizeClientConversionOptions(options = state.conversionOptions) {
  const consoleOptions = getConsoleOptions();
  const manualOutputProfiles = getManualOutputProfiles();
  const validConsole = consoleOptions.find((entry) => entry.id === options.consoleId) || consoleOptions[0] || {
    id: 'auto',
    label: 'Auto detect',
  };
  const validManualProfile =
    manualOutputProfiles.find((entry) => entry.id === options.manualOutputProfile) || manualOutputProfiles[0] || {
      id: 'cd',
      label: 'CD CHD',
    };
  const selectionMode = options.selectionMode === 'manual' ? 'manual' : 'automatic';

  return {
    consoleId: validConsole.id,
    consoleLabel: validConsole.label,
    manualOutputProfile: validManualProfile.id,
    manualOutputProfileLabel: validManualProfile.label,
    selectionMode,
    selectionModeLabel: selectionMode === 'manual' ? 'Manual' : 'Automatic',
  };
}

function setConversionOptions(patch) {
  state.conversionOptions = normalizeClientConversionOptions({
    ...state.conversionOptions,
    ...patch,
  });
  render();
}

function translateStatus(status) {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'preparing':
      return 'Preparing';
    case 'processing':
      return 'Processing';
    case 'cancelling':
      return 'Stopping';
    case 'cancelled':
      return 'Stopped';
    case 'completed':
      return 'Completed';
    case 'completed_with_errors':
      return 'Completed with warnings';
    case 'failed':
      return 'Failed';
    default:
      return status || 'Unknown';
  }
}

function translateConfidence(confidence) {
  switch (confidence) {
    case 'high':
      return 'High confidence';
    case 'medium':
      return 'Medium confidence';
    case 'review':
      return 'Needs review';
    case 'warning':
      return 'Warning';
    default:
      return 'Review';
  }
}

function isJobActive(status) {
  return ACTIVE_STATUSES.has(status);
}

function isJobSettled(status) {
  return SETTLED_STATUSES.has(status);
}

function getElapsedMs(job) {
  const start = job.startedAt || job.createdAt;
  if (!start) {
    return 0;
  }

  const startTime = new Date(start).getTime();
  const endTime = job.completedAt ? new Date(job.completedAt).getTime() : Date.now();
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime) {
    return 0;
  }

  return endTime - startTime;
}

function getEtaLabel(job) {
  if (!Number.isFinite(job.progress) || job.progress < 2 || job.progress >= 100) {
    return isJobSettled(job.status) ? 'Done' : 'Estimating';
  }

  const elapsedMs = getElapsedMs(job);
  if (elapsedMs < 1500) {
    return 'Estimating';
  }

  const totalMs = (elapsedMs / job.progress) * 100;
  const remainingMs = totalMs - elapsedMs;
  return remainingMs > 1000 ? formatDuration(remainingMs) : 'Almost done';
}

function getSortedJobs() {
  return Array.from(state.jobs.values()).sort((left, right) => {
    const leftActive = isJobActive(left.status) ? 1 : 0;
    const rightActive = isJobActive(right.status) ? 1 : 0;

    if (leftActive !== rightActive) {
      return rightActive - leftActive;
    }

    return new Date(right.updatedAt || right.createdAt) - new Date(left.updatedAt || left.createdAt);
  });
}

function createUploadId() {
  return `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getDownloadTargets(job) {
  return job.archive ? [job.archive] : job.results || [];
}

function triggerBrowserDownload(file) {
  const anchor = document.createElement('a');
  anchor.href = file.url;
  anchor.download = file.name;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function deliverOutputs(job) {
  if (!COMPLETED_STATUSES.has(job.status) || state.deliveredJobs.has(job.id)) {
    return;
  }

  const targets = getDownloadTargets(job);
  if (!targets.length) {
    return;
  }

  state.deliveredJobs.add(job.id);
  targets.forEach((file, index) => {
    window.setTimeout(() => triggerBrowserDownload(file), index * 250);
  });
}

function buildProcessingCopy(job) {
  if (!job.totalGroups) {
    return 'Waiting for group analysis';
  }

  const completedGroups = job.completedGroups || 0;
  const processingGroups = job.processingGroups || [];

  if (!processingGroups.length) {
    return `${completedGroups} of ${job.totalGroups} groups complete`;
  }

  return `${completedGroups} of ${job.totalGroups} groups complete · Active: ${processingGroups.join(', ')}`;
}

function maybeDeliverJob(job, previousJob) {
  if (state.seededSettledJobs.has(job.id)) {
    return;
  }

  if (!COMPLETED_STATUSES.has(job.status)) {
    return;
  }

  if (!previousJob || !COMPLETED_STATUSES.has(previousJob.status)) {
    deliverOutputs(job);
  }
}

function maybeAnnounceJob(job, previousJob) {
  if (!previousJob) {
    announce(`Batch ${job.title} added to the queue.`);
    return;
  }

  if (job.error && job.error !== previousJob.error) {
    announce(`${job.title}: ${job.error}`, 'assertive');
    return;
  }

  if (job.status !== previousJob.status) {
    if (job.status === 'completed') {
      announce(`Batch ${job.title} completed. Download started automatically.`);
      return;
    }

    if (job.status === 'completed_with_errors') {
      announce(`Batch ${job.title} completed with warnings. Download started automatically.`);
      return;
    }

    if (job.status === 'failed' || job.status === 'cancelled') {
      announce(`Batch ${job.title} ${translateStatus(job.status).toLowerCase()}.`, 'assertive');
      return;
    }

    announce(`Batch ${job.title} is now ${translateStatus(job.status).toLowerCase()}.`);
  }

  const previousDiagnostics = previousJob.groupDiagnostics?.length || 0;
  const nextDiagnostics = job.groupDiagnostics?.length || 0;
  if (!previousDiagnostics && nextDiagnostics) {
    const reviewCount = job.groupDiagnostics.filter((diagnostic) => diagnostic.confidence !== 'high').length;
    if (reviewCount > 0) {
      announce(`Batch ${job.title} detected ${reviewCount} groups that need review.`, 'assertive');
      return;
    }

    announce(`Batch ${job.title} analysis is ready.`);
  }
}

function applySnapshot(payload) {
  state.limits = payload.limits || state.limits;
  state.conversionOptions = normalizeClientConversionOptions(state.conversionOptions);
  state.jobs = new Map();
  state.seededSettledJobs.clear();

  for (const job of payload.jobs || []) {
    state.jobs.set(job.id, job);
    if (isJobSettled(job.status)) {
      state.seededSettledJobs.add(job.id);
    }
  }
}

function upsertJob(job, options = {}) {
  const previousJob = state.jobs.get(job.id);
  state.jobs.set(job.id, job);
  maybeDeliverJob(job, previousJob);

  if (options.announceChange !== false) {
    maybeAnnounceJob(job, previousJob);
  }
}

function updateUpload(uploadId, patch) {
  const upload = state.uploads.get(uploadId);
  if (!upload) {
    return;
  }

  Object.assign(upload, patch);
  render();
}

function removeUpload(uploadId) {
  state.uploads.delete(uploadId);
  render();
}

function renderProgressBar(label, value, valueText) {
  const clampedValue = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  const ariaValueText = valueText || `${clampedValue}%`;

  return `
    <div
      class="meter"
      role="progressbar"
      aria-label="${escapeHtml(label)}"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow="${clampedValue}"
      aria-valuetext="${escapeHtml(ariaValueText)}"
    >
      <span style="width: ${clampedValue}%"></span>
    </div>
  `;
}

function renderStreamState() {
  const labels = {
    connecting: 'Connecting',
    live: 'Live',
    reconnecting: 'Reconnecting',
  };

  streamState.textContent = labels[state.streamStatus] || 'Connecting';
  streamState.className = 'pill';

  if (state.streamStatus === 'live') {
    streamState.classList.add('is-live');
  }

  if (state.streamStatus === 'reconnecting') {
    streamState.classList.add('is-error');
  }
}

function syncSelectOptions(selectElement, options, selectedId) {
  const currentMarkup = options.map((option) => `${option.id}:${option.label}`).join('|');
  if (selectElement.dataset.optionsMarkup !== currentMarkup) {
    selectElement.innerHTML = options
      .map((option) => `<option value="${escapeHtml(option.id)}">${escapeHtml(option.label)}</option>`)
      .join('');
    selectElement.dataset.optionsMarkup = currentMarkup;
  }

  if (selectedId) {
    selectElement.value = selectedId;
  }
}

function renderConversionControls() {
  const conversionOptions = normalizeClientConversionOptions(state.conversionOptions);
  state.conversionOptions = conversionOptions;

  syncSelectOptions(consoleSelect, getConsoleOptions(), conversionOptions.consoleId);
  syncSelectOptions(manualOutputProfileSelect, getManualOutputProfiles(), conversionOptions.manualOutputProfile);

  automaticSettings.classList.toggle('hidden', conversionOptions.selectionMode !== 'automatic');
  manualSettings.classList.toggle('hidden', conversionOptions.selectionMode !== 'manual');

  selectionModeButtons.forEach((button) => {
    const isActive = button.dataset.selectionMode === conversionOptions.selectionMode;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });

  modeSummary.innerHTML =
    conversionOptions.selectionMode === 'automatic'
      ? `
        <strong>${escapeHtml(conversionOptions.selectionModeLabel)} mode</strong>
        <span class="subtle">${escapeHtml(conversionOptions.consoleLabel)} selected. The app will choose the appropriate CHD profile for each detected group.</span>
      `
      : `
        <strong>${escapeHtml(conversionOptions.selectionModeLabel)} mode</strong>
        <span class="subtle">Every compatible group will use ${escapeHtml(conversionOptions.manualOutputProfileLabel)}.</span>
      `;
}

function renderSessionSummary() {
  const jobs = getSortedJobs();
  const activeJobs = jobs.filter((job) => isJobActive(job.status));
  const finishedJobs = jobs.filter((job) => isJobSettled(job.status));
  const uploads = Array.from(state.uploads.values());
  const totalInputBytes = jobs.reduce((sum, job) => sum + (job.inputBytes || 0), 0);
  const maxWorkers = state.limits?.maxConversionConcurrency || 1;

  sessionSummary.innerHTML = `
    <div class="stack-item">
      <strong>${activeJobs.length} active batch(es)</strong>
      <span class="subtle">${uploads.length} upload(s) currently in flight</span>
    </div>
    <div class="stack-item">
      <strong>${finishedJobs.length} batch(es) in history</strong>
      <span class="subtle">Completed jobs remain available after restart until the retention window expires.</span>
    </div>
    <div class="stack-item">
      <strong>${formatBytes(totalInputBytes)} tracked input</strong>
      <span class="subtle">The server can process up to ${maxWorkers} conversion group(s) at once per batch.</span>
    </div>
  `;

  clearFinishedButton.disabled = finishedJobs.length === 0;
}

function renderLimitsSummary() {
  if (!state.limits) {
    limitsSummary.innerHTML = `
      <div class="stack-item">
        <strong>Loading limits</strong>
        <span class="subtle">Waiting for the server bootstrap data.</span>
      </div>
    `;
    return;
  }

  limitsSummary.innerHTML = `
    <div class="stack-item">
      <strong>${escapeHtml(state.limits.maxFileSizeLabel)} per file</strong>
      <span class="subtle">Hard upload limit enforced by the server.</span>
    </div>
    <div class="stack-item">
      <strong>${escapeHtml(state.limits.maxTotalUploadBytesLabel)} per batch</strong>
      <span class="subtle">Total upload quota for each drop operation.</span>
    </div>
    <div class="stack-item">
      <strong>${escapeHtml(state.limits.maxExtractedBytesLabel)} extracted data</strong>
      <span class="subtle">Archive inspection blocks batches that would expand too far.</span>
    </div>
    <div class="stack-item">
      <strong>${state.limits.maxConversionConcurrency} concurrent group worker(s)</strong>
      <span class="subtle">Conversion concurrency is configurable on the server.</span>
    </div>
  `;
}

function renderSummaryGrid() {
  const jobs = getSortedJobs();
  const activeJobs = jobs.filter((job) => isJobActive(job.status));
  const readyFiles = jobs.reduce((sum, job) => {
    if (!COMPLETED_STATUSES.has(job.status)) {
      return sum;
    }

    if (job.archive) {
      return sum + 1;
    }

    return sum + (job.results?.length || 0);
  }, 0);
  const detectedGames = jobs.reduce((sum, job) => sum + (job.detectedGroups || 0), 0);
  const reviewGroups = jobs.reduce(
    (sum, job) => sum + (job.groupDiagnostics || []).filter((diagnostic) => diagnostic.confidence !== 'high').length,
    0,
  );

  summaryGrid.innerHTML = `
    <article class="summary-card">
      <span class="summary-label">Active Batches</span>
      <span class="summary-value">${activeJobs.length}</span>
      <div class="summary-note">Uploads and conversions currently running.</div>
    </article>
    <article class="summary-card">
      <span class="summary-label">Ready Downloads</span>
      <span class="summary-value">${readyFiles}</span>
      <div class="summary-note">Archives or CHD files available from finished jobs.</div>
    </article>
    <article class="summary-card">
      <span class="summary-label">Detected Games</span>
      <span class="summary-value">${detectedGames}</span>
      <div class="summary-note">Disc groups identified across the stored history.</div>
    </article>
    <article class="summary-card">
      <span class="summary-label">Needs Review</span>
      <span class="summary-value">${reviewGroups}</span>
      <div class="summary-note">Groups with heuristic matches or missing references.</div>
    </article>
  `;
}

function renderUploads() {
  const uploads = Array.from(state.uploads.values()).sort((left, right) => right.startedAt - left.startedAt);

  if (!uploads.length) {
    uploadsList.innerHTML = `
      <div class="stack-item" role="listitem">
        <strong>No uploads in progress</strong>
        <span class="subtle">New batches appear here before the server turns them into tracked jobs.</span>
      </div>
    `;
    return;
  }

  uploadsList.innerHTML = uploads
    .map((upload) => {
      const progressValue = Number.isFinite(upload.progress) ? upload.progress : 0;
      const buttonLabel = upload.status === 'uploading' ? 'Stop upload' : 'Clear';
      const buttonAction = upload.status === 'uploading' ? 'cancel' : 'clear';
      const secondaryCopy =
        upload.status === 'failed'
          ? escapeHtml(upload.error || 'The upload failed.')
          : upload.status === 'cancelled'
            ? 'Upload stopped manually.'
            : `${upload.fileCount} file(s) · ${formatBytes(upload.totalBytes)}`;

      return `
        <article class="upload-card" role="listitem" aria-label="Upload ${escapeHtml(upload.label)}">
          <div class="job-head">
            <div>
              <strong>${escapeHtml(upload.label)}</strong>
              <p class="job-status-line">${escapeHtml(secondaryCopy)}</p>
            </div>
            <span class="tiny">${escapeHtml(formatTimestamp(upload.startedAt))}</span>
          </div>
          <div class="job-body">
            ${renderProgressBar(`Upload progress for ${upload.label}`, progressValue, `${progressValue}% uploaded`)}
            <div class="job-actions">
              <span class="tiny">${upload.status === 'uploading' ? `${progressValue}% uploaded` : escapeHtml(translateStatus(upload.status))}</span>
              <div class="action-cluster">
                <button
                  class="button button-muted"
                  type="button"
                  data-upload-action="${buttonAction}"
                  data-upload-id="${upload.id}"
                  aria-label="${buttonAction === 'cancel' ? `Stop upload ${upload.label}` : `Clear upload ${upload.label}`}"
                >${buttonLabel}</button>
              </div>
            </div>
          </div>
        </article>
      `;
    })
    .join('');
}

function renderDiagnosticReference(reference) {
  const referenceState = reference.matchedFile
    ? `${reference.reference} -> ${reference.matchedFile}`
    : `${reference.reference} -> missing`;

  return `
    <li>
      <strong>${escapeHtml(referenceState)}</strong>
      <span class="tiny">${escapeHtml(translateConfidence(reference.confidence))}</span>
    </li>
  `;
}

function renderGroupDiagnostics(job) {
  if (!job.groupDiagnostics?.length) {
    return '';
  }

  return `
    <section class="diagnostic-section" aria-label="Detected group diagnostics">
      <div class="section-label">Detected groups</div>
      <div class="diagnostic-list">
        ${job.groupDiagnostics
          .map(
            (diagnostic) => `
              <article class="diagnostic-card" data-confidence="${escapeHtml(diagnostic.confidence)}">
                <div class="job-head">
                  <div>
                    <strong>${escapeHtml(diagnostic.name)}</strong>
                    <p class="job-status-line">${escapeHtml(diagnostic.descriptorFile ? `${diagnostic.descriptorLabel}: ${diagnostic.descriptorFile}` : diagnostic.descriptorLabel || 'Standalone image')}</p>
                  </div>
                  <span class="pill diagnostic-pill">${escapeHtml(translateConfidence(diagnostic.confidence))}</span>
                </div>
                <div class="chip-row">
                  ${diagnostic.files.map((fileName) => `<span class="chip">${escapeHtml(fileName)}</span>`).join('')}
                </div>
                ${diagnostic.references.length ? `<ul class="diagnostic-reference-list">${diagnostic.references.map(renderGroupDiagnosticsReferenceProxy).join('')}</ul>` : ''}
                ${diagnostic.missingReferences.length ? `<p class="warning">Missing: ${escapeHtml(diagnostic.missingReferences.join(', '))}</p>` : ''}
                ${diagnostic.warnings.length ? `<ul class="diagnostic-warning-list">${diagnostic.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul>` : ''}
              </article>`,
          )
          .join('')}
      </div>
    </section>
  `;
}

function renderGroupDiagnosticsReferenceProxy(reference) {
  return renderDiagnosticReference(reference);
}

function renderJobs() {
  const jobs = getSortedJobs();
  jobsEmpty.classList.toggle('hidden', jobs.length > 0);

  if (!jobs.length) {
    jobsList.innerHTML = '';
    return;
  }

  jobsList.innerHTML = jobs
    .map((job) => {
      const detectedGames = job.detectedGroups || job.totalGroups || 0;
      const inputLabel = job.inputBytesLabel || formatBytes(job.inputBytes || 0);
      const progressLabel = Number.isFinite(job.progress) ? `${job.progress}%` : translateStatus(job.status);
      const elapsedLabel = formatDuration(getElapsedMs(job));
      const etaLabel = getEtaLabel(job);
      const latestEvents = (job.events || []).slice(-4).reverse();
      const results = getDownloadTargets(job);
      const conversionOptions = normalizeClientConversionOptions(job.conversionOptions || state.conversionOptions);
      const autoDownloadNotice = state.deliveredJobs.has(job.id)
        ? `<p class="notice">Browser download started automatically for this batch.</p>`
        : '';
      const warnings = (job.failures || [])
        .map(
          (failure) => `
            <div class="warning-row">
              <strong>${escapeHtml(failure.name)}</strong>
              <p class="warning">${escapeHtml(failure.error)}</p>
            </div>`,
        )
        .join('');

      const resultRows = results
        .map(
          (file) => `
            <a class="result-row" href="${file.url}">
              <span>${escapeHtml(file.name)}</span>
              <span class="tiny">${escapeHtml(file.sizeLabel)}</span>
            </a>`,
        )
        .join('');

      const eventsMarkup = latestEvents.length
        ? `
          <div class="event-list" aria-label="Recent activity">
            ${latestEvents
              .map(
                (event) => `
                  <div class="event-item">
                    <div class="event-head">
                      <strong>${escapeHtml(translateStatus(event.status))}</strong>
                      <span>${escapeHtml(formatTimestamp(event.timestamp))}</span>
                    </div>
                    <p>${escapeHtml(event.message || 'Working...')}</p>
                    ${Number.isFinite(event.progress) ? `<span class="event-progress">${event.progress}%</span>` : ''}
                  </div>`,
              )
              .join('')}
          </div>`
        : '';

      return `
        <article class="job-card" data-status="${escapeHtml(job.status)}" role="listitem" aria-busy="${isJobActive(job.status)}">
          <div class="job-head">
            <div>
              <h3 class="job-title">${escapeHtml(job.title)}</h3>
              <p class="job-status-line">${escapeHtml(translateStatus(job.status))} · Updated ${escapeHtml(formatTimestamp(job.updatedAt || job.createdAt))}</p>
            </div>
            <span class="pill ${isJobActive(job.status) ? 'is-live' : ''}" aria-hidden="true">${escapeHtml(progressLabel)}</span>
          </div>

          <div class="job-body">
            <p class="job-message">${escapeHtml(job.message || 'Working...')}</p>
            ${autoDownloadNotice}
            ${job.error ? `<p class="error" role="alert">${escapeHtml(job.error)}</p>` : ''}
            <div class="chip-row compact-chip-row" aria-label="Conversion selection">
              <span class="chip">${escapeHtml(conversionOptions.selectionModeLabel)}</span>
              <span class="chip">${escapeHtml(conversionOptions.selectionMode === 'automatic' ? conversionOptions.consoleLabel : conversionOptions.manualOutputProfileLabel)}</span>
            </div>

            <div class="metric-grid">
              <div class="metric">
                <span class="metric-label">Input</span>
                <span class="metric-value">${escapeHtml(inputLabel)}</span>
              </div>
              <div class="metric">
                <span class="metric-label">Files</span>
                <span class="metric-value">${job.inputCount || 0}</span>
              </div>
              <div class="metric">
                <span class="metric-label">Groups</span>
                <span class="metric-value">${job.completedGroups || 0} / ${job.totalGroups || detectedGames || '...'}</span>
              </div>
              <div class="metric">
                <span class="metric-label">Workers</span>
                <span class="metric-value">${job.conversionConcurrency || 1}</span>
              </div>
              <div class="metric">
                <span class="metric-label">Target</span>
                <span class="metric-value">${escapeHtml(conversionOptions.selectionMode === 'automatic' ? conversionOptions.consoleLabel : conversionOptions.manualOutputProfileLabel)}</span>
              </div>
              <div class="metric">
                <span class="metric-label">Elapsed / ETA</span>
                <span class="metric-value">${escapeHtml(elapsedLabel)} / ${escapeHtml(etaLabel)}</span>
              </div>
            </div>

            ${renderProgressBar(`Batch progress for ${job.title}`, Number.isFinite(job.progress) ? job.progress : 0, progressLabel)}
            <p class="tiny">${escapeHtml(buildProcessingCopy(job))}</p>

            ${renderGroupDiagnostics(job)}
            ${eventsMarkup}
            ${resultRows ? `<div class="results-list">${resultRows}</div>` : ''}
            ${warnings ? `<div class="warning-list">${warnings}</div>` : ''}

            <div class="job-actions">
              <span class="tiny">${job.currentGroup && job.totalGroups ? `Current slot ${job.currentGroup} of ${job.totalGroups}` : 'Waiting for group details'}</span>
              <div class="action-cluster">
                ${isJobActive(job.status) ? `<button class="button button-danger" type="button" data-job-action="cancel" data-job-id="${job.id}" aria-label="Stop batch ${escapeHtml(job.title)}">Stop</button>` : ''}
                ${!isJobActive(job.status) ? `<button class="button button-muted" type="button" data-job-action="clear" data-job-id="${job.id}" aria-label="Clear batch ${escapeHtml(job.title)} from history">Clear</button>` : ''}
              </div>
            </div>
          </div>
        </article>
      `;
    })
    .join('');
}

function render() {
  renderConversionControls();
  renderStreamState();
  renderSessionSummary();
  renderLimitsSummary();
  renderSummaryGrid();
  renderUploads();
  renderJobs();
}

function connectEventStream() {
  const eventSource = new EventSource('/api/events');
  state.streamStatus = 'connecting';
  render();

  eventSource.addEventListener('open', () => {
    const wasReconnecting = state.streamStatus === 'reconnecting';
    state.streamStatus = 'live';
    if (wasReconnecting) {
      announce('Live job updates restored.');
    }
    render();
  });

  eventSource.addEventListener('snapshot', (event) => {
    applySnapshot(JSON.parse(event.data));
    render();
  });

  eventSource.addEventListener('job', (event) => {
    upsertJob(JSON.parse(event.data));
    render();
  });

  eventSource.addEventListener('remove', (event) => {
    const payload = JSON.parse(event.data);
    state.jobs.delete(payload.jobId);
    state.deliveredJobs.delete(payload.jobId);
    state.seededSettledJobs.delete(payload.jobId);
    render();
  });

  eventSource.addEventListener('error', () => {
    if (state.streamStatus !== 'reconnecting') {
      announce('Live updates were interrupted. Reconnecting now.', 'assertive');
    }
    state.streamStatus = 'reconnecting';
    render();
  });
}

function uploadFiles(files) {
  const uploadId = createUploadId();
  const uploadRecord = {
    error: null,
    fileCount: files.length,
    id: uploadId,
    label: files.length === 1 ? files[0].name : `${files[0].name} +${files.length - 1} more`,
    progress: 0,
    request: null,
    startedAt: Date.now(),
    status: 'preparing',
    totalBytes: files.reduce((sum, file) => sum + (file.size || 0), 0),
  };

  state.uploads.set(uploadId, uploadRecord);
  announce(`Uploading ${uploadRecord.label}.`);
  render();

  const formData = new FormData();
  const conversionOptions = normalizeClientConversionOptions(state.conversionOptions);
  files.forEach((file) => formData.append('files', file));
  formData.append('selectionMode', conversionOptions.selectionMode);
  formData.append('consoleId', conversionOptions.consoleId);
  formData.append('manualOutputProfile', conversionOptions.manualOutputProfile);

  const request = new XMLHttpRequest();
  uploadRecord.request = request;
  uploadRecord.status = 'uploading';
  render();

  request.open('POST', '/api/jobs');

  request.upload.addEventListener('progress', (event) => {
    const percent = event.lengthComputable ? Math.round((event.loaded / event.total) * 100) : 0;
    updateUpload(uploadId, {
      progress: percent,
      status: 'uploading',
    });
  });

  request.addEventListener('load', () => {
    if (request.status >= 200 && request.status < 300) {
      const payload = JSON.parse(request.responseText);
      if (payload.job) {
        upsertJob(payload.job);
      }
      state.uploads.delete(uploadId);
      render();
      return;
    }

    let errorMessage = 'The upload failed.';
    try {
      errorMessage = JSON.parse(request.responseText).error || errorMessage;
    } catch {}

    announce(`${uploadRecord.label}: ${errorMessage}`, 'assertive');
    updateUpload(uploadId, {
      error: errorMessage,
      progress: 0,
      status: 'failed',
    });
  });

  request.addEventListener('abort', () => {
    announce(`Upload ${uploadRecord.label} was stopped.`);
    updateUpload(uploadId, {
      progress: 0,
      status: 'cancelled',
    });
  });

  request.addEventListener('error', () => {
    announce(`Upload ${uploadRecord.label} failed because of a network error.`, 'assertive');
    updateUpload(uploadId, {
      error: 'Network error.',
      progress: 0,
      status: 'failed',
    });
  });

  request.send(formData);
}

async function cancelJob(jobId) {
  const job = state.jobs.get(jobId);
  if (!job) {
    return;
  }

  upsertJob(
    {
      ...job,
      message: 'Stopping the job...',
      progress: null,
      status: 'cancelling',
    },
    { announceChange: true },
  );
  render();

  const response = await fetch(`/api/jobs/${jobId}/cancel`, {
    method: 'POST',
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: 'Could not stop the job.' }));
    upsertJob({
      ...job,
      error: payload.error || 'Could not stop the job.',
      status: 'failed',
    });
    render();
  }
}

async function clearJob(jobId) {
  const job = state.jobs.get(jobId);
  const response = await fetch(`/api/jobs/${jobId}`, {
    method: 'DELETE',
  });

  if (!response.ok && response.status !== 204) {
    const payload = await response.json().catch(() => ({ error: 'Could not remove the job.' }));
    if (job) {
      upsertJob({
        ...job,
        error: payload.error || 'Could not remove the job.',
      });
      render();
    }
    return;
  }

  if (job) {
    announce(`Batch ${job.title} removed from history.`);
  }
  state.jobs.delete(jobId);
  state.deliveredJobs.delete(jobId);
  state.seededSettledJobs.delete(jobId);
  render();
}

uploadsList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-upload-action]');
  if (!button) {
    return;
  }

  const uploadId = button.getAttribute('data-upload-id');
  const action = button.getAttribute('data-upload-action');
  const upload = state.uploads.get(uploadId);
  if (!upload) {
    return;
  }

  if (action === 'cancel') {
    upload.request?.abort();
    return;
  }

  if (action === 'clear') {
    removeUpload(uploadId);
  }
});

jobsList.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-job-action]');
  if (!button) {
    return;
  }

  const jobId = button.getAttribute('data-job-id');
  const action = button.getAttribute('data-job-action');

  try {
    if (action === 'cancel') {
      await cancelJob(jobId);
    } else if (action === 'clear') {
      await clearJob(jobId);
    }
  } catch {
    const job = state.jobs.get(jobId);
    if (job) {
      upsertJob({
        ...job,
        error: action === 'cancel' ? 'Could not stop the job.' : 'Could not remove the job.',
      });
      render();
    }
  }
});

clearFinishedButton.addEventListener('click', async () => {
  const settledJobs = getSortedJobs().filter((job) => isJobSettled(job.status));

  for (const job of settledJobs) {
    try {
      await clearJob(job.id);
    } catch {}
  }
});

selectionModeButtons.forEach((button) => {
  button.addEventListener('click', () => {
    setConversionOptions({
      selectionMode: button.dataset.selectionMode,
    });
  });
});

consoleSelect.addEventListener('change', () => {
  setConversionOptions({
    consoleId: consoleSelect.value,
  });
});

manualOutputProfileSelect.addEventListener('change', () => {
  setConversionOptions({
    manualOutputProfile: manualOutputProfileSelect.value,
  });
});

fileInput.addEventListener('change', (event) => {
  const files = Array.from(event.target.files || []);
  if (!files.length) {
    return;
  }

  uploadFiles(files);
  fileInput.value = '';
});

dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    fileInput.click();
  }
});

['dragenter', 'dragover'].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add('is-over');
  });
});

['dragleave', 'drop'].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove('is-over');
  });
});

dropzone.addEventListener('drop', (event) => {
  const files = Array.from(event.dataTransfer.files || []);
  if (!files.length) {
    return;
  }

  uploadFiles(files);
});

render();
connectEventStream();
