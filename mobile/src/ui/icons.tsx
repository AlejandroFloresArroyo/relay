import { usePalette } from '@/theme/ThemeProvider';
// Icon paths copied from the prototype's inline SVGs.
import Svg, { Path, Rect } from 'react-native-svg';

interface IconProps {
  size?: number;
  color?: string;
}

const round = { strokeLinecap: 'round' as const, fill: 'none' as const };

export function MicIcon({ size = 20, color }: IconProps) {
  const defaultColor = usePalette().K.ink;
  color = color ?? defaultColor;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Rect x={9} y={3} width={6} height={11} rx={3} stroke={color} strokeWidth={2.2} fill="none" />
      <Path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke={color} strokeWidth={2.2} {...round} />
    </Svg>
  );
}

/** Not in the prototype: shown instead of the mic once there is text to send. */
export function SendIcon({ size = 20, color }: IconProps) {
  const defaultColor = usePalette().K.ink;
  color = color ?? defaultColor;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M12 19V6M6 11l6-6 6 6" stroke={color} strokeWidth={2.2} strokeLinejoin="round" {...round} />
    </Svg>
  );
}

/** Fingerprint glyph from canvas 22b·1. */
export function FingerprintIcon({ size = 40, color }: IconProps) {
  const defaultColor = usePalette().K.ink;
  color = color ?? defaultColor;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M12 11v4M8.5 8.5a5 5 0 0 1 8.5 3.5v2M7 12a5 5 0 0 1 .5-2.2M6 17a10 10 0 0 0 1-5M10 20a14 14 0 0 0 2-6M15 19a18 18 0 0 0 1-4M4 9a9 9 0 0 1 16 0" stroke={color} strokeWidth={1.6} {...round} />
    </Svg>
  );
}
