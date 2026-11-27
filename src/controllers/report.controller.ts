import { NextFunction, Request, Response } from 'express';
import { ReportFilterError, reportService } from '../services/report.service.js';

function jakartaDate(offsetDays = 0): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(Date.now() + offsetDays * 86_400_000));
  const part = (type: string) => parts.find((item) => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function queryDate(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

export class ReportController {
  async index(req: Request, res: Response, next: NextFunction) {
    const to = queryDate(req.query.to, jakartaDate());
    const from = queryDate(req.query.from, jakartaDate(-29));
    try {
      const report = await reportService.getOperationalReport(from, to);
      return res.render('admin/reports', { title: 'Laporan Operasional', report, from, to, error: null });
    } catch (error) {
      if (error instanceof ReportFilterError) {
        return res.status(400).render('admin/reports', { title: 'Laporan Operasional', report: null, from, to, error: error.message });
      }
      return next(error);
    }
  }

  async print(req: Request, res: Response, next: NextFunction) {
    const to = queryDate(req.query.to, jakartaDate());
    const from = queryDate(req.query.from, jakartaDate(-29));
    try {
      const report = await reportService.getOperationalReport(from, to);
      return res.render('admin/reports-print', { title: 'Cetak Laporan Operasional', report, from, to, layout: false });
    } catch (error) {
      return next(error);
    }
  }
}

export const reportController = new ReportController();

