interface Launcher {
  platform: string;
  openURL: (url: string) => Promise<unknown>;
}

/** Only opens Tailscale's UI; never changes the VPN configuration or connection. */
export async function openTailscale(launcher?: Launcher): Promise<boolean> {
  try {
    if (!launcher) {
      const { Linking, Platform } = await import('react-native');
      launcher = { platform: Platform.OS, openURL: (url) => Linking.openURL(url) };
    }
    if (launcher.platform !== 'android') return false;
    await launcher.openURL('tailscale://navigate');
    return true;
  } catch {
    return false;
  }
}
