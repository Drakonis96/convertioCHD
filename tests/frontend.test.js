const fs = require('node:fs/promises');
const path = require('node:path');

const { JSDOM } = require('jsdom');

class FakeEventSource {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    FakeEventSource.instances.push(this);
  }

  addEventListener(type, callback) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(callback);
    this.listeners.set(type, listeners);
  }

  emit(type, payload) {
    const listeners = this.listeners.get(type) || [];
    const event = payload === undefined ? {} : { data: JSON.stringify(payload) };
    listeners.forEach((listener) => listener(event));
  }

  close() {}
}

class FakeXMLHttpRequest {
  static instances = [];

  constructor() {
    this.listeners = new Map();
    this.uploadListeners = new Map();
    this.upload = {
      addEventListener: (type, callback) => {
        const listeners = this.uploadListeners.get(type) || [];
        listeners.push(callback);
        this.uploadListeners.set(type, listeners);
      },
    };
    this.status = 0;
    this.responseText = '';
    FakeXMLHttpRequest.instances.push(this);
  }

  addEventListener(type, callback) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(callback);
    this.listeners.set(type, listeners);
  }

  open(method, url) {
    this.method = method;
    this.url = url;
  }

  send(formData) {
    this.formData = formData;
  }

  emit(type, payload = {}) {
    const listeners = this.listeners.get(type) || [];
    listeners.forEach((listener) => listener(payload));
  }

  emitUploadProgress(loaded, total) {
    const listeners = this.uploadListeners.get('progress') || [];
    listeners.forEach((listener) =>
      listener({
        lengthComputable: true,
        loaded,
        total,
      }),
    );
  }

  respond(status, payload) {
    this.status = status;
    this.responseText = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.emit('load');
  }

  abort() {
    this.emit('abort');
  }
}

function buildLimits() {
  return {
    consoleOptions: [
      { defaultOutputProfile: 'auto', id: 'auto', label: 'Auto detect' },
      { defaultOutputProfile: 'cd', id: 'ps1', label: 'PlayStation' },
      { defaultOutputProfile: 'dvd', id: 'ps2', label: 'PlayStation 2' },
    ],
    maxConversionConcurrency: 3,
    maxExtractedBytes: 1024,
    maxExtractedBytesLabel: '1 KB',
    maxExtractedFiles: 10,
    maxFileSizeBytes: 1024,
    maxFileSizeLabel: '1 KB',
    manualOutputProfiles: [
      { command: 'createcd', id: 'cd', label: 'CD CHD' },
      { command: 'createdvd', id: 'dvd', label: 'DVD CHD' },
    ],
    maxTotalUploadBytes: 4096,
    maxTotalUploadBytesLabel: '4 KB',
    maxUploadFiles: 3,
  };
}

function buildJob(overrides = {}) {
  return {
    archive: null,
    completedAt: null,
    completedGroups: 0,
    conversionConcurrency: 2,
    createdAt: '2026-03-14T10:00:00.000Z',
    currentGroup: 1,
    detectedGroups: 2,
    error: null,
    events: [],
    failures: [],
    groupDiagnostics: [],
    groupNames: ['Alpha', 'Beta'],
    id: 'job-1',
    inputBytes: 4096,
    inputBytesLabel: '4 KB',
    inputCount: 2,
    message: 'Preparing Alpha',
    processingGroups: ['Alpha'],
    progress: 42,
    results: [],
    sourceNames: ['Alpha.bin', 'Alpha.cue'],
    startedAt: '2026-03-14T10:00:03.000Z',
    status: 'processing',
    title: 'Alpha +1 more',
    totalGroups: 2,
    updatedAt: '2026-03-14T10:00:05.000Z',
    ...overrides,
  };
}

