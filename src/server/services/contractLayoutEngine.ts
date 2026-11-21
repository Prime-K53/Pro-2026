/**
 * @file contractLayoutEngine.ts
 * @description Renders an ERPDocument into a RenderModel using a LayoutBlueprint.
 *
 * Adapted from PrimeERPsystem/contracts/RenderModel.ts + LayoutBlueprint.ts.
 *
 * This module is ADDITIVE and feature-flagged: it is used only when a caller
 * explicitly requests `format=render-model` (or equivalent). The existing
 * React preview and documentsService JSON output are unaffected.
 *
 * The engine is intentionally minimal but sufficient for the contract
 * blueprint. It supports:
 *   - vertical / horizontal / stack containers
 *   - text, line, spacer, image, table nodes
 *   - {{path.to.value}} template substitution
 *   - page-break handling for flow sections
 *   - fixed header/footer repetition
 *
 * Limitations (acceptable for MVP):
 *   - No text wrapping inside fixed-width boxes (text overflows).
 *   - No image loading (image nodes become placeholders).
 *   - No font metrics; heights are estimated from font size.
 */

import type { ERPDocument } from '../../types/documentContract.ts';
import type {
  ContainerElement,
  ImageElement,
  LayoutBlueprint,
  LayoutElement,
  LayoutMargin,
  LayoutNode,
  LayoutSection,
  LayoutStyle,
  LineElement,
  TableElement,
  TextElement,
} from '../../types/layoutBlueprint.ts';
import type {
  RenderBox,
  RenderImage,
  RenderLine,
  RenderModel,
  RenderNode,
  RenderPage,
  RenderRect,
  RenderText,
} from '../../types/renderModel.ts';

/**
 * Page dimensions in mm for the supported page sizes.
 */
const PAGE_SIZES_MM: Record<string, { width: number; height: number }> = {
  A4: { width: 210, height: 297 },
  Letter: { width: 215.9, height: 279.4 },
};

/**
 * Resolves a {{path.to.value}} template against a context object.
 *
 * Supports dotted paths. Missing values resolve to empty string.
 */
function resolveTemplate(content: string, context: Record<string, unknown>): string {
  return content.replace(/\{\{([^}]+)\}\}/g, (_, path: string) => {
    const parts = path.trim().split('.');
    let current: unknown = context;
    for (const part of parts) {
      if (current == null || typeof current !== 'object') {
        return '';
      }
      current = (current as Record<string, unknown>)[part];
    }
    if (current == null) return '';
    if (typeof current === 'object') {
      // Money objects are rendered as their amount.
      const money = current as { amount?: unknown };
      if (typeof money.amount === 'string') return money.amount;
      return '';
    }
    return String(current);
  });
}

/**
 * Estimates the height of a text node in mm from its font size.
 * Rough heuristic: 1pt ≈ 0.3528mm, line height ≈ 1.2× font size.
 */
function estimateTextHeight(style: LayoutStyle | undefined, multiline = false): number {
  const fontSizePt = style?.fontSize ?? 10;
  const lineHeight = fontSizePt * 1.2 * 0.3528;
  return multiline ? lineHeight * 2 : lineHeight;
}

/**
 * Creates a RenderText node.
 */
function createTextElement(
  content: string,
  box: RenderBox,
  style: LayoutStyle
): RenderText {
  return { type: 'text', content, box, style };
}

/**
 * Creates a RenderLine node.
 */
function createLineElement(box: RenderBox, style: LayoutStyle, thickness: number): RenderLine {
  return { type: 'line', box, style, thickness };
}

/**
 * Creates a RenderRect placeholder (used for containers that need a background).
 */
function createRectElement(box: RenderBox, style: LayoutStyle): RenderRect {
  return { type: 'rect', box, style };
}

/**
 * Creates a RenderImage placeholder.
 */
function createImageElement(box: RenderBox, style: LayoutStyle, url: string): RenderImage {
  return { type: 'image', box, style, url };
}

