/**
 * @file layoutBlueprint.ts
 * @description Renderer-agnostic layout blueprint for ERP documents.
 *
 * Adapted from PrimeERPsystem/contracts/LayoutBlueprint.ts.
 *
 * This module is ADDITIVE: it is used only by the new contract layout engine
 * (contractLayoutEngine.ts). The existing React preview and the existing
 * documentsService output are unaffected.
 */

export type LayoutUnit = 'mm' | 'pt' | 'px';

export interface LayoutDimensions {
  width: number;
  height: number;
  unit: LayoutUnit;
}

export interface LayoutMargin {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface LayoutStyle {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: 'normal' | 'bold' | '500' | '600';
  color?: string;
  backgroundColor?: string;
  textAlign?: 'left' | 'center' | 'right' | 'justify';
  border?: {
    width: number;
    style: 'solid' | 'dashed' | 'dotted';
    color: string;
    edges: Array<'top' | 'bottom' | 'left' | 'right'>;
  };
  padding?: LayoutMargin;
}

export interface LayoutElement {
  type: 'container' | 'text' | 'image' | 'line' | 'table' | 'spacer';
  id?: string;
  style?: LayoutStyle;
  flex?: number;
  width?: number | 'auto' | '100%';
  height?: number | 'auto';
  condition?: {
    field: string;
    operator: 'eq' | 'neq' | 'gt' | 'lt' | 'exists';
    value?: unknown;
  };
}

export interface SpacerElement extends LayoutElement {
  type: 'spacer';
  height?: number;
}

export interface ContainerElement extends LayoutElement {
  type: 'container';
  layout: 'vertical' | 'horizontal' | 'stack';
  children: LayoutNode[];
}

export interface TextElement extends LayoutElement {
  type: 'text';
  content: string;
  multiline?: boolean;
}

export interface LineElement extends LayoutElement {
  type: 'line';
  orientation: 'horizontal' | 'vertical';
  thickness: number;
  color: string;
}

export interface TableElement extends LayoutElement {
  type: 'table';
  dataSource?: string;
  columns: Array<{
    id: string;
    header: string;
    width: number | 'auto';
    align?: 'left' | 'center' | 'right';
  }>;
  rows: Array<{
    cells: Record<string, LayoutNode>;
  }>;
  showHeaders: boolean;
}

export interface ImageElement extends LayoutElement {
  type: 'image';
  url: string;
  alt?: string;
  fit?: 'contain' | 'cover' | 'fill';
}

export type LayoutNode =
  | ContainerElement
  | TextElement
  | ImageElement
  | LineElement
  | TableElement
  | SpacerElement;

export interface LayoutSection {
  id: string;
  role: 'header' | 'footer' | 'content' | 'watermark';
  repeat: 'every-page' | 'first-page' | 'last-page' | 'none';
  content: LayoutNode;
}

export interface LayoutBlueprintMetadata {
  id: string;
  title: string;
  documentType: string;
  pageSize: 'A4' | 'Letter' | LayoutDimensions;
  orientation: 'portrait' | 'landscape';
  margins: LayoutMargin;
  unit: LayoutUnit;
  security?: {
    watermark?: string;
    showDigitalSignaturePlaceholder?: boolean;
  };
}

export interface LayoutBlueprint {
  metadata: LayoutBlueprintMetadata;
  fixedSections: LayoutSection[];
  flowSections: Array<{
    id: string;
    elements: LayoutNode[];
    allowPageBreakInside?: boolean;
  }>;
}