import { createApp } from './app.js';
import { createRefundEventLog } from './refund-event-log.js';
import { createRefundEventSubscriber } from './refund-event-subscriber.js';

const enabledValue = process.env.SALESFORCE_REFUND_EVENTS_ENABLED ?? 'false';
if (!['true', 'false'].includes(enabledValue)) {
  throw new Error('SALESFORCE_REFUND_EVENTS_ENABLED must be true or false');
}

const refundEventLog = createRefundEventLog();
const refundEventSubscriber = createRefundEventSubscriber({
  eventLog: refundEventLog,
  enabled: enabledValue === 'true',
  loginUrl: process.env.SALESFORCE_LOGIN_URL,
  clientId: process.env.SALESFORCE_CLIENT_ID,
  clientSecret: process.env.SALESFORCE_CLIENT_SECRET,
});

const app = createApp({ refundEventLog });
const server = app.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => {
  console.log(`PayHub mock listening on port ${server.address().port}`);
  void refundEventSubscriber.start();
});

function shutdown() {
  refundEventSubscriber.stop();
  app.locals.dispose();
  server.close(() => process.exit(0));
  server.closeAllConnections();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
