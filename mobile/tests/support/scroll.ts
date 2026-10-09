import { ScrollView } from 'react-native';

/** The RN preset already replaces the native imperative scrolling boundary. */
export const scrollToEnd = jest.mocked(ScrollView.prototype.scrollToEnd);
