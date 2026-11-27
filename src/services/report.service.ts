import { OperationalReport, reportRepository } from '../repositories/report.repository.js';

export class ReportFilterError extends Error {
  readonly status = 400;
  constructor(message: string) { super(message); this.name = 'ReportFilterError'; }
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export class ReportService {
  validatePeriod(from: string, to: string): { from: string; to: string } {
    if (!isCalendarDate(from) || !isCalendarDate(to)) {
      throw new ReportFilterError('Tanggal laporan harus menggunakan format YYYY-MM-DD yang valid.');
    }
    const start = Date.parse(`${from}T00:00:00.000Z`);
    const end = Date.parse(`${to}T00:00:00.000Z`);
    if (start > end) throw new ReportFilterError('Tanggal mulai tidak boleh melewati tanggal akhir.');
    if ((end - start) / 86_400_000 > 89) throw new ReportFilterError('Rentang laporan maksimal 90 hari.');
    return { from, to };
  }

  async getOperationalReport(from: string, to: string): Promise<OperationalReport> {
    const period = this.validatePeriod(from, to);
    return reportRepository.getOperationalReport(period.from, period.to);
  }
}

export const reportService = new ReportService();

