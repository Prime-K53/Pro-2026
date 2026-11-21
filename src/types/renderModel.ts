/**
 * @file renderModel.ts
 * @description Absolute-coordinate render tree produced by the layout engine.
 *
 * Adapted from PrimeERPsystem/contracts/RenderModel.ts.
 *
 * This module is ADDITIVE: it is produced only by the new contract layout
 * engine (contractLayoutEngine.ts). Existing consumers are unaffected.
 */

import type { LayoutStyle, LayoutUnit } from './layoutBlueprint.ts';

export interface RenderBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RenderElement {
  type: 'text' | 'image' | 'line' | 'rect';
  box: RenderBox;
  style: LayoutStyle;
}

export interface RenderText extends RenderElement {
  type: 'text';
  content: string;
}

export interface RenderLine extends RenderElement {
  type: 'line';
  thickness: number;
}

export interface RenderRect extends RenderElement {
  type: 'rect';
}

export interface RenderImage extends RenderElement {
  type: 'image';
  url: string;
}

export type RenderNode = RenderText | RenderImage | RenderLine | RenderRect;

export interface RenderPage {
  pageNumber: number;
  width: number;
  height: number;
  unit: LayoutUnit;
  elements: RenderNode[];
}

export interface RenderSecurity {
  watermark?: {
    text: string;
    opacity: number;
    angle: number;
  };
  signature?: {
    signerName: string;
    signedAt: string;
    hash: string;
    qrCodeContent?: string;
  };
  isFinalized: boolean;
}

export interface RenderMetadata {
  generatedAt: string;
  title: string;
  documentType: string;
}

export interface RenderModel {
  totalPages: number;
  pages: RenderPage[];
  security?: RenderSecurity;
  metadata: RenderMetadata;
}