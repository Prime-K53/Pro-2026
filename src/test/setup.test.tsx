import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { makeContract, makeAssessment } from './fixtures/contracts';

describe('test toolchain smoke', () => {
  it('renders a component into jsdom', () => {
    render(<div>Hello contract</div>);
    expect(screen.getByText('Hello contract')).toBeInTheDocument();
  });

  it('builds a valid contract fixture', () => {
    const c = makeContract();
    expect(c.assessments).toHaveLength(4);
    expect(c.totalAssessments).toBe(4);
    expect(makeAssessment().profit).toBe(12000);
  });
});