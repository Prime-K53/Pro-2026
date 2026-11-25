import React, { useMemo } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { PreviewModal } from '../../pdf/PreviewModal';
import { mapPreviewModelToPrimeDoc } from '../../pdf/previewModelMapper';
import { DocumentPreviewModal } from './DocumentPreviewModal';

/**
 * PrimeDocumentPreviewModal
 *
 * Bridges the app's DocumentPreviewModel (set via openDocumentPreview) to the
 * real PrimeERPsystem PreviewModal, which renders the actual PrimeDocument PDF
 * (invoices, quotations, receipts, printing contracts, statements, etc.).
 *
 * Attachments / stored files keep the legacy DocumentPreviewModal, which owns
 * the vault file viewer.
 */
export const PrimeDocumentPreviewModal: React.FC = () => {
  const { previewDocument, closeDocumentPreview } = useAccounting();

  const mapped = useMemo(() => {
    if (!previewDocument) return null;
    return mapPreviewModelToPrimeDoc(previewDocument);
  }, [previewDocument]);

  // Stored files / attachments keep the legacy viewer.
  if (previewDocument && previewDocument.kind === 'attachment') {
    return <DocumentPreviewModal />;
  }

  return (
    <PreviewModal
      isOpen={!!previewDocument && !!mapped}
      onClose={closeDocumentPreview}
      type={mapped?.type}
      data={mapped?.data ?? null}
      title={previewDocument?.title}
    />
  );
};