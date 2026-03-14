const http = require('node:http');

const { createApp } = require('./src/app');
const { PORT } = require('./src/config');

async function main() {
  const app = await createApp();
  const server = http.createServer(app);

  server.requestTimeout = 0;
  server.headersTimeout = 0;

  server.listen(PORT, () => {
    console.log(`convertioCHD listening on http://localhost:${PORT}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
