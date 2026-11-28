export const isStoredFileIdentifier = (value: string) => false;
export const isPdfMimeType = (
  value: string,
  _fileName?: string,
  _url?: string
) => String(value || '').toLowerCase() === 'application/pdf';
export const getDeviceProfile = () => ({ isMobile: false, isTablet: false, isDesktop: true, isIOS: false });
