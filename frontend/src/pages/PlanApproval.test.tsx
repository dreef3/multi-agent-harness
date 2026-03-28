import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import PlanApproval from './PlanApproval';

const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

describe('PlanApproval', () => {
  beforeEach(() => vi.clearAllMocks());

  it('redirects to /projects/:id/chat with replace: true', () => {
    render(
      <MemoryRouter initialEntries={['/projects/proj-42/approval']}>
        <Routes>
          <Route path="/projects/:id/approval" element={<PlanApproval />} />
        </Routes>
      </MemoryRouter>
    );
    expect(mockNavigate).toHaveBeenCalledWith('/projects/proj-42/chat', { replace: true });
  });

  it('renders null (no visible output)', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/projects/proj-1/approval']}>
        <Routes>
          <Route path="/projects/:id/approval" element={<PlanApproval />} />
        </Routes>
      </MemoryRouter>
    );
    expect(container.firstChild).toBeNull();
  });
});
