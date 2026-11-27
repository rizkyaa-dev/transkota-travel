import { NextFunction, Request, Response } from 'express';
import { promoService } from '../services/promo.service.js';

export class PromoController {
  async index(_req: Request, res: Response, next: NextFunction) {
    try {
      const promos = await promoService.list();
      res.render('admin/promos', { title: 'Manajemen Kode Promo', promos });
    } catch (error) { next(error); }
  }

  async create(req: Request, res: Response) {
    try {
      await promoService.create(req.body, req.session.user!.id);
      req.flash('success', 'Kode promo berhasil dibuat.');
    } catch (error: any) {
      req.flash('error', error?.code === 'ER_DUP_ENTRY' ? 'Kode promo sudah digunakan.' : (error?.message || 'Gagal membuat promo.'));
    }
    res.redirect('/admin/promos');
  }

  async toggle(req: Request, res: Response) {
    try {
      const active = req.body.aktif === '1';
      await promoService.setActive(Number(req.params.id), active);
      req.flash('success', active ? 'Kode promo diaktifkan.' : 'Kode promo dinonaktifkan.');
    } catch (error: any) {
      req.flash('error', error?.message || 'Gagal memperbarui promo.');
    }
    res.redirect('/admin/promos');
  }
}

export const promoController = new PromoController();
