export interface CompanyConfig {
  companyName?: string;
  addressLine1?: string;
  city?: string;
  country?: string;
  phone?: string;
  email?: string;
  website?: string;
  companyWebsite?: string;
  logo?: string;
  logoBase64?: string;
  signature?: string;
  signatureBase64?: string;
  footer?: string;
  receiptFooter?: string;
  currencySymbol?: string;
  invoiceTemplates?: InvoiceTemplatesConfig;
  transactionSettings?: {
    defaultPaymentTermsDays?: number;
    pos?: { receiptFooter?: string };
  };
}

export interface InvoiceTemplatesConfig {
  engine?: string;
  accentColor?: string;
  companyNameFontSize?: number;
  bodyFontSize?: number;
  fontFamily?: string;
  logoWidth?: number;
  showCompanyLogo?: boolean;
  showPaymentTerms?: boolean;
  showDueDate?: boolean;
  showOutstandingAndWalletBalances?: boolean;
  showAccountSummary?: boolean;
  showConversionHistory?: boolean;
}