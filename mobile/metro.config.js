// Lets the app import the shared wire contract, which lives outside this package.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, '../protocol')];

module.exports = config;
