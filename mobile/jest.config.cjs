const preset = require('jest-expo/jest-preset');

module.exports = {
  ...preset,
  haste: { ...preset.haste, defaultPlatform: 'android' },
  roots: ['<rootDir>/tests/components'],
  testMatch: ['<rootDir>/tests/components/**/*.component.test.tsx'],
  moduleNameMapper: {
    '^@/assets/(.*)$': '<rootDir>/assets/$1',
    '^@/(.*)$': '<rootDir>/src/$1',
    // protocol/ lives outside the app and has no node_modules: its compiled helpers come from here.
    '^@babel/runtime/(.*)$': '<rootDir>/node_modules/@babel/runtime/$1',
    ...preset.moduleNameMapper,
  },
  transform: {
    ...preset.transform,
    '\\.[jt]sx?$': '<rootDir>/tests/support/babel-transformer.cjs',
  },
  // reanimated and gesture-handler are native boundaries: their own Jest doubles stand in for the
  // UI thread and the gesture recognizers (tests/support/motion.ts and gestures.ts drive them).
  resolver: '<rootDir>/tests/support/resolver.cjs',
  setupFiles: ['<rootDir>/tests/support/env.cjs', ...preset.setupFiles, 'react-native-gesture-handler/jestSetup'],
  setupFilesAfterEnv: ['<rootDir>/tests/support/setup.ts'],
  cacheDirectory: '<rootDir>/.expo/jest-cache',
  watchman: false,
  collectCoverage: false,
};
