/**
 * Desktop platform stub.
 *
 * The application runs as a PWA, so there is no Tauri/Electron host. These
 * members exist so the PDF preview code paths type-check and degrade cleanly:
 * every call reports "not available" instead of throwing.
 */
export interface PdfWriteResult {
  success: boolean;
  path: string;
  error?: string;
}

export interface PdfReadResult {
  success: boolean;
  data?: ArrayBuffer;
  error?: string;
}

export const platform = {
  isDesktop: false,
  type: 'web' as 'web' | 'tauri' | 'electron',
  api: {
    log: (_data: any) => {},
    writeTempPdf: async (_bytes: number[], _name: string): Promise<PdfWriteResult> => ({
      success: false,
      path: '',
      error: 'Desktop temp-file writes are not available in the web build.',
    }),
    getPdfPreviewUrl: (_path: string): string | null => null,
    readPdfFile: async (_path: string): Promise<PdfReadResult> => ({
      success: false,
      error: 'Desktop file reads are not available in the web build.',
    }),
    cleanupTempPdf: async (_path: string): Promise<void> => {},
    openPdfWithSystemViewer: async (_path: string): Promise<boolean> => false,
  },
};