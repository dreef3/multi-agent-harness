import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import Execution from './Execution';

vi.mock('../lib/api', () => ({
  api: {
    projects: {
      agents: vi.fn().mockResolvedValue([]),
    },
  },
}));

vi.mock('../lib/ws', () => ({
  wsClient: {
    setProjectId: vi.fn(),
    connect: vi.fn(),
    onMessage: vi.fn(() => () => {}),
    disconnect: vi.fn(),
  },
}));

vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
  ok: false,
  json: async () => [],
} as Response));

function renderExecution() {
  return render(
    <MemoryRouter initialEntries={['/project/test-id/execute']}>
      <Routes>
        <Route path="/project/:id/execute" element={<Execution />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('AgentPicker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders a trigger button showing the selected agent label', async () => {
    renderExecution();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Planning Agent/i })).toBeInTheDocument();
    });
  });

  it('opens dropdown when trigger is clicked', async () => {
    renderExecution();
    const trigger = await screen.findByRole('button', { name: /Planning Agent/i });
    fireEvent.click(trigger);
    // The dropdown list shows the agent label as a list item button
    const allPlanningButtons = screen.getAllByText('Planning Agent');
    expect(allPlanningButtons.length).toBeGreaterThanOrEqual(2); // trigger + list item
  });

  it('closes dropdown when clicking outside', async () => {
    renderExecution();
    const trigger = await screen.findByRole('button', { name: /Planning Agent/i });
    fireEvent.click(trigger); // open
    const countOpen = screen.getAllByText('Planning Agent').length;
    expect(countOpen).toBeGreaterThanOrEqual(2);

    fireEvent.mouseDown(document.body); // outside click
    await waitFor(() => {
      // Back to just the trigger button
      expect(screen.getAllByText('Planning Agent')).toHaveLength(1);
    });
  });
});