async function bootFrontend(fetchImpl = vi.fn()) {
  FakeEventSource.instances = [];
  FakeXMLHttpRequest.instances = [];

  const html = await fs.readFile(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const script = await fs.readFile(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'http://localhost:5459/',
  });
  const { window } = dom;
  const downloads = [];

  window.EventSource = FakeEventSource;
  window.XMLHttpRequest = FakeXMLHttpRequest;
  window.fetch = fetchImpl;
  window.requestAnimationFrame = (callback) => {
    callback();
    return 1;
  };
  window.cancelAnimationFrame = () => {};
  window.HTMLAnchorElement.prototype.click = function click() {
    downloads.push(this.href);
  };

  window.eval(script);

  return {
    document: window.document,
    downloads,
    eventSource: FakeEventSource.instances[0],
    fetchMock: fetchImpl,
    window,
  };
}

describe('frontend interactions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    FakeEventSource.instances = [];
    FakeXMLHttpRequest.instances = [];
  });

  test('renders SSE snapshot data with diagnostics and concurrency details', async () => {
    const { document, eventSource } = await bootFrontend();

    eventSource.emit('open');
    eventSource.emit('snapshot', {
      jobs: [
        buildJob({
          completedGroups: 1,
          groupDiagnostics: [
            {
              confidence: 'warning',
              cueFile: 'Alpha.cue',
              files: ['Alpha.cue', 'Alpha.bin'],
              missingReferences: ['Alpha Track 02.bin'],
              name: 'Alpha',
              references: [
                {
                  confidence: 'high',
                  matchedFile: 'Alpha.bin',
                  reference: 'Alpha.bin',
                  score: 100,
                  strategy: 'exact_relative_path',
                },
                {
                  confidence: 'warning',
                  matchedFile: null,
                  reference: 'Alpha Track 02.bin',
                  score: -1,
                  strategy: 'missing',
                },
              ],
              type: 'cue_sheet',
              warnings: ['1 referenced file is missing from the batch.'],
            },
          ],
        }),
      ],
      limits: buildLimits(),
    });

    expect(document.querySelector('#stream-state').textContent).toContain('Live');
    expect(document.querySelector('#summary-grid').textContent).toContain('Needs Review');
    expect(document.querySelector('#jobs-list').textContent).toContain('Alpha Track 02.bin');
    expect(document.querySelector('#jobs-list').textContent).toContain('Workers');
    expect(document.querySelector('#jobs-list').textContent).toContain('1 / 2');
    expect(document.querySelector('[role="progressbar"]').getAttribute('aria-valuenow')).toBe('42');
  });

  test('handles file input uploads and moves the batch into the jobs board on success', async () => {
    const { document, eventSource, window } = await bootFrontend();
    const fileInput = document.querySelector('#file-input');
    const file = new window.File(['hello'], 'Game.bin', { type: 'application/octet-stream' });

    eventSource.emit('snapshot', {
      jobs: [],
      limits: buildLimits(),
    });

    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      value: [file],
    });
    fileInput.dispatchEvent(new window.Event('change', { bubbles: true }));

    expect(FakeXMLHttpRequest.instances).toHaveLength(1);
    FakeXMLHttpRequest.instances[0].emitUploadProgress(5, 10);
    expect(document.querySelector('#uploads-list').textContent).toContain('50% uploaded');

    FakeXMLHttpRequest.instances[0].respond(202, {
      job: buildJob({
        id: 'job-uploaded',
        title: 'Game',
      }),
      jobId: 'job-uploaded',
    });

    expect(document.querySelector('#uploads-list').textContent).toContain('No uploads in progress');
    expect(document.querySelector('#jobs-list').textContent).toContain('Game');
    expect(document.querySelector('#announcer').textContent).toContain('added to the queue');
  });

  test('switches between automatic and manual mode and sends the chosen options with each upload', async () => {
    const { document, eventSource, window } = await bootFrontend();
    const fileInput = document.querySelector('#file-input');
    const manualButton = document.querySelector('#manual-mode-button');
    const automaticButton = document.querySelector('#automatic-mode-button');
    const manualSelect = document.querySelector('#manual-output-profile-select');
    const consoleSelect = document.querySelector('#console-select');
    const file = new window.File(['hello'], 'Game.iso', { type: 'application/octet-stream' });

    eventSource.emit('snapshot', {
      jobs: [],
      limits: buildLimits(),
    });

    manualButton.click();
    expect(manualButton.classList.contains('is-active')).toBe(true);
    expect(document.querySelector('#manual-settings').classList.contains('hidden')).toBe(false);

    manualSelect.value = 'dvd';
    manualSelect.dispatchEvent(new window.Event('change', { bubbles: true }));

    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      value: [file],
    });
    fileInput.dispatchEvent(new window.Event('change', { bubbles: true }));

    expect(FakeXMLHttpRequest.instances).toHaveLength(1);
    expect(FakeXMLHttpRequest.instances[0].formData.get('selectionMode')).toBe('manual');
    expect(FakeXMLHttpRequest.instances[0].formData.get('manualOutputProfile')).toBe('dvd');

    automaticButton.click();
    consoleSelect.value = 'ps2';
    consoleSelect.dispatchEvent(new window.Event('change', { bubbles: true }));

    fileInput.dispatchEvent(new window.Event('change', { bubbles: true }));

    expect(FakeXMLHttpRequest.instances).toHaveLength(2);
    expect(FakeXMLHttpRequest.instances[1].formData.get('selectionMode')).toBe('automatic');
    expect(FakeXMLHttpRequest.instances[1].formData.get('consoleId')).toBe('ps2');
  });

  test('supports keyboard activation, stop actions, clearing finished jobs, and auto-download on completion', async () => {
    const fetchMock = vi.fn(async (url, options = {}) => {
      if (url.endsWith('/cancel')) {
        return {
          ok: true,
          status: 202,
          async json() {
            return { message: 'Stopping the job...', status: 'cancelling' };
          },
        };
      }

      return {
        ok: true,
        status: 204,
        async json() {
          return {};
        },
      };
    });
    const { document, downloads, eventSource, window } = await bootFrontend(fetchMock);
    const fileInput = document.querySelector('#file-input');
    const clickSpy = vi.spyOn(fileInput, 'click');

    eventSource.emit('snapshot', {
      jobs: [
        buildJob({
          id: 'job-active',
          title: 'Active batch',
        }),
        buildJob({
          completedAt: '2026-03-14T10:05:00.000Z',
          completedGroups: 2,
          id: 'job-finished',
          processingGroups: [],
          progress: 100,
          results: [
            {
              id: 'file-1',
              name: 'Done.chd',
              size: 1024,
              sizeLabel: '1 KB',
              url: '/api/jobs/job-finished/files/file-1',
            },
          ],
          status: 'completed',
          title: 'Finished batch',
          updatedAt: '2026-03-14T10:05:00.000Z',
        }),
      ],
      limits: buildLimits(),
    });

    dropzoneKeydown(document.querySelector('#dropzone'), window, 'Enter');
    expect(clickSpy).toHaveBeenCalledTimes(1);

    const stopButton = document.querySelector('[data-job-id="job-active"]');
    stopButton.click();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/job-active/cancel', { method: 'POST' });

    const clearFinishedButton = document.querySelector('#clear-finished-button');
    clearFinishedButton.click();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/job-finished', { method: 'DELETE' });

    eventSource.emit('job', buildJob({
      completedAt: '2026-03-14T10:10:00.000Z',
      completedGroups: 2,
      id: 'job-active',
      processingGroups: [],
      progress: 100,
      results: [
        {
          id: 'file-2',
          name: 'Active batch.chd',
          size: 2048,
          sizeLabel: '2 KB',
          url: '/api/jobs/job-active/files/file-2',
        },
      ],
      status: 'completed',
      title: 'Active batch',
      updatedAt: '2026-03-14T10:10:00.000Z',
    }));

    await new Promise((resolve) => window.setTimeout(resolve, 300));

    expect(downloads).toContain('http://localhost:5459/api/jobs/job-active/files/file-2');
    expect(document.querySelector('#announcer').textContent).not.toHaveLength(0);
  });
});

function dropzoneKeydown(dropzone, window, key) {
  dropzone.dispatchEvent(
    new window.KeyboardEvent('keydown', {
      bubbles: true,
      key,
    }),
  );
}