/**
 * Resolves the page dimensions from the blueprint metadata.
 */
function resolvePageDimensions(blueprint: LayoutBlueprint): { width: number; height: number } {
  const { pageSize, orientation } = blueprint.metadata;
  if (typeof pageSize === 'string') {
    const size = PAGE_SIZES_MM[pageSize] ?? PAGE_SIZES_MM.A4;
    return orientation === 'landscape' ? { width: size.height, height: size.width } : size;
  }
  return { width: pageSize.width, height: pageSize.height };
}

/**
 * Renders a table node into absolute-positioned render nodes.
 *
 * Returns the elements plus the consumed height.
 */
function renderTable(
  table: TableElement & { dataSource?: string },
  context: Record<string, unknown>,
  x: number,
  y: number,
  availableWidth: number,
  unit: 'mm' | 'pt' | 'px'
): { elements: RenderNode[]; consumedHeight: number } {
  const elements: RenderNode[] = [];

  let rows: unknown[] = [];
  const dataSource = table.dataSource;
  if (dataSource) {
    const parts = dataSource.split('.');
    let current: unknown = context;
    for (const part of parts) {
      if (current == null || typeof current !== 'object') break;
      current = (current as Record<string, unknown>)[part];
    }
    if (Array.isArray(current)) rows = current;
  } else if (Array.isArray((context as { items?: unknown }).items)) {
    rows = (context as { items: unknown[] }).items;
  } else if (Array.isArray((context as { lines?: unknown }).lines)) {
    rows = (context as { lines: unknown[] }).lines;
  }

  const columnCount = table.columns.length;
  const colWidth =
    columnCount > 0
      ? table.columns.reduce(
          (sum, col) => sum + (typeof col.width === 'number' ? col.width : availableWidth / columnCount),
          0
        ) || availableWidth
      : availableWidth;

  let currentY = y;
  const headerHeight = table.showHeaders ? estimateTextHeight(undefined, false) + 2 : 0;

  if (table.showHeaders) {
    let currentX = x;
    for (const col of table.columns) {
      const w = typeof col.width === 'number' ? col.width : availableWidth / columnCount;
      elements.push(
        createTextElement(col.header, { x: currentX, y: currentY, width: w, height: headerHeight }, {
          fontSize: 9,
          fontWeight: 'bold',
          color: '#64748b',
          textAlign: col.align ?? 'left',
        })
      );
      currentX += w;
    }
    currentY += headerHeight;
  }

  for (const row of rows) {
    let currentX = x;
    const rowContext = { ...context, item: row };
    const rowHeight = estimateTextHeight(undefined, false) + 2;
    // The blueprint provides a single template row; instantiate it per data row.
    const templateRow = table.rows?.[0];
    const templateCells = templateRow?.cells ?? {};
    for (const col of table.columns) {
      const w = typeof col.width === 'number' ? col.width : availableWidth / columnCount;
      const cellNode = templateCells[col.id];
      if (cellNode && cellNode.type === 'text') {
        const content = resolveTemplate(cellNode.content, rowContext);
        elements.push(
          createTextElement(content, { x: currentX, y: currentY, width: w, height: rowHeight }, {
            ...cellNode.style,
            textAlign: col.align ?? cellNode.style?.textAlign ?? 'left',
          })
        );
      }
      currentX += w;
    }
    currentY += rowHeight;
  }

  return { elements, consumedHeight: currentY - y };
}

/**
 * Renders a single layout node and its children.
 *
 * Returns the produced render elements plus the consumed height.
 */
