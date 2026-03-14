const fs = require('node:fs/promises');
const path = require('node:path');

describe('frontend accessibility scaffolding', () => {
  test('exposes live regions and keyboard-operable dropzone markup', async () => {
    const html = await fs.readFile(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

    expect(html).toContain('id="announcer"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('id="alert-announcer"');
    expect(html).toContain('aria-live="assertive"');
    expect(html).toContain('role="button"');
    expect(html).toContain('tabindex="0"');
  });

  test('declares visible focus styles for interactive elements', async () => {
    const css = await fs.readFile(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');

    expect(css).toContain('.visually-hidden');
    expect(css).toContain('.button:focus-visible');
    expect(css).toContain('.dropzone:focus-visible');
    expect(css).toContain('.result-row:focus-visible');
  });
});
