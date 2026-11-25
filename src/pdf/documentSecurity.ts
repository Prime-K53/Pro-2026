import QRCode from 'qrcode';

const getCompanyNameFromStorage = (): string => {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return 'Printing System';

  const saved = localStorage.getItem('company_config');
  if (!saved) return 'Printing System';

  try {
    const parsed = JSON.parse(saved);
    return String(parsed?.companyName || '').trim() || 'Printing System';
  } catch {
    return 'Printing System';
  }
};

const formatSecurityTimestamp = (value?: string) => {
  const parsed = value ? new Date(value) : new Date();
  if (Number.isNaN(parsed.getTime())) return String(value || 'Unknown time');
  return parsed.toLocaleString();
};

const resolveDocumentNumber = (data: any) =>
  String(
    data?.number
    || data?.invoiceNumber
    || data?.orderNumber
    || data?.order_number
    || data?.receiptNumber
    || data?.quotationNumber
    || data?.quotationId
    || data?.dnNumber
    || data?.deliveryNoteNumber
    || data?.delivery_number
    || data?.paymentNumber
    || data?.paymentId
    || data?.contractNumber
    || data?.statementNumber
    || data?.exchangeNumber
    || data?.reportName
    || 'N/A'
  ).trim() || 'N/A';

const resolveCreatedBy = (data: any) =>
  String(
    data?.createdByName
    || data?.createdBy
    || data?.created_by
    || data?.cashierName
    || data?.cashier_name
    || data?.operatorName
    || data?.operator_name
    || 'System User'
  ).trim() || 'System User';

const resolveCreatedAt = (data: any) =>
  String(
    data?.createdAtIso
    || data?.createdAt
    || data?.created_at
    || data?.date
    || ''
  ).trim();

export const buildSecurityQrPayload = (data: any, companyName?: string) => {
  const docType = data?.documentType || data?.type || 'INVOICE';
  const verificationToken = (data as any).verificationToken;
  const verificationUrl = verificationToken
    ? `/verify?doc=${encodeURIComponent(docType)}&num=${encodeURIComponent(resolveDocumentNumber(data))}&tok=${encodeURIComponent(verificationToken)}`
    : null;
  if (verificationUrl) return verificationUrl;

  const resolvedCompanyName = String(companyName || '').trim() || getCompanyNameFromStorage();
  const documentNumber = resolveDocumentNumber(data);
  const createdOn = formatSecurityTimestamp(resolveCreatedAt(data));
  const createdBy = resolveCreatedBy(data);

  return `${resolvedCompanyName}, ${documentNumber}, created on ${createdOn}, by ${createdBy}`;
};

export const attachDocumentSecurity = async <T extends Record<string, any>>(data: T, companyName?: string): Promise<T> => {
  const payload = buildSecurityQrPayload(data, companyName);
  let securityQrCodeDataUrl: string | undefined;

  try {
    securityQrCodeDataUrl = await QRCode.toDataURL(payload, {
      errorCorrectionLevel: 'M',
      // 288px raster for the 76pt printed QR (~3.8px/pt, crisp in print) with
      // a full 4-module quiet zone — required for reliable phone-camera
      // scanning of dense verification URLs from paper or screen.
      margin: 4,
      width: 288,
    });
  } catch (error) {
    console.warn('[documentSecurity] Failed to generate QR code data URL.', error);
  }

  return {
    ...data,
    securityQrPayload: payload,
    securityQrCodeDataUrl,
  };
};