function renderNode(
  node: LayoutNode,
  context: Record<string, unknown>,
  x: number,
  y: number,
  availableWidth: number,
  availableHeight: number,
  unit: 'mm' | 'pt' | 'px'
): { elements: RenderNode[]; consumedHeight: number } {
  const elements: RenderNode[] = [];
  const style = node.style ?? {};

  switch (node.type) {
    case 'spacer': {
      const h = typeof node.height === 'number' ? node.height : 5;
      return { elements, consumedHeight: h };
    }

    case 'text': {
      const text = node as TextElement;
      const content = resolveTemplate(text.content, context);
      const h = typeof text.height === 'number' ? text.height : estimateTextHeight(style, text.multiline);
      const w = typeof text.width === 'number' ? text.width : availableWidth;
      elements.push(createTextElement(content, { x, y, width: w, height: h }, style));
      return { elements, consumedHeight: h };
    }

    case 'line': {
      const line = node as LineElement;
      const thickness = line.thickness;
      const isHorizontal = line.orientation === 'horizontal';
      const box: RenderBox = isHorizontal
        ? { x, y, width: availableWidth, height: thickness }
        : { x, y, width: thickness, height: availableHeight };
      elements.push(createLineElement(box, { ...style, color: line.color }, thickness));
      return { elements, consumedHeight: isHorizontal ? thickness : 0 };
    }

    case 'image': {
      const image = node as ImageElement;
      const w = typeof image.width === 'number' ? image.width : 40;
      const h = typeof image.height === 'number' ? image.height : 40;
      elements.push(createImageElement({ x, y, width: w, height: h }, style, image.url));
      return { elements, consumedHeight: h };
    }

    case 'table': {
      const table = node as TableElement;
      const { elements: tableElements, consumedHeight } = renderTable(
        table,
        context,
        x,
        y,
        availableWidth,
        unit
      );
      return { elements: tableElements, consumedHeight };
    }

    case 'container': {
      const container = node as ContainerElement;
      const layout = container.layout ?? 'vertical';
      const children = container.children ?? [];

      if (layout === 'horizontal') {
        let currentX = x;
        let maxHeight = 0;

        // First pass: allocate explicit widths.
        const widths: number[] = new Array(children.length).fill(0);
        const autoIndices: number[] = [];
        for (let i = 0; i < children.length; i++) {
          const child = children[i];
          if (typeof child.width === 'number') {
            widths[i] = child.width;
          } else if (child.width === '100%') {
            widths[i] = availableWidth;
          } else {
            autoIndices.push(i);
          }
        }

        // Compute remaining width for auto/flex children.
        const usedWidth = widths.reduce((sum, w) => sum + w, 0);
        const remainingWidth = Math.max(0, availableWidth - usedWidth);
        const totalFlex = autoIndices.reduce((sum, i) => sum + (children[i].flex ?? 0), 0);

        if (autoIndices.length > 0) {
          if (totalFlex > 0) {
            for (const i of autoIndices) {
              const flex = children[i].flex ?? 0;
              widths[i] = remainingWidth * (flex / totalFlex);
            }
          } else {
            const equalWidth = remainingWidth / autoIndices.length;
            for (const i of autoIndices) {
              widths[i] = equalWidth;
            }
          }
        }

        for (let i = 0; i < children.length; i++) {
          const child = children[i];
          const w = widths[i];
          const childResult = renderNode(child, context, currentX, y, w, availableHeight, unit);
          elements.push(...childResult.elements);
          currentX += w;
          maxHeight = Math.max(maxHeight, childResult.consumedHeight);
        }
        return { elements, consumedHeight: maxHeight };
      }

      // vertical or stack: render children sequentially
      let currentY = y;
      for (const child of children) {
        const childResult = renderNode(child, context, x, currentY, availableWidth, availableHeight - (currentY - y), unit);
        elements.push(...childResult.elements);
        currentY += childResult.consumedHeight;
      }
      return { elements, consumedHeight: currentY - y };
    }

    default:
      return { elements, consumedHeight: 0 };
  }
}

/**
 * Renders a fixed section (header/footer) on a page.
 */
