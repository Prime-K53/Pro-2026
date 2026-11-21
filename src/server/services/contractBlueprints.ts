/**
 * @file contractBlueprints.ts
 * @description Typed contract blueprint registry.
 *
 * The JSON files in contracts/blueprints/ are the source of truth for the
 * blueprint structure and JSON Schema. This module exports them as typed
 * constants so the server-side layout engine can consume them without
 * depending on runtime JSON imports.
 */

import type { LayoutBlueprint } from '../../types/layoutBlueprint.ts';

/**
 * Classic A4 contract blueprint.
 *
 * Mirrors contracts/blueprints/contract.prime.classic.json.
 */
export const CONTRACT_PRIME_CLASSIC_BLUEPRINT: LayoutBlueprint = {
  metadata: {
    id: 'contract.prime.classic',
    title: 'Prime Classic Printing Contract',
    documentType: 'PRINTING_CONTRACT',
    pageSize: 'A4',
    orientation: 'portrait',
    unit: 'mm',
    margins: { top: 20, right: 20, bottom: 20, left: 20 },
  },
  fixedSections: [
    {
      id: 'header',
      role: 'header',
      repeat: 'every-page',
      content: {
        type: 'container',
        layout: 'horizontal',
        children: [
          {
            type: 'container',
            layout: 'vertical',
            flex: 1,
            children: [
              {
                type: 'text',
                content: 'PRINTING CONTRACT',
                style: { fontSize: 26, fontWeight: 'bold', color: '#0f172a' },
              },
              { type: 'spacer', height: 6 },
              {
                type: 'container',
                layout: 'horizontal',
                children: [
                  { type: 'text', content: 'Contract No:', width: 38, style: { fontSize: 10, color: '#64748b', fontWeight: '600' } },
                  { type: 'text', content: '{{identity.sequenceId}}', style: { fontSize: 13, fontWeight: '600', color: '#1e293b' } },
                ],
              },
              {
                type: 'container',
                layout: 'horizontal',
                children: [
                  { type: 'text', content: 'Academic Year:', width: 38, style: { fontSize: 10, color: '#64748b', fontWeight: '600' } },
                  { type: 'text', content: '{{payload.header.academicYear}}', style: { fontSize: 13, color: '#1e293b' } },
                ],
              },
              {
                type: 'container',
                layout: 'horizontal',
                children: [
                  { type: 'text', content: 'Status:', width: 38, style: { fontSize: 10, color: '#64748b', fontWeight: '600' } },
                  { type: 'text', content: '{{lifecycle.state}}', style: { fontSize: 13, color: '#1e293b' } },
                ],
              },
            ],
          },
        ],
      },
    },
    {
      id: 'footer',
      role: 'footer',
      repeat: 'every-page',
      content: {
        type: 'container',
        layout: 'vertical',
        style: {
          padding: { top: 12, right: 0, bottom: 0, left: 0 },
          border: { width: 0.5, style: 'solid', color: '#e2e8f0', edges: ['top'] },
        },
        children: [
          {
            type: 'text',
            content: 'Generated from Printing Management System',
            style: { fontSize: 9, textAlign: 'center', color: '#94a3b8' },
          },
        ],
      },
    },
  ],
  flowSections: [
    {
      id: 'school-section',
      elements: [
        { type: 'spacer', height: 16 },
        {
          type: 'text',
          content: 'SCHOOL / CUSTOMER',
          style: { fontSize: 10, fontWeight: 'bold', color: '#64748b', padding: { bottom: 4, top: 0, right: 0, left: 0 } },
        },
        { type: 'text', content: '{{payload.header.title}}', style: { fontSize: 18, fontWeight: 'bold', color: '#0f172a' } },
        {
          type: 'container',
          layout: 'horizontal',
          children: [
            { type: 'text', content: 'Period:', width: 30, style: { fontSize: 11, color: '#64748b' } },
            { type: 'text', content: '{{payload.header.startDate}} → {{payload.header.endDate}}', style: { fontSize: 11, color: '#1e293b' } },
          ],
        },
        { type: 'spacer', height: 18 },
      ],
    },
    {
      id: 'assessments-section',
      elements: [
        {
          type: 'table',
          dataSource: 'payload.lines',
          showHeaders: true,
          columns: [
            { id: 'assessmentNumber', header: 'No.', width: 12, align: 'right' },
            { id: 'label', header: 'Assessment', width: 'auto', align: 'left' },
            { id: 'scheduledDate', header: 'Scheduled', width: 28, align: 'left' },
            { id: 'agreedAmount', header: 'Agreed Amount', width: 32, align: 'right' },
            { id: 'status', header: 'Status', width: 22, align: 'left' },
          ],
          rows: [
            {
              cells: {
                assessmentNumber: { type: 'text', content: '{{item.assessmentNumber}}', style: { fontSize: 11, textAlign: 'right', color: '#1e293b' } },
                label: { type: 'text', content: '{{item.label}}', style: { fontSize: 11, color: '#1e293b' } },
                scheduledDate: { type: 'text', content: '{{item.scheduledDate}}', style: { fontSize: 11, color: '#334155' } },
                agreedAmount: { type: 'text', content: '{{currency}}{{item.agreedAmount.amount}}', style: { fontSize: 11, textAlign: 'right', color: '#1e293b' } },
                status: { type: 'text', content: '{{item.status}}', style: { fontSize: 11, color: '#334155' } },
              },
            },
          ],
          style: { border: { width: 0.5, style: 'solid', color: '#f1f5f9', edges: ['bottom'] } },
        },
      ],
    },
    {
      id: 'totals-section',
      elements: [
        { type: 'spacer', height: 14 },
        {
          type: 'container',
          layout: 'horizontal',
          children: [
            { type: 'spacer', flex: 1 },
            {
              type: 'container',
              layout: 'vertical',
              width: 90,
              children: [
                {
                  type: 'container',
                  layout: 'horizontal',
                  children: [
                    { type: 'text', content: 'Total Prepaid', flex: 1, style: { fontSize: 12, color: '#64748b' } },
                    { type: 'text', content: '{{currency}}{{payload.totals.grandTotal.amount}}', style: { fontSize: 13, fontWeight: '600', textAlign: 'right', color: '#1e293b' } },
                  ],
                },
                {
                  type: 'container',
                  layout: 'horizontal',
                  children: [
                    { type: 'text', content: 'Remaining Balance', flex: 1, style: { fontSize: 12, color: '#64748b' } },
                    { type: 'text', content: '{{currency}}{{payload.header.remainingBalance.amount}}', style: { fontSize: 13, textAlign: 'right', color: '#1e293b' } },
                  ],
                },
                { type: 'line', orientation: 'horizontal', thickness: 1, color: '#f1f5f9', style: { padding: { top: 6, right: 0, bottom: 6, left: 0 } } },
                {
                  type: 'container',
                  layout: 'horizontal',
                  children: [
                    { type: 'text', content: 'ALLOCATED', flex: 1, style: { fontSize: 13, fontWeight: 'bold', color: '#0f172a' } },
                    { type: 'text', content: '{{currency}}{{payload.totals.subtotal.amount}}', style: { fontSize: 14, fontWeight: 'bold', textAlign: 'right', color: '#0f172a' } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

/**
 * Registry of available contract blueprints.
 */
export const CONTRACT_BLUEPRINTS: Record<string, LayoutBlueprint> = {
  'contract.prime.classic': CONTRACT_PRIME_CLASSIC_BLUEPRINT,
};