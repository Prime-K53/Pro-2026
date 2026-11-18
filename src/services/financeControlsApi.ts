import { requestJson } from './http';

export interface ApprovalPolicy {
  id: number;
  action_type: string;
  threshold_amount: string;
  is_enabled: boolean;
  require_note: boolean;
}

export interface ApprovalRequest {
  id: number;
  action_type: string;
  entity_type: string;
  entity_id: number | null;
  business_date: string;
  amount: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  requested_by: number;
  requested_by_name: string | null;
  requested_at: string;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
  consumed_at: string | null;
}

export interface PeriodChecklistTask {
  id: number;
  task_key: string;
  label: string;
  category: string;
  is_required: boolean;
  is_manual: boolean;
  status: 'pending' | 'complete' | 'waived';
  evidence_json: Record<string, unknown>;
  notes: string | null;
  completed_at: string | null;
}

export interface PeriodChecklist {
  period: {
    id: number;
    period_name: string;
    start_date: string;
    end_date: string;
    status: string;
  };
  tasks: PeriodChecklistTask[];
  allRequiredComplete: boolean;
  canClose: boolean;
  enforced: boolean;
}

export interface ReportSchedule {
  id: number;
  name: string;
  report_key: string;
  frequency: string;
  day_of_week: number | null;
  day_of_month: number | null;
  time_of_day: string;
  recipients: string[];
  is_active: boolean;
  last_run_at: string | null;
  next_run_at: string;
}

export interface DashboardAlerts {
  generatedAt: string;
  counts: Record<string, number>;
  alerts: Array<{
    key: string;
    severity: 'critical' | 'warning' | 'info';
    title: string;
    count?: number;
    amount?: string;
    detail?: string;
    items?: Array<Record<string, unknown>>;
  }>;
}

export const financeControlsApi = {
  async listPolicies(): Promise<ApprovalPolicy[]> {
    const data = await requestJson<{ policies: ApprovalPolicy[] }>('/api/approvals/policies');
    return data.policies;
  },
  async updatePolicy(payload: {
    actionType: string;
    thresholdAmount: string;
    isEnabled: boolean;
  }): Promise<ApprovalPolicy> {
    const data = await requestJson<{ policy: ApprovalPolicy }>('/api/approvals/policies', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    return data.policy;
  },
  async listApprovals(status = 'pending'): Promise<ApprovalRequest[]> {
    const data = await requestJson<{ requests: ApprovalRequest[] }>(
      `/api/approvals?status=${encodeURIComponent(status)}`
    );
    return data.requests;
  },
  async approve(id: number, note?: string): Promise<ApprovalRequest> {
    const data = await requestJson<{ request: ApprovalRequest }>(`/api/approvals/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    });
    return data.request;
  },
  async reject(id: number, note: string): Promise<ApprovalRequest> {
    const data = await requestJson<{ request: ApprovalRequest }>(`/api/approvals/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    });
    return data.request;
  },
  async listPeriods(): Promise<
    Array<{ id: number; period_name: string; start_date: string; end_date: string; status: string }>
  > {
    const data = await requestJson<{ periods: any[] }>('/api/periods');
    return data.periods;
  },
  async getChecklist(periodId: number): Promise<PeriodChecklist> {
    return requestJson<PeriodChecklist>(`/api/periods/${periodId}/checklist`);
  },
  async completeTask(
    periodId: number,
    taskKey: string,
    notes: string,
    status: 'complete' | 'waived' = 'complete'
  ): Promise<PeriodChecklistTask> {
    const data = await requestJson<{ task: PeriodChecklistTask }>(
      `/api/periods/${periodId}/checklist/${encodeURIComponent(taskKey)}/complete`,
      {
        method: 'POST',
        body: JSON.stringify({ notes, status }),
      }
    );
    return data.task;
  },
  async setChecklistPolicy(enabled: boolean): Promise<{ enabled: boolean }> {
    const data = await requestJson<{ policy: { enabled: boolean } }>('/api/periods/checklist-policy', {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    });
    return data.policy;
  },
  async dashboardAlerts(): Promise<DashboardAlerts> {
    return requestJson<DashboardAlerts>('/api/dashboard/alerts');
  },
  async listSchedules(): Promise<{ schedules: ReportSchedule[]; availableReports: Array<{ key: string; label: string }> }> {
    return requestJson('/api/report-schedules');
  },
  async createSchedule(payload: {
    name: string;
    reportKey: string;
    frequency: string;
    dayOfMonth?: number;
    recipients: string[];
  }): Promise<ReportSchedule> {
    const data = await requestJson<{ schedule: ReportSchedule }>('/api/report-schedules', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return data.schedule;
  },
  async runSchedule(id: number): Promise<{ run: { status: string; recipientsCount: number } }> {
    return requestJson(`/api/report-schedules/${id}/run`, { method: 'POST', body: '{}' });
  },
  async updateSchedule(
    id: number,
    payload: {
      name?: string;
      reportKey?: string;
      frequency?: 'daily' | 'weekly' | 'monthly' | 'quarterly';
      timeOfDay?: string;
      dayOfWeek?: number | null;
      dayOfMonth?: number | null;
      recipients?: string[];
      isActive?: boolean;
    }
  ): Promise<ReportSchedule> {
    const data = await requestJson<{ schedule: ReportSchedule }>(`/api/report-schedules/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    return data.schedule;
  },
  async deleteSchedule(id: number): Promise<{ deleted: boolean; id: number }> {
    return requestJson(`/api/report-schedules/${id}`, { method: 'DELETE' });
  },
  async cancelApproval(id: number): Promise<ApprovalRequest> {
    const data = await requestJson<{ request: ApprovalRequest }>(`/api/approvals/${id}/cancel`, {
      method: 'POST',
      body: '{}',
    });
    return data.request;
  },
  async runDueSchedules(): Promise<{ results: Array<{ scheduleId: number; status: string }> }> {
    return requestJson('/api/report-schedules/run-due', { method: 'POST', body: '{}' });
  },
  async getReport(key: string): Promise<any> {
    const map: Record<string, string> = {
      jobProfitability: '/api/reports/printing-job-profitability',
      wipAging: '/api/reports/wip-aging',
      spoilage: '/api/reports/printing-spoilage',
      estimateVsActual: '/api/reports/estimate-vs-actual',
      inventoryValuation: '/api/reports/inventory-valuation',
      cogsReconciliation: '/api/reports/cogs-reconciliation',
    };
    const url = map[key];
    if (!url) throw new Error(`Unknown report ${key}`);
    const data = await requestJson<{ report: any }>(url);
    return data.report;
  },
};