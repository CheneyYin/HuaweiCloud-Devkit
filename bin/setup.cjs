#!/usr/bin/env node
'use strict';
const path = require('node:path');
const fileUrl = require('node:url').pathToFileURL(
  path.join(__dirname, '..', 'plugins', 'huaweicloud-core', 'dist', 'setup-cli.mjs'),
).href;

import(fileUrl).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
