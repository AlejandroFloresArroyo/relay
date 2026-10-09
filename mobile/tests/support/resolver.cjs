const preset = require('@react-native/jest-preset/jest/resolver');
const worklets = require('react-native-worklets/jest/resolver');

// react-native-worklets runs its JS implementation under Jest only when `.native` files are skipped.
module.exports = (request, options) => worklets(request, { ...options, defaultResolver: (r, o) => preset(r, { ...o, defaultResolver: options.defaultResolver }) });
