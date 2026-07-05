'use strict';

const path = require('node:path');
const express = require('express');

const adminRouter = require('./src/routes/admin');
const publicRouter = require('./src/routes/public');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

// Stripe webhooks must see the raw body for signature verification, so this
// runs before the JSON parser (body-parser skips routes already parsed).
app.use('/webhooks/stripe', express.raw({ type: '*/*' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/assets', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

app.use('/admin', adminRouter);
app.use('/', publicRouter);

app.use((req, res) => res.status(404).send('Not found'));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Something went wrong. Please try again.');
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`PCA Parking Platform running on http://localhost:${PORT}`);
  console.log(`  Driver pages:  http://localhost:${PORT}/`);
  console.log(`  Admin console: http://localhost:${PORT}/admin`);
});
