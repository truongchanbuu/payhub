import { createApp } from './app.js';

const app = createApp();
const server = app.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => {
  console.log(`PayHub mock listening on port ${server.address().port}`);
});
