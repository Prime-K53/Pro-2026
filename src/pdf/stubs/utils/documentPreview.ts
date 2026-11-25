export const isStoredFileIdentifier = (value: string) => false;
export const isPdfMimeType = (value: string) => String(value || '').toLowerCase() === 'application/pdf';
export const getDeviceProfile = () => ({ isMobile: false, isTablet: false, isDesktop: true });