function renderFixedSection(
  section: LayoutSection,
  doc: ERPDocument<unknown, unknown>,
  pageWidth: number,
  pageHeight: number,
  margins: LayoutMargin
): RenderNode[] {
  const context = buildContext(doc);
  const x = margins.left;
  const y = section.role === 'header' ? margins.top : pageHeight - margins.bottom - 40;
  const width = pageWidth - margins.left - margins.right;
  const height = 40;
  const result = renderNode(section.content, context, x, y, width, height, 'mm');
  return result.elements;
}

/**
 * Builds the template context from a document.
 */
function buildContext(doc: ERPDocument<unknown, unknown>): Record<string, unknown> {
  const currency = (doc.payload.totals as { currency?: string })?.currency ?? 'ZMW';
  return {
    identity: doc.identity,
    lifecycle: doc.lifecycle,
    payload: doc.payload,
    metadata: doc.metadata,
    links: doc.links,
    currency,
    hash: doc.hash,
  };
}

/**
 * Renders the full document into a RenderModel.
 *
 * This is the main entry point for the layout engine.
 */
export function renderDocument(
  doc: ERPDocument<unknown, unknown>,
  blueprint: LayoutBlueprint
): RenderModel {
  const pageDims = resolvePageDimensions(blueprint);
  const margins = blueprint.metadata.margins;
  const contentWidth = pageDims.width - margins.left - margins.right;
  const contentHeight = pageDims.height - margins.top - margins.bottom;

  const pages: RenderPage[] = [];
  let currentPageElements: RenderNode[] = [];
  let currentY = margins.top;
  let pageNumber = 1;

  const newPage = () => {
    if (currentPageElements.length > 0) {
      pages.push({
        pageNumber,
        width: pageDims.width,
        height: pageDims.height,
        unit: blueprint.metadata.unit,
        elements: currentPageElements,
      });
      pageNumber++;
    }
    currentPageElements = [];
    currentY = margins.top;

    // Render fixed header/footer for this page.
    for (const section of blueprint.fixedSections) {
      if (
        section.repeat === 'every-page' ||
        (section.repeat === 'first-page' && pageNumber === 1) ||
        (section.repeat === 'last-page' && false) // last-page handling deferred
      ) {
        const fixed = renderFixedSection(section, doc, pageDims.width, pageDims.height, margins);
        currentPageElements.push(...fixed);
      }
    }
  };

  newPage();

  const context = buildContext(doc);

  for (const flowSection of blueprint.flowSections) {
    for (const element of flowSection.elements) {
      const result = renderNode(element, context, margins.left, currentY, contentWidth, contentHeight - (currentY - margins.top), blueprint.metadata.unit);
      const elementHeight = result.consumedHeight;

      if (currentY + elementHeight > pageDims.height - margins.bottom && currentPageElements.length > 0) {
        newPage();
        // Re-render the element on the new page.
        const retry = renderNode(element, context, margins.left, currentY, contentWidth, contentHeight, blueprint.metadata.unit);
        currentPageElements.push(...retry.elements);
        currentY += retry.consumedHeight;
      } else {
        currentPageElements.push(...result.elements);
        currentY += elementHeight;
      }
    }
  }

  // Push the final page.
  if (currentPageElements.length > 0 || pages.length === 0) {
    pages.push({
      pageNumber,
      width: pageDims.width,
      height: pageDims.height,
      unit: blueprint.metadata.unit,
      elements: currentPageElements,
    });
  }

  const security = blueprint.metadata.security
    ? {
        watermark: blueprint.metadata.security.watermark
          ? {
              text: blueprint.metadata.security.watermark,
              opacity: 0.08,
              angle: 45,
            }
          : undefined,
        isFinalized: doc.lifecycle.state === 'FINALIZED' || doc.lifecycle.state === 'CANCELLED',
      }
    : undefined;

  return {
    totalPages: pages.length,
    pages,
    security,
    metadata: {
      generatedAt: new Date().toISOString(),
      title: blueprint.metadata.title,
      documentType: blueprint.metadata.documentType,
    },
  };
}