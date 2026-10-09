// Synthetic device key. It only exists in the native runtime; the Android suite searches the
// WebView heap for it to prove the DOM side never receives it.
export const LAB_DEVICE_KEY = 'relay-lab-device-key-3f9c1e7a5b2d4068';

// Plain-text canary the native side writes to the app's private files/ directory, standing in
// for any secret stored outside SecureStore. The suite checks whether the DOM page can read it.
export const LAB_FILE_CANARY_NAME = 'relay-lab-canary.txt';
export const LAB_FILE_CANARY = 'relay-lab-file-canary-8d41b6e2c07a9f35';